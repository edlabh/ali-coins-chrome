/**
 * Controle da janela mobile (popup) e das regras de rede (declarativeNetRequest).
 *
 * Emulação Pixel 8 no Chrome desktop:
 *  - janela popup dimensionada para o viewport CSS do aparelho (412x915);
 *  - User-Agent e Client Hints mobile reescritos por DNR para TODAS as
 *    requisições do AliExpress naquela aba (session rules escopadas por tabId);
 *  - locale pt-BR herdado do perfil do usuário.
 */

import { COIN_URL, pickDevice } from '../common/constants.js';

const DNR_UA_RULE_ID = 9001;
const DNR_HINTS_RULE_ID = 9002;

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

function dnrCondition(tabId) {
  return {
    requestDomains: DNR_REQUEST_DOMAINS,
    resourceTypes: DNR_RESOURCE_TYPES,
    tabIds: [tabId]
  };
}

/**
 * Garante que temos uma janela/aba de execução válida e focada.
 * Reutiliza a aba existente quando ela ainda aponta para o AliExpress (ou está
 * em branco, aguardando a primeira navegação). A janela é criada em about:blank
 * de propósito: assim é possível aplicar as regras de User-Agent ANTES de
 * qualquer requisição ao AliExpress (antes, o primeiro load saía como desktop).
 * @param {object} settings
 * @returns {Promise<{windowId: number, tabId: number, reused: boolean}>}
 */
export async function ensureRunWindow(settings) {
  const runtimeRef = await getRuntimeTab();

  if (runtimeRef) {
    try {
      const tab = await chrome.tabs.get(runtimeRef.tabId);
      const url = (tab && tab.url) || '';
      if (tab && tab.windowId && (isAliexpressUrl(url) || isBlankUrl(url))) {
        await chrome.windows.update(tab.windowId, { focused: true });
        return { windowId: tab.windowId, tabId: tab.id, reused: true };
      }
    } catch {
      // Aba sumiu: recria abaixo.
    }
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
 * Prepara a aba de execução na ordem correta:
 *   1. garante a janela popup (Pixel 8);
 *   2. aplica as regras de User-Agent/Client Hints mobile na aba;
 *   3. navega (ou recarrega) SEMPRE para a central de moedas com o hash
 *      `#ac_run=1`, que o content script usa para marcar a aba e é removido logo
 *      depois. Recarregar mesmo em abas já abertas garante que uma página antiga
 *      carregada em desktop seja substituída pela variante mobile.
 * @param {object} settings
 * @returns {Promise<{windowId: number, tabId: number, reused: boolean}>}
 */
export async function prepareRunTab(settings) {
  const win = await ensureRunWindow(settings);
  await applyDeviceRules(win.tabId, settings);
  await navigateTab(win.tabId, `${COIN_URL}#ac_run=1`, 45000);
  return win;
}

/**
 * Aplica as regras de rede mobile escopadas a uma aba (session rules).
 * O User-Agent é obrigatório (erro descritivo se falhar); os Client Hints são
 * best-effort, pois a lista de headers modificáveis varia entre versões do Chrome
 * — uma regra inválida NÃO pode derrubar o User-Agent junto.
 * @param {number} tabId
 * @param {object} settings
 */
export async function applyDeviceRules(tabId, settings) {
  const device = pickDevice(settings);

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
    condition: dnrCondition(tabId)
  };

  try {
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: [uaRule] });
  } catch (err) {
    throw new Error(`Falha ao aplicar a regra de User-Agent mobile (Pixel): ${err.message}`);
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
    condition: dnrCondition(tabId)
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
 */
export async function closeOrphanTabs(windowId, keepTabId) {
  try {
    const tabs = await chrome.tabs.query({ windowId });
    for (const tab of tabs) {
      if (tab.id && tab.id !== keepTabId) {
        await chrome.tabs.remove(tab.id).catch(() => {});
      }
    }
  } catch {
    // Janela pode ter sido fechada pelo usuário: ignora.
  }
}

/**
 * Traz a janela de execução para frente (usada no fluxo de captcha).
 * @param {number} windowId
 */
export async function focusWindow(windowId) {
  try {
    await chrome.windows.update(windowId, { focused: true, drawAttention: true });
  } catch {
    // Ignora janela fechada.
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

export function isCoinUrl(url) {
  return /coin-index/.test(url || '');
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
