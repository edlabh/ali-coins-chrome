/**
 * Service worker (MV3): roteia mensagens entre popup/options, content scripts e o runner.
 */

import { MSG, PHASE, pickDevice } from '../common/constants.js';
import { startRun, requestStop } from './runner.js';
import { installScheduler, scheduleDaily } from './scheduler.js';
import { focusWindow, isAliexpressUrl, prepareRunTab, registerAuxTab } from './tabs.js';
import { clickTrusted, forgetCdp } from './cdp.js';
import { getRunState, getRuntime, getSettings, pushReport } from './storage.js';

installScheduler();

// O usuário pode cancelar o aviso de depuração: mantém o conjunto local coerente.
chrome.debugger.onDetach.addListener((source) => {
  if (source && typeof source.tabId === 'number') forgetCdp(source.tabId);
});

// Clique nas notificações do sistema: leva à janela do run (captcha, 2FA ou
// login manual). O aviso de login manual usa o mesmo fluxo.
chrome.notifications.onClicked.addListener(async (notificationId) => {
  try {
    chrome.notifications.clear(notificationId).catch(() => {});
    const runState = await getRunState();
    if (runState && runState.windowId) {
      await focusWindow(runState.windowId, runState.tabId || null);
    }
  } catch {
    // Sem janela ativa: ignora.
  }
});

// ── Proteção rigorosa de segundo plano: nenhuma aba da extensão ou aberta
// pelo site durante o run pode roubar o foco ou abrir em primeiro plano (a
// menos que a fase seja CAPTCHA ou TWO_FA).
let lastUserTabId = null;

function isRunOwnedTab(tabId, tab, runState) {
  if (!runState || !runState.active) return false;
  if (tabId === runState.tabId || tabId === runState.ledgerTabId) return true;
  if (
    tab &&
    ((runState.tabId && tab.openerTabId === runState.tabId) ||
      (runState.ledgerTabId && tab.openerTabId === runState.ledgerTabId))
  ) {
    return true;
  }
  const known = new Set(Array.isArray(runState.knownTabIds) ? runState.knownTabIds : []);
  const url = (tab && (tab.pendingUrl || tab.url)) || '';
  if (!known.has(tabId) && isAliexpressUrl(url)) return true;
  return false;
}

function shouldKeepSilent(runState) {
  if (!runState || !runState.active) return false;
  if (runState.silentMode === false) return false;
  // Fases que exigem o usuário (captcha, 2FA e login manual): o foco foi
  // trazido de propósito (focusWindow) e o guarda NÃO pode devolvê-lo.
  return (
    runState.phase !== PHASE.CAPTCHA &&
    runState.phase !== PHASE.TWO_FA &&
    runState.phase !== PHASE.AUTH
  );
}

chrome.tabs.onCreated.addListener(async (tab) => {
  try {
    if (!tab || typeof tab.id !== 'number') return;
    const runState = await getRunState();
    if (!runState || !runState.active) return;
    if (tab.id === runState.tabId || tab.id === runState.ledgerTabId) return;

    const spawnedByRunTab = Boolean(runState.tabId && tab.openerTabId === runState.tabId);
    const owned = spawnedByRunTab || isRunOwnedTab(tab.id, tab, runState);
    if (!owned) return;

    // P1: contexto mobile DESDE O PRIMEIRO BYTE — registra a aba auxiliar e
    // aplica as regras DNR (UA/Client Hints) na CRIAÇÃO, antes de o primeiro
    // load terminar. É o equivalente da extensão ao contexto único Pixel 7 da
    // referência (onde toda página nasce mobile); sem isto a 1ª carga saía
    // desktop e um reload posterior era uma 2ª visita sem referrer/gesto.
    try {
      const settings = await getSettings();
      await registerAuxTab(tab.id, settings);
    } catch {
      // best-effort: a aba segue sem as regras se o storage falhar
    }

    // Fluxo restaurado (v0.4.5, igual à v0.3.3 + projeto de origem): a página da
    // tarefa DEVE abrir na própria aba/nova aba do site — é assim que o
    // AliExpress contabiliza a visita. O guarda apenas mantém o foco na SUA aba
    // e força a nova aba para segundo plano; ela será adotada pelo loop de
    // tarefas (adoptTaskTab) e fechada ao fim da rodada (restoreTaskTab). Abas
    // realmente órfãs são limpas por closeOrphanTabs entre as tarefas.
    if (shouldKeepSilent(runState)) {
      const targetUserTab = runState.userTabId || lastUserTabId;
      if (targetUserTab && targetUserTab !== tab.id) {
        await chrome.tabs.update(targetUserTab, { active: true }).catch(() => {});
      }
      await chrome.tabs.update(tab.id, { active: false }).catch(() => {});
    }
  } catch {
    // Aba já fechada: ignora.
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const runState = await getRunState();
    if (!runState || !runState.active) {
      lastUserTabId = tabId;
      return;
    }
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (isRunOwnedTab(tabId, tab, runState)) {
      if (shouldKeepSilent(runState)) {
        const target = runState.userTabId || lastUserTabId;
        if (target && target !== tabId) {
          await chrome.tabs.update(target, { active: true }).catch(() => {});
        }
        await chrome.tabs.update(tabId, { active: false }).catch(() => {});
      }
      return; // nunca memoriza abas do run como aba do usuário
    }
    lastUserTabId = tabId;
  } catch {
    // Sem estado disponível: segue sem interferir.
  }
});

/**
 * Roteador de mensagens.
 * Retorna `true` para manter o canal aberto em respostas assíncronas.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((res) => sendResponse(res))
    .catch((err) => sendResponse({ error: err.message }));
  return true;
});

async function handleMessage(message, sender) {
  const type = message && message.type;
  switch (type) {
    case MSG.GET_OVERVIEW: {
      const [settings, runState, runtime] = await Promise.all([
        getSettings(),
        getRunState(),
        getRuntime()
      ]);
      return {
        ok: true,
        settings: {
          scheduleEnabled: settings.scheduleEnabled,
          scheduleTime: settings.scheduleTime,
          runOnStartup: settings.runOnStartup,
          device: settings.device,
          skipAppOnlyTasks: settings.skipAppOnlyTasks,
          keepWindowOpen: settings.keepWindowOpen
        },
        runState,
        lastReport: runtime.lastReport,
        lastStreak: runtime.lastStreak,
        nextRunAt: runtime.nextRunAt
      };
    }

    case MSG.RUN_NOW: {
      const res = await startRun({ reason: 'manual', manual: true });
      return { ok: true, ...res };
    }

    case MSG.STOP_RUN: {
      const stopped = await requestStop();
      return { ok: true, stopped };
    }

    case MSG.OPEN_WINDOW: {
      const settings = await getSettings();
      // Ação manual: sempre abre a janela VISÍVEL, mesmo com o modo silencioso ligado.
      const win = await prepareRunTab(settings, { forceVisible: true });
      return { ok: true, ...win };
    }

    // Cliques reais (CDP) solicitados pelo content script: o alvo é a aba que
    // enviou a mensagem. Defesa em profundidade: SÓ a aba do run ativo pode
    // pedir cliques reais (qualquer outra aba do AliExpress é rejeitada e o
    // content script cai no clique sintético).
    case MSG.TRUSTED_CLICK: {
      const tabId = sender && sender.tab ? sender.tab.id : null;
      const payload = (message && message.payload) || {};
      const x = Number(payload.x);
      const y = Number(payload.y);
      const validCoords =
        Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x <= 10000 && y <= 10000;
      if (!tabId || !validCoords) {
        return { ok: false, error: 'parametros-invalidos' };
      }
      const runState = await getRunState();
      if (!runState || !runState.active || runState.tabId !== tabId) {
        return { ok: false, error: 'aba-fora-do-run' };
      }
      return await clickTrusted(tabId, x, y);
    }

    case MSG.SETTINGS_CHANGED: {
      await scheduleDaily();
      return { ok: true };
    }

    // O content script anuncia que carregou. A resposta confirma se a aba atual
    // é a aba de execução (usada pelo bridge para marcar sessionStorage `ac_run`
    // e `ac_ua`, que autorizam e sincronizam o spoof de navigator no MAIN world).
    case MSG.CONTENT_READY: {
      const [runState, settings] = await Promise.all([getRunState(), getSettings()]);
      const tabId = sender && sender.tab ? sender.tab.id : null;
      const runTab = Boolean(runState && runState.active && tabId && runState.tabId === tabId);
      const device = runTab ? pickDevice(settings) : null;
      return {
        ok: true,
        runTab,
        runId: runTab ? runState.runId : null,
        userAgent: device ? device.userAgent : null
      };
    }

    default:
      return { ok: false, error: `Mensagem desconhecida: ${type}` };
  }
}

// Exposição para depuração manual no console do service worker.
self.__aliCoins = { startRun, requestStop, scheduleDaily, pushReport };
