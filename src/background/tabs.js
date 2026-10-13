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

const DNR_RULE_ID = 9001;

/**
 * Garante que temos uma janela/aba de execução válida e focada.
 * Reutiliza a aba existente quando ela ainda aponta para o AliExpress.
 * @param {object} settings
 * @returns {Promise<{windowId: number, tabId: number, reused: boolean}>}
 */
export async function ensureRunWindow(settings) {
  const runtimeRef = await getRuntimeTab();

  if (runtimeRef) {
    try {
      const tab = await chrome.tabs.get(runtimeRef.tabId);
      if (tab && tab.windowId && isAliexpressUrl(tab.url || '')) {
        await chrome.windows.update(tab.windowId, { focused: true });
        return { windowId: tab.windowId, tabId: tab.id, reused: true };
      }
    } catch {
      // Aba sumiu: recria abaixo.
    }
  }

  const device = pickDevice(settings);
  // +16px de largura e +0 de altura: compensa a borda da janela popup na maioria dos WMs.
  const win = await chrome.windows.create({
    url: COIN_URL,
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
 * Aplica as regras de User-Agent (Pixel 8) escopadas a uma aba.
 * @param {number} tabId
 * @param {object} settings
 */
export async function applyDeviceRules(tabId, settings) {
  const device = pickDevice(settings);
  const rule = {
    id: DNR_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'user-agent', operation: 'set', value: device.userAgent },
        { header: 'sec-ch-ua-mobile', operation: 'set', value: '?1' },
        { header: 'sec-ch-ua-platform', operation: 'set', value: '"Android"' }
      ]
    },
    condition: {
      urlFilter: 'aliexpress',
      tabIds: [tabId]
    }
  };

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [DNR_RULE_ID],
    addRules: [rule]
  });
}

/**
 * Remove a regra de UA (a aba pode voltar a ser desktop após o run).
 */
export async function clearDeviceRules() {
  await chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: [DNR_RULE_ID] })
    .catch(() => {});
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
