/**
 * Aba de ITEM aberta por um clique (feed de surpresas, tarefa): detecção,
 * tratamento como "mini aba de run" (contexto mobile + foco emulado, igual ao
 * contexto Pixel 7 único da referência), espera pelos beacons de tracking e
 * fechamento — equivalente ao waitForEvent('page') + close do ali-coins.
 *
 * Vive no background (e não no content script) porque a aba de execução pode
 * navegar por completo, derrubando qualquer contexto de página.
 */

import { applySilentEmulation, detachCdp } from './cdp.js';
import { getRunState } from './storage.js';
import { applyItemTabDeviceRules, clearItemTabDeviceRules, waitTabComplete } from './tabs.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Procura uma aba criada durante o run (fora do snapshot, da aba de execução e
 * da aba do extrato); quando encontra:
 *   1. aplica o contexto MOBILE a ela (regras DNR de UA/Client Hints + emulação
 *      CDP de viewport/toque/FOCUS — a referência emula o aparelho para TODAS
 *      as páginas, ficha incluída; o foco emulado também evita o
 *      estrangulamento de timers da aba oculta, que atrasa os beacons);
 *   2. recarrega a página UMA vez já em contexto mobile (a aba nasce antes das
 *      regras existirem — mesma URL, com os parâmetros de tracking intactos);
 *   3. aguarda o load (com teto) + margem de beacons (referência: load + 1s);
 *   4. fecha a aba.
 * @param {number} windowId janela do run
 * @param {{settings?: object, timeoutMs?: number, graceMs?: number}} [options]
 * @returns {Promise<{closed: boolean}>} closed=true quando uma ficha foi tratada
 */
export async function consumeItemTab(windowId, { settings = null, timeoutMs = 2500, graceMs = 1500 } = {}) {
  const runState = await getRunState();
  if (!runState || !runState.active || !windowId) return { closed: false };

  const known = new Set(Array.isArray(runState.knownTabIds) ? runState.knownTabIds : []);
  const deadline = Date.now() + Math.min(Math.max(timeoutMs, 500), 8000);

  let itemTab = null;
  while (Date.now() < deadline) {
    const tabs = await chrome.tabs.query({ windowId }).catch(() => []);
    itemTab = tabs.find(
      (t) =>
        t.id &&
        t.id !== runState.tabId &&
        t.id !== runState.ledgerTabId &&
        !known.has(t.id) &&
        !/^chrome:\/\//.test(t.url || '') &&
        !/coin-pc-index/.test(t.url || '')
    );
    if (itemTab) break;
    await sleep(250);
  }
  if (!itemTab) return { closed: false };

  // 1. Contexto mobile + foco emulado (best-effort).
  if (settings) {
    await applyItemTabDeviceRules(itemTab.id, settings).catch(() => {});
  }
  if (settings) {
    await applySilentEmulation(itemTab.id, settings).catch(() => false);
  }

  // 2. Corrida do primeiro load: espera a URL da aba e recarrega já em mobile.
  let url = itemTab.pendingUrl || itemTab.url || '';
  for (let i = 0; i < 6 && (!url || url === 'about:blank'); i += 1) {
    await sleep(150);
    const fresh = await chrome.tabs.get(itemTab.id).catch(() => null);
    if (!fresh) return { closed: true }; // a própria página fechou: visita ocorreu
    url = fresh.pendingUrl || fresh.url || '';
  }
  if (settings && url && url !== 'about:blank' && !/^chrome:\/\//.test(url)) {
    await chrome.tabs.update(itemTab.id, { url }).catch(() => {});
  }

  // 3. Janela de beacons: aguarda o load (teto de 6s) + margem (referência:
  //    domcontentloaded + 1000ms; aqui um pouco mais por causa do reload).
  await waitTabComplete(itemTab.id, 6000);
  await sleep(Math.min(Math.max(graceMs, 400), 6000));

  // 4. Fecha a ficha (e limpa emulação/regras).
  await detachCdp(itemTab.id).catch(() => {});
  await clearItemTabDeviceRules().catch(() => {});
  await chrome.tabs.remove(itemTab.id).catch(() => {});
  return { closed: true };
}
