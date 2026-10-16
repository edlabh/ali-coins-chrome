/**
 * Controle da janela mobile (popup) e das regras de rede (declarativeNetRequest).
 *
 * Emulação Pixel 8 no Chrome desktop:
 *  - janela popup dimensionada para o viewport CSS do aparelho (412x915);
 *  - User-Agent e Client Hints mobile reescritos por DNR para TODAS as
 *    requisições do AliExpress naquela aba (session rules escopadas por tabId);
 *  - locale pt-BR herdado do perfil do usuário.
 */

import { COIN_URL, COIN_URL_TASKS, PHASE, pickDevice } from '../common/constants.js';

const DNR_UA_RULE_ID = 9001;
const DNR_HINTS_RULE_ID = 9002;
// Regra compartilhada das ABAS AUXILIARES do run (fichas de item, páginas que o
// site abre): a referência (Playwright) tem o contexto INTEIRO emulando um
// Pixel 7 — toda página nasce mobile, desde o primeiro byte. Sem isso a 1ª
// carga sai com UA desktop (e um reload posterior é uma 2ª visita sem referrer).
const DNR_AUX_TAB_RULE_ID = 9003;
const LEDGER_TAB_KEY = 'ledgerTabRef';

// Abas auxiliares registradas (mantidas em memória para reconstruir a regra).
const auxTabIds = new Set();
let lastAuxDevice = null;

// IMPORTANTE: sem `resourceTypes` explícito o Chrome NÃO casa requisições de
// navegação (main_frame) — era a causa raiz do primeiro load em layout desktop.
const DNR_RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'other'
];

// Domínios do AliExpress + domínios do controle de risco/captcha (baxia, punish,
// CDNs) para que o desafio também renderize na variante mobile.
const DNR_REQUEST_DOMAINS = [
  'aliexpress.com',
  'aliexpress.us',
  'alibaba.com',
  'aliyun.com',
  'alicdn.com'
];

function dnrCondition(tabIds) {
  const list = Array.isArray(tabIds) ? tabIds.filter((id) => typeof id === 'number') : [tabIds];
  return {
    requestDomains: DNR_REQUEST_DOMAINS,
    resourceTypes: DNR_RESOURCE_TYPES,
    tabIds: [...new Set(list)]
  };
}

/**
 * Captura a aba ativa da última janela normal em foco — a "aba do usuário"
 * que recebe o foco de volta se algo do run precisar disputá-lo. Feita ANTES
 * de qualquer janela de execução ser criada.
 * @returns {Promise<number|null>}
 */
async function captureUserTabId() {
  try {
    const win = await chrome.windows.getLastFocused({ populate: false, windowTypes: ['normal'] });
    if (win && typeof win.id === 'number') {
      const tabs = await chrome.tabs.query({ active: true, windowId: win.id });
      const active = tabs.find((t) => t && t.id);
      return active ? active.id : null;
    }
  } catch {
    // segue sem dica de aba do usuário
  }
  return null;
}

/**
 * Garante a janela/aba de execução.
 *  - modo silencioso (`silentMode`, padrão): **JANELA DEDICADA** própria
 *    (normal, criada SEM foco) — todas as abas do run (central, tarefas,
 *    fichas abertas pelo site) vivem nela e as janelas/abas do USUÁRIO não são
 *    tocadas; nada rouba o foco;
 *  - modo visível (`forceVisible`/"Abrir janela mobile" ou silentMode off):
 *    janela popup dimensionada como o aparelho.
 * Reutiliza a janela/aba quando ela ainda aponta para o AliExpress (ou está em
 * branco) e pertence à execução.
 * @param {object} settings
 * @param {{forceVisible?: boolean}} [options]
 * @returns {Promise<{windowId: number, tabId: number, reused: boolean, dedicated: boolean, userTabId: (number|null)}>}
 */
async function ensureRunWindow(settings, { forceVisible = false } = {}) {
  const silent = Boolean(settings.silentMode) && !forceVisible;
  const userTabIdHint = await captureUserTabId();
  const runtimeRef = await getRuntimeTab();

  if (runtimeRef) {
    try {
      const tab = await chrome.tabs.get(runtimeRef.tabId);
      const url = (tab && tab.url) || '';
      const refIsDedicated = Boolean(runtimeRef.dedicated);
      if (
        tab &&
        tab.windowId &&
        (isAliexpressUrl(url) || isBlankUrl(url)) &&
        // Modo silencioso só reutiliza a JANELA DEDICADA do run (nunca uma aba
        // do usuário ou popup antigo); demais modos reutilizam normalmente.
        (silent ? refIsDedicated : true)
      ) {
        if (silent && !tab.active) {
          // Janela dedicada: a aba de execução deve ficar ATIVA dentro dela
          // (visível — a janela é que não tem foco; isso mantém a página sem
          // estrangulamento e os beacons saudáveis). Ativar uma aba pode trazer
          // a janela dela para frente: devolve o foco se isso aconteceu.
          await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
          await restoreUserFocus({
            windowId: tab.windowId,
            tabId: tab.id,
            userTabId: runtimeRef.userTabId || userTabIdHint,
            dedicatedWindow: true,
            phase: PHASE.STARTING
          });
        }
        if (!silent) {
          await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        }
        return {
          windowId: tab.windowId,
          tabId: tab.id,
          reused: true,
          dedicated: refIsDedicated,
          userTabId: runtimeRef.userTabId || userTabIdHint
        };
      }
      // Ref legado do modo silencioso (aba do run numa janela do USUÁRIO):
      // fecha a aba antiga e recria na janela dedicada — não deixa lixo na
      // janela do usuário.
      if (tab && tab.id && silent && !refIsDedicated) {
        await chrome.tabs.remove(tab.id).catch(() => {});
        const oldWin = await chrome.windows.get(tab.windowId).catch(() => null);
        if (oldWin && oldWin.type === 'popup') {
          await chrome.windows.remove(oldWin.id).catch(() => {});
        }
      }
    } catch {
      // Aba sumiu: recria abaixo.
    }
  }

  if (silent) {
    // Janela DEDICADA: própria, normal, SEM foco. As abas abertas pelo site
    // (adclick/ficha/feed) nascem aqui dentro — as janelas do usuário ficam
    // intocadas e sem interferência de foco.
    const device = pickDevice(settings);
    const win = await chrome.windows.create({
      url: 'about:blank',
      type: 'normal',
      focused: false,
      width: Math.max(440, device.width + 40),
      height: Math.min(1000, device.height + 60),
      left: 40,
      top: 40
    });
    const tab = (win.tabs && win.tabs[0]) || null;
    if (!tab || typeof tab.id !== 'number') {
      throw new Error('Falha ao criar a janela de execução.');
    }
    await setRuntimeTab({
      windowId: win.id,
      tabId: tab.id,
      dedicated: true,
      userTabId: userTabIdHint
    });
    // Criar uma janela pode colocá-la à frente mesmo com `focused: false`:
    // se a janela dedicada ficou em foco, devolve imediatamente ao usuário.
    await restoreUserFocus({
      windowId: win.id,
      tabId: tab.id,
      userTabId: userTabIdHint,
      dedicatedWindow: true,
      phase: PHASE.STARTING
    });
    return {
      windowId: win.id,
      tabId: tab.id,
      reused: false,
      dedicated: true,
      userTabId: userTabIdHint
    };
  }

  const device = pickDevice(settings);
  // +16px de largura e +28px de altura: compensa bordas/decoração da janela popup.
  const win = await chrome.windows.create({
    url: 'about:blank',
    type: 'popup',
    width: device.width + 16,
    height: device.height + 28,
    focused: true
  });

  const tab = (win.tabs && win.tabs[0]) || null;
  if (!tab || typeof tab.id !== 'number') {
    throw new Error('Falha ao criar a janela de execução.');
  }
  await setRuntimeTab({
    windowId: win.id,
    tabId: tab.id,
    dedicated: false,
    userTabId: userTabIdHint
  });
  return {
    windowId: win.id,
    tabId: tab.id,
    reused: false,
    dedicated: false,
    userTabId: userTabIdHint
  };
}

/**
 * Prepara a aba de execução na ordem correta:
 *   1. garante a janela popup (Pixel 8) ou a aba de fundo (modo silencioso);
 *   2. executa `onTabCreated` (registra runState e anexa CDP ainda em about:blank);
 *   3. aplica as regras de User-Agent/Client Hints mobile na aba;
 *   4. navega (ou recarrega) SEMPRE para a central de moedas com o hash
 *      `#ac_run=1`, que o content script usa para marcar a aba e é removido logo
 *      depois.
 * @param {object} settings
 * @param {{forceVisible?: boolean, onTabCreated?: (win: {windowId: number, tabId: number, reused: boolean}) => Promise<void>}} [options]
 * @returns {Promise<{windowId: number, tabId: number, reused: boolean}>}
 */
export async function prepareRunTab(settings, options = {}) {
  const win = await ensureRunWindow(settings, options);
  if (typeof options.onTabCreated === 'function') {
    await options.onTabCreated(win);
  }
  await applyDeviceRules(win.tabId, settings);
  await navigateTab(win.tabId, `${COIN_URL}#ac_run=1`, 45000);
  return win;
}

/**
 * Aplica as regras de rede mobile escopadas a uma ou mais abas (session rules).
 * O User-Agent é obrigatório (erro descritivo se falhar); os Client Hints são
 * best-effort, pois a lista de headers modificáveis varia entre versões do Chrome
 * — uma regra inválida NÃO pode derrubar o User-Agent junto.
 * @param {number} tabId
 * @param {object} settings
 * @param {number[]} [extraTabIds] abas adicionais (ex.: aba adotada de tarefa)
 */
export async function applyDeviceRules(tabId, settings, extraTabIds = []) {
  const device = pickDevice(settings);
  const targetTabs = [tabId, ...extraTabIds];

  await chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: [DNR_UA_RULE_ID, DNR_HINTS_RULE_ID] })
    .catch(() => {});

  const uaRule = {
    id: DNR_UA_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'user-agent', operation: 'set', value: device.userAgent }]
    },
    condition: dnrCondition(targetTabs)
  };

  try {
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: [uaRule] });
  } catch (err) {
    throw new Error(`Falha ao aplicar a regra de User-Agent mobile (Pixel): ${err.message}`, {
      cause: err
    });
  }

  const hintsRule = {
    id: DNR_HINTS_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'sec-ch-ua-mobile', operation: 'set', value: '?1' },
        { header: 'sec-ch-ua-platform', operation: 'set', value: '"Android"' }
      ]
    },
    condition: dnrCondition(targetTabs)
  };

  await chrome.declarativeNetRequest
    .updateSessionRules({ addRules: [hintsRule] })
    .catch(() => {
      // Sem suporte a modificar Client Hints nesta versão do Chrome: o UA e o
      // spoof de navigator (MAIN world) já garantem a variante mobile.
    });
}

/**
 * Remove as regras de rede da aba de execução (inclui a regra das abas
 * auxiliares e limpa o conjunto em memória).
 */
export async function clearDeviceRules() {
  auxTabIds.clear();
  lastAuxDevice = null;
  await chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: [DNR_UA_RULE_ID, DNR_HINTS_RULE_ID, DNR_AUX_TAB_RULE_ID] })
    .catch(() => {});
}

/**
 * Reconstroi a regra DNR das abas auxiliares com o conjunto atual.
 */
async function rebuildAuxTabRule() {
  await chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: [DNR_AUX_TAB_RULE_ID] })
    .catch(() => {});
  if (auxTabIds.size === 0) return;
  const device = lastAuxDevice || pickDevice({});
  const rule = {
    id: DNR_AUX_TAB_RULE_ID,
    priority: 2,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'user-agent', operation: 'set', value: device.userAgent },
        { header: 'sec-ch-ua-mobile', operation: 'set', value: '?1' },
        { header: 'sec-ch-ua-platform', operation: 'set', value: '"Android"' }
      ]
    },
    condition: dnrCondition([...auxTabIds])
  };
  await chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule] }).catch(() => {
    // Sem suporte a modificar client hints: o UA sozinho já garante a variante.
  });
}

/**
 * Registra uma aba AUXILIAR do run (ficha de item, página aberta pelo site) e
 * aplica/atualiza as regras mobile nela — chamada na CRIAÇÃO da aba, antes do
 * primeiro load terminar, como o contexto único mobile da referência (P1).
 * Idempotente; faz prune de abas já fechadas.
 * @param {number} tabId
 * @param {object} settings
 */
export async function registerAuxTab(tabId, settings) {
  if (typeof tabId !== 'number') return;
  auxTabIds.add(tabId);
  if (settings) lastAuxDevice = pickDevice(settings);
  // prune de ids mortos (best-effort) para a regra não crescer para sempre.
  for (const id of [...auxTabIds]) {
    if (id === tabId) continue;
    const t = await chrome.tabs.get(id).catch(() => null);
    if (!t) auxTabIds.delete(id);
  }
  await rebuildAuxTabRule();
}

/**
 * Remove uma aba auxiliar do conjunto (chamada quando a aba é fechada).
 * @param {number} tabId
 */
export async function unregisterAuxTab(tabId) {
  if (!auxTabIds.delete(tabId)) return;
  await rebuildAuxTabRule();
}

function isBlankUrl(url) {
  return !url || url === 'about:blank' || url.startsWith('chrome://newtab');
}

/**
 * Navega a aba para uma URL e aguarda o carregamento completo + settle.
 * @param {number} tabId
 * @param {string} url
 * @param {number} [timeoutMs=45000]
 */
/**
 * Aguarda a navegação NOVA realmente começar (corrida do "complete" antigo:
 * logo após `tabs.update`, a aba ainda pode reportar a página ANTERIOR como
 * 'complete'; sem esta espera, `waitTabComplete` retornava na hora e os
 * comandos seguintes rodavam na página antiga — ex.: central "confirmada" com
 * a aba ainda no feed recommends.html).
 * @param {number} tabId
 * @param {string} before URL atual antes do update
 * @param {number} timeoutMs
 */
async function waitForNavigationStart(tabId, before, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const now = tab.url || '';
      const pending = tab.pendingUrl || '';
      if ((pending && pending !== before) || (now && now !== before) || tab.status === 'loading') {
        return true;
      }
    } catch {
      return false; // aba fechada: waitTabComplete resolve abaixo
    }
    await sleep(100);
  }
  return false;
}

/**
 * Navega a aba e aguarda a conclusão de verdade (início da nova navegação +
 * status 'complete'), com folga de estabilização.
 * @param {number} tabId
 * @param {string} url
 * @param {number} [timeoutMs=45000]
 */
export async function navigateTab(tabId, url, timeoutMs = 45000) {
  const before = await getTabUrl(tabId);
  await chrome.tabs.update(tabId, { url });
  await waitForNavigationStart(tabId, before, Math.min(timeoutMs, 4000));
  await waitTabComplete(tabId, timeoutMs);
  await sleep(1200);
}

/**
 * Aguarda status 'complete' na aba (com fallback de tolerância).
 * @param {number} tabId
 * @param {number} [timeoutMs=45000]
 */
export async function waitTabComplete(tabId, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return true;
    } catch {
      return false;
    }
    await sleep(400);
  }
  return false;
}

/**
 * Fecha abas órfãs (popups/novas abas abertas por cliques de tarefas),
 * espelhando closeOrphanPages do ali-coins.
 * @param {number} windowId
 * @param {number} keepTabId
 * @param {number[]} [extraKeep] abas adicionais a preservar (ex.: extrato)
 * @param {Set<number>|null} [known] snapshot das abas existentes no início do run —
 *   quando informado, SOMENTE abas criadas durante o run são fechadas; as abas
 *   pessoais do usuário nunca são tocadas (essencial no modo silencioso, em que
 *   a execução compartilha uma janela normal).
 */
export async function closeOrphanTabs(windowId, keepTabId, extraKeep = [], known = null) {
  const keep = new Set([keepTabId, ...extraKeep.filter(Boolean)]);
  try {
    const tabs = await chrome.tabs.query({ windowId });
    for (const tab of tabs) {
      if (!tab.id || keep.has(tab.id)) continue;
      if (known && known.has(tab.id)) continue;
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
  } catch {
    // Janela pode ter sido fechada pelo usuário: ignora.
  }
}

/**
 * Fecha abas abertas pelo PRÓPRIO SITE durante a rodada (feed/ficha/popup) em
 * **qualquer janela**, exceto a aba principal, a do extrato e a aba adotada da
 * tarefa. A detecção é pelo OPENER: apenas abas cujo `openerTabId` é uma das
 * abas do run são candidatas — abas do usuário nunca têm esse opener.
 *
 * Essencial ANTES de voltar à central: um feed ainda VIVO pode redirecionar a
 * aba de origem (opener) de volta para `recommends.html` depois da volta —
 * era uma das causas do painel "Ganhe mais moedas" inacessível alguns segundos
 * após a tarefa "Explore sponsored items".
 * @param {object} runState ({ tabId, ledgerTabId })
 * @param {{keep?: number[], openerIds?: number[]}} [options]
 * @returns {Promise<number>} quantas abas foram fechadas
 */
export async function closeRunOwnedTabs(runState, { keep = [], openerIds = [] } = {}) {
  const keepSet = new Set([
    ...keep.filter((id) => typeof id === 'number'),
    ...(runState && typeof runState.tabId === 'number' ? [runState.tabId] : []),
    ...(runState && typeof runState.ledgerTabId === 'number' ? [runState.ledgerTabId] : [])
  ]);
  const openers = new Set([
    ...(runState && typeof runState.tabId === 'number' ? [runState.tabId] : []),
    ...openerIds.filter((id) => typeof id === 'number')
  ]);
  if (openers.size === 0) return 0;
  let closed = 0;
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab || typeof tab.id !== 'number' || keepSet.has(tab.id)) continue;
      if (typeof tab.openerTabId !== 'number' || !openers.has(tab.openerTabId)) continue;
      await chrome.tabs.remove(tab.id).catch(() => {});
      closed += 1;
    }
  } catch {
    // Janela/aba fechada no meio: ignora.
  }
  return closed;
}

/**
 * Garante uma aba dedicada ao extrato desktop dentro da janela de execução.
 * A aba NÃO recebe as regras de User-Agent mobile (que são escopadas à aba
 * principal), então a página mycoin renderiza na variante desktop — como o
 * contexto desktop do ali-coins. Criada em segundo plano (active: false).
 * @param {number} windowId
 * @returns {Promise<number>} tabId
 */
export async function ensureLedgerTab(windowId) {
  const data = await chrome.storage.session.get(LEDGER_TAB_KEY);
  const ref = data[LEDGER_TAB_KEY] || null;
  if (ref && ref.tabId) {
    try {
      const tab = await chrome.tabs.get(ref.tabId);
      if (tab && tab.windowId === windowId) return tab.id;
    } catch {
      // Aba sumiu: recria abaixo.
    }
  }

  const tab = await chrome.tabs.create({ windowId, url: 'about:blank', active: false });
  await chrome.storage.session.set({ [LEDGER_TAB_KEY]: { tabId: tab.id, windowId } });
  return tab.id;
}

/**
 * Fecha a aba do extrato (se existir) e limpa a referência.
 */
export async function closeLedgerTab() {
  try {
    const data = await chrome.storage.session.get(LEDGER_TAB_KEY);
    const ref = data[LEDGER_TAB_KEY];
    if (ref && ref.tabId) {
      await chrome.tabs.remove(ref.tabId).catch(() => {});
    }
  } finally {
    await chrome.storage.session.remove(LEDGER_TAB_KEY).catch(() => {});
  }
}

/**
 * Traz a janela de execução para frente e, quando informado, ativa a aba do run
 * (necessário no modo silencioso: a aba de fundo precisa ficar visível para o
 * usuário resolver captcha/2FA).
 * @param {number} windowId
 * @param {number} [tabId]
 */
export async function focusWindow(windowId, tabId = null) {
  try {
    const win = await chrome.windows.get(windowId).catch(() => null);
    const update = { focused: true, drawAttention: true };
    // Restaura apenas janela MINIMIZADA (ex.: popup de execução reaproveitado);
    // NUNCA desmaximiza a janela do usuário — o modo silencioso compartilha uma
    // janela normal dele.
    if (win && win.state === 'minimized') update.state = 'normal';
    await chrome.windows.update(windowId, update);
  } catch {
    // Ignora janela fechada.
  }
  if (tabId) {
    try {
      await chrome.tabs.update(tabId, { active: true });
    } catch {
      // Ignora aba fechada.
    }
  }
}

/**
 * Devolve a aba de execução ao segundo plano após o usuário resolver um
 * captcha/2FA no modo silencioso, reativando a aba original do usuário.
 * @param {number} windowId
 * @param {number} runTabId
 * @param {number|null} [userTabId]
 */
export async function restoreBackgroundFocus(windowId, runTabId, userTabId = null) {
  try {
    let targetId = userTabId;
    if (!targetId && windowId) {
      // 1) uma aba que não seja do AliExpress na MESMA janela do run;
      // 2) fallback: qualquer aba fora do AliExpress no navegador (modo de
      //    JANELA DEDICADA — a janela do run só tem abas do run).
      const tabs = await chrome.tabs.query({ windowId }).catch(() => []);
      let other = tabs.find((t) => t.id && t.id !== runTabId && !isAliexpressUrl(t.url || ''));
      if (!other) {
        const all = await chrome.tabs.query({}).catch(() => []);
        other = all.find((t) => t.id && t.id !== runTabId && !isAliexpressUrl(t.url || ''));
      }
      if (other) targetId = other.id;
    }
    if (targetId && targetId !== runTabId) {
      await chrome.tabs.update(targetId, { active: true }).catch(() => {});
    }
    if (runTabId) {
      await chrome.tabs.update(runTabId, { active: false }).catch(() => {});
    }
  } catch {
    // Ignora aba/janela fechada.
  }
}

/**
 * Garante que a JANELA DEDICADA do run NUNCA permaneça em primeiro plano.
 *
 * Algumas operações nativas do Chrome (criar janelas, anexar o depurador via
 * `chrome.debugger.attach`, abrir/ativar abas — inclusive as abertas pelo
 * próprio site no fluxo de popup) podem trazer a janela da aba afetada para
 * frente mesmo quando ela foi criada sem foco. Esta função confere se a janela
 * verificada (`focusedWindowId`, padrão: a janela do run) é a última em foco e,
 * se for, reativa a aba do usuário capturada antes do run — devolvendo o foco
 * imediatamente.
 *
 * Fases que exigem o usuário (captcha, 2FA e login manual) NÃO são revertidas:
 * nelas trazer a janela para frente é intencional (focusWindow).
 *
 * Atua SOMENTE na janela dedicada (`dedicatedWindow === true`): nos modos
 * visível/popup a janela DEVE ficar em foco.
 * @param {{windowId?: number, tabId?: number, userTabId?: (number|null), dedicatedWindow?: boolean, phase?: string}} state
 * @param {{focusedWindowId?: number}} [options]
 * @returns {Promise<boolean>} true quando o foco foi devolvido ao usuário
 */
export async function restoreUserFocus(state, { focusedWindowId } = {}) {
  try {
    if (!state || state.dedicatedWindow !== true) return false;
    if (typeof state.windowId !== 'number') return false;
    if (
      state.phase === PHASE.CAPTCHA ||
      state.phase === PHASE.TWO_FA ||
      state.phase === PHASE.AUTH
    ) {
      return false;
    }
    const checkId = typeof focusedWindowId === 'number' ? focusedWindowId : state.windowId;
    const last = await chrome.windows.getLastFocused({ populate: false }).catch(() => null);
    if (!last || last.id !== checkId) return false;
    const targetId = typeof state.userTabId === 'number' ? state.userTabId : null;
    if (targetId && targetId !== state.tabId) {
      const targetTab = await chrome.tabs.get(targetId).catch(() => null);
      if (targetTab) {
        await chrome.tabs.update(targetId, { active: true }).catch(() => {});
        if (typeof targetTab.windowId === 'number') {
          // Reativa também a JANELA do usuário: se a aba já estava ativa, só
          // `tabs.update` pode não devolver o foco à janela.
          await chrome.windows.update(targetTab.windowId, { focused: true }).catch(() => {});
        }
        return true;
      }
    }
    // Sem a aba do usuário (fechada durante o run): foca outra janela normal —
    // nunca a janela do run nem a janela que acabou de roubar o foco.
    const wins = await chrome.windows
      .getAll({ populate: false, windowTypes: ['normal'] })
      .catch(() => []);
    const other = wins.find(
      (w) => w && typeof w.id === 'number' && w.id !== state.windowId && w.id !== checkId
    );
    if (other) {
      await chrome.windows.update(other.id, { focused: true }).catch(() => {});
      return true;
    }
  } catch {
    // Melhor esforço: foco nunca derruba a execução.
  }
  return false;
}

const RUNTIME_TAB_KEY = 'runTabRef';

async function getRuntimeTab() {
  const data = await chrome.storage.session.get(RUNTIME_TAB_KEY);
  return data[RUNTIME_TAB_KEY] || null;
}

async function setRuntimeTab(ref) {
  await chrome.storage.session.set({ [RUNTIME_TAB_KEY]: ref });
}

export function isAliexpressUrl(url) {
  return /https:\/\/([a-z0-9-]+\.)*aliexpress\.(com|us)\//i.test(url || '');
}

/**
 * true SOMENTE para a página da central de moedas (`/p/coin-index/index.html`).
 * Subpáginas de coin-index NÃO são a central: a tarefa "Descubra itens
 * patrocinados" navega a aba para `coin-index/recommends.html?from=mission…`
 * (feed patrocinado), que não tem o botão/gaveta "Ganhe mais moedas". Com o
 * teste antigo (`/coin-index/`), `ensureCoinPage` considerava a aba "já na
 * central", não voltava, e o próximo OPEN_DRAWER falhava com "Painel Ganhe mais
 * moedas inacessível" (cards: 0, drawerNode: false) — abandonando as tarefas
 * restantes do run.
 * @param {string} url
 */
export function isCoinUrl(url) {
  return /\/p\/coin-index\/(index\.html)?([?#]|$)/i.test(url || '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * URL atual de uma aba ('' quando indisponível).
 * @param {number} tabId
 * @returns {Promise<string>}
 */
export async function getTabUrl(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.url || '';
  } catch {
    return '';
  }
}

/**
 * Garante que a aba principal está na central de moedas.
 *
 * Navega (quando preciso/forçado) e **CONFIRMA a URL final**: o site pode
 * re-redirecionar a aba de volta para subpáginas do coin-index — ex.:
 * `recommends.html` do feed patrocinado — logo após o load. Sem a confirmação,
 * o run acreditava estar na central e a abertura do painel falhava lá
 * (cards: 0, drawerNode: false).
 * @param {object} ctx ({ tabId, settings })
 * @param {boolean} [force] força navegação mesmo se já parecer na URL
 * @returns {Promise<boolean>} true quando a aba terminou NA central
 */
export async function ensureCoinPage(ctx, force = false) {
  if (!force && isCoinUrl(await getTabUrl(ctx.tabId))) return true;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await applyDeviceRules(ctx.tabId, ctx.settings);
    await navigateTab(ctx.tabId, `${COIN_URL_TASKS}#ac_run=1`);
    if (isCoinUrl(await getTabUrl(ctx.tabId))) return true;
    await sleep(700);
    if (isCoinUrl(await getTabUrl(ctx.tabId))) return true;
    if (attempt < 2) await sleep(700);
  }
  return false;
}

/**
 * Aguarda uma possível navegação completa após clicar em "GO/IR".
 * @param {object} ctx
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} true se a URL mudou
 */
export async function waitPossibleNavigation(ctx, timeoutMs) {
  const before = await getTabUrl(ctx.tabId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(400);
    const now = await getTabUrl(ctx.tabId);
    if (now && now !== before) {
      await waitTabComplete(ctx.tabId, 30000);
      await sleep(1000);
      return true;
    }
  }
  return false;
}
