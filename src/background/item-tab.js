/**
 * Aba de ITEM aberta por um clique (feed de surpresas, tarefa): detecção,
 * espera pelos beacons de tracking e fechamento — equivalente ao
 * waitForEvent('page') + close do ali-coins.
 *
 * Vive no background (e não no content script) porque a aba de execução pode
 * navegar por completo, derrubando qualquer contexto de página.
 */

import { getRunState } from './storage.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Procura uma aba criada durante o run (fora do snapshot, da aba de execução e
 * da aba do extrato); quando encontra, aguarda `graceMs` (beacons) e fecha.
 * @param {number} windowId janela do run
 * @param {{timeoutMs?: number, graceMs?: number}} [options]
 * @returns {Promise<boolean>} true quando uma aba de item foi encontrada e fechada
 */
export async function consumeItemTab(windowId, { timeoutMs = 2500, graceMs = 3500 } = {}) {
  const runState = await getRunState();
  if (!runState || !runState.active || !windowId) return false;

  const known = new Set(Array.isArray(runState.knownTabIds) ? runState.knownTabIds : []);
  const deadline = Date.now() + Math.min(Math.max(timeoutMs, 500), 8000);

  while (Date.now() < deadline) {
    const tabs = await chrome.tabs.query({ windowId }).catch(() => []);
    const itemTab = tabs.find(
      (t) =>
        t.id &&
        t.id !== runState.tabId &&
        t.id !== runState.ledgerTabId &&
        !known.has(t.id) &&
        !/^chrome:\/\//.test(t.url || '') &&
        !/coin-pc-index/.test(t.url || '')
    );
    if (itemTab) {
      await sleep(Math.min(Math.max(graceMs, 200), 5000));
      await chrome.tabs.remove(itemTab.id).catch(() => {});
      return true;
    }
    await sleep(250);
  }
  return false;
}
