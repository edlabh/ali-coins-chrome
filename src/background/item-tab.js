/**
 * Aba de ITEM aberta por um clique (feed de surpresas, tarefa): detecção,
 * tratamento como "mini aba de run" (contexto mobile aplicado NA CRIAÇÃO + foco
 * emulado), janela de beacons com INSTRUMENTAÇÃO (conta requests de tracking e
 * lê a visibilidade) e fechamento — equivalente ao waitForEvent('page') +
 * close do ali-coins.
 *
 * Vive no background (e não no content script) porque a aba de execução pode
 * navegar por completo, derrubando qualquer contexto de página.
 */

import { applySilentEmulation, attachCdp, detachCdp } from './cdp.js';
import { getRunState } from './storage.js';
import {
  isAliexpressUrl,
  unregisterAuxTab,
  waitTabComplete
} from './tabs.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Instrumentação: observa requests de tracking (mesmos padrões do responseHandler
// do ali-coins: /track, /trace, adclick, ae-) por aba auxiliar em observação.
const beaconWatch = new Map();

try {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (method !== 'Network.requestWillBeSent') return;
    const watch = source && typeof source.tabId === 'number' ? beaconWatch.get(source.tabId) : null;
    if (!watch) return;
    const url = (params && params.request && params.request.url) || '';
    if (/\/track|\/trace|adclick|ae-/i.test(url)) {
      watch.tracking += 1;
      if (watch.sample.length < 3) watch.sample.push(url.slice(0, 120));
    }
  });
} catch {
  // chrome.debugger indisponível: instrumentação fica no-op
}

/**
 * Procura uma aba criada durante o run (fora do snapshot, da aba de execução e
 * da aba do extrato); quando encontra:
 *   1. garante o contexto MOBILE (as regras DNR são aplicadas na CRIAÇÃO pelo
 *      service worker; aqui só re-registra por segurança) + emulação CDP
 *      (viewport/toque/FOCUS);
 *   2. liga a INSTRUMENTAÇÃO (Network) e aguarda o load (com teto) + margem de
 *      beacons;
 *   3. lê a visibilidade da página e conta os beacons de tracking;
 *   4. fecha a aba e devolve os diagnósticos para o extrato.
 * @param {number} windowId janela preferencial do run (detecção global por opener)
 * @param {{settings?: object, timeoutMs?: number, graceMs?: number}} [options]
 * @returns {Promise<{closed: boolean, tracking?: number, visibility?: string, sample?: string[]}>}
 */
export async function consumeItemTab(
  windowId,
  { settings = null, timeoutMs = 2500, graceMs = 1500 } = {}
) {
  const runState = await getRunState();
  if (!runState || !runState.active) return { closed: false };

  const known = new Set(Array.isArray(runState.knownTabIds) ? runState.knownTabIds : []);
  const deadline = Date.now() + Math.min(Math.max(timeoutMs, 500), 8000);

  let itemTab = null;
  while (Date.now() < deadline) {
    // P4: detecção GLOBAL (não só na janela do run) — cliques em janela popup
    // podem abrir a ficha na janela normal; preferimos a aba cujo opener é a
    // aba de execução, com fallback para uma aba AliExpress nova.
    const tabs = await chrome.tabs.query({}).catch(() => []);
    const candidates = tabs.filter(
      (t) =>
        t.id &&
        t.id !== runState.tabId &&
        t.id !== runState.ledgerTabId &&
        !known.has(t.id) &&
        !/^chrome:\/\//.test(t.url || '') &&
        !/coin-pc-index/.test(t.url || '')
    );
    itemTab =
      candidates.find((t) => t.openerTabId === runState.tabId) ||
      candidates.find(
        (t) => isAliexpressUrl(t.url || '') || isAliexpressUrl(t.pendingUrl || '')
      ) ||
      null;
    if (itemTab) break;
    await sleep(250);
  }
  if (!itemTab) return { closed: false };

  const tabId = itemTab.id;

  // 1. Contexto mobile (as regras já foram aplicadas na criação; emulação CDP:
  //    viewport/toque/FOCUS — o foco emulado evita que a página se comporte como
  //    "não visível"; a ficha segue em segundo plano, sem roubar seu foco).
  if (settings) {
    await attachCdp(tabId).catch(() => false);
    await applySilentEmulation(tabId, settings).catch(() => false);
  }

  // 2. Instrumentação de crédito (P2): conta beacons de tracking e lê a
  //    visibilidade — a evidência que confirma/derruba a hipótese de
  //    throttling da aba oculta (a referência desliga o throttling no launch).
  const watch = { tracking: 0, sample: [] };
  beaconWatch.set(tabId, watch);
  try {
    await attachCdp(tabId);
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
  } catch {
    // sem Network: a contagem fica em 0 e o extrato indica a indisponibilidade
  }

  // 3. Espera a URL real (sem RECARREGAR — o contexto mobile já vale desde a
  //    criação; preserva referrer/gesto da visita original) e a janela de beacons.
  let url = itemTab.pendingUrl || itemTab.url || '';
  for (let i = 0; i < 6 && (!url || url === 'about:blank'); i += 1) {
    await sleep(150);
    const fresh = await chrome.tabs.get(tabId).catch(() => null);
    if (!fresh) {
      beaconWatch.delete(tabId);
      return { closed: true, tracking: watch.tracking, sample: watch.sample };
    }
    url = fresh.pendingUrl || fresh.url || '';
  }
  await waitTabComplete(tabId, 6000);
  await sleep(Math.min(Math.max(graceMs, 400), 6000));

  // 4. Diagnóstico final (visibilidade) e fechamento.
  let visibility = '';
  try {
    const res = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: 'document.visibilityState',
      returnByValue: true
    });
    visibility = (res && res.result && res.result.value) || '';
  } catch {
    // sem Runtime: mantém '' (extrato indicará indisponível)
  }
  beaconWatch.delete(tabId);
  await detachCdp(tabId).catch(() => {});
  await unregisterAuxTab(tabId).catch(() => {});
  await chrome.tabs.remove(tabId).catch(() => {});
  return { closed: true, tracking: watch.tracking, visibility, sample: watch.sample };
}
