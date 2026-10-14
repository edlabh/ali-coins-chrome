/**
 * Controle da janela mobile (popup) e das regras de rede (declarativeNetRequest).
 *
 * Emulação Pixel 8 no Chrome desktop:
 *  - janela popup dimensionada para o viewport CSS do aparelho (412x915);
 *  - User-Agent e Client Hints mobile reescritos por DNR para TODAS as
 *    requisições do AliExpress naquela aba (session rules escopadas por tabId);
 *  - locale pt-BR herdado do perfil do usuário.
 */

import { COIN_URL, COIN_URL_TASKS, MYCOIN_URL, pickDevice } from '../common/constants.js';

const DNR_UA_RULE_ID = 9001;
const DNR_HINTS_RULE_ID = 9002;
const LEDGER_TAB_KEY = 'ledgerTabRef';

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
 * Garante que temos uma janela/aba de execução válida.
 *  - modo normal: janela popup visível dimensionada como o aparelho;
 *  - modo silencioso (`silentMode`): ABA DE FUNDO na última janela em uso,
 *    sem abrir nada — a emulação de viewport é aplicada por CDP (cdp.js).
 * Reutiliza a aba existente quando ela ainda aponta para o AliExpress (ou está
 * em branco, aguardando a primeira navegação).
 * @param {object} settings
 * @param {{forceVisible?: boolean}} [options]
 * @returns {Promise<{windowId: number, tabId: number, reused: boolean}>}
 */
async function ensureRunWindow(settings, { forceVisible = false } = {}) {
  const silent = Boolean(settings.silentMode) && !forceVisible;
  const runtimeRef = await getRuntimeTab();

  if (runtimeRef) {
    try {
      const tab = await chrome.tabs.get(runtimeRef.tabId);
      const url = (tab && tab.url) || '';
      if (tab && tab.windowId && (isAliexpressUrl(url) || isBlankUrl(url))) {
        if (!silent) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        return { windowId: tab.windowId, tabId: tab.id, reused: true };
      }
    } catch {
      // Aba sumiu: recria abaixo.
    }
  }

  if (silent) {
    const windowId = await findAnchorWindow();
    const tab = await chrome.tabs.create({ windowId, url: 'about:blank', active: false });
    await setRuntimeTab({ windowId, tabId: tab.id });
    return { windowId, tabId: tab.id, reused: false };
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
  await setRuntimeTab({ windowId: win.id, tabId: tab.id });
  return { windowId: win.id, tabId: tab.id, reused: false };
}

/**
 * Janela-âncora para o modo silencioso: a última janela em foco; se não houver,
 * a primeira normal; em último caso, cria uma janela minimizada (invisível).
 * @returns {Promise<number>}
 */
async function findAnchorWindow() {
  try {
    const win = await chrome.windows.getLastFocused({ populate: false });
    if (win && typeof win.id === 'number') return win.id;
  } catch {
    // segue
  }
  try {
    const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (wins.length > 0 && typeof wins[0].id === 'number') return wins[0].id;
  } catch {
    // segue
  }
  const created = await chrome.windows.create({ url: 'about:blank', state: 'minimized' });
  return created.id;
}

/**
 * Prepara a aba de execução na ordem correta:
 *   1. garante a janela popup (Pixel 8) ou a aba de fundo (modo silencioso);
 *   2. aplica as regras de User-Agent/Client Hints mobile na aba;
 *   3. navega (ou recarrega) SEMPRE para a central de moedas com o hash
 *      `#ac_run=1`, que o content script usa para marcar a aba e é removido logo
 *      depois. Recarregar mesmo em abas já abertas garante que uma página antiga
 *      carregada em desktop seja substituída pela variante mobile.
 * @param {object} settings
 * @param {{forceVisible?: boolean}} [options]
 * @returns {Promise<{windowId: number, tabId: number, reused: boolean}>}
 */
export async function prepareRunTab(settings, options = {}) {
  const win = await ensureRunWindow(settings, options);
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
 * Remove as regras de rede da aba de execução.
 */
export async function clearDeviceRules() {
  await chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: [DNR_UA_RULE_ID, DNR_HINTS_RULE_ID] })
    .catch(() => {});
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
export async function navigateTab(tabId, url, timeoutMs = 45000) {
  await chrome.tabs.update(tabId, { url });
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

  const tab = await chrome.tabs.create({ windowId, url: MYCOIN_URL, active: false });
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
    await chrome.windows.update(windowId, { focused: true, drawAttention: true, state: 'normal' });
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

function isCoinUrl(url) {
  return /coin-index/.test(url || '');
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
 * @param {object} ctx ({ tabId, settings })
 * @param {boolean} [force] força navegação mesmo se já parecer na URL
 */
export async function ensureCoinPage(ctx, force = false) {
  const url = await getTabUrl(ctx.tabId);
  if (!isCoinUrl(url) || force) {
    await navigateTab(ctx.tabId, COIN_URL_TASKS);
    await applyDeviceRules(ctx.tabId, ctx.settings);
  }
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
