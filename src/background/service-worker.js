/**
 * Service worker (MV3): roteia mensagens entre popup/options, content scripts e o runner.
 */

import { MSG, pickDevice } from '../common/constants.js';
import { startRun, requestStop } from './runner.js';
import { installScheduler, scheduleDaily } from './scheduler.js';
import { focusWindow, prepareRunTab } from './tabs.js';
import { clickTrusted, forgetCdp } from './cdp.js';
import { getRunState, getRuntime, getSettings, patchRuntime, pushReport } from './storage.js';

installScheduler();

// O usuário pode cancelar o aviso de depuração: mantém o conjunto local coerente.
chrome.debugger.onDetach.addListener((source) => {
  if (source && typeof source.tabId === 'number') forgetCdp(source.tabId);
});

// Clique nas notificações do sistema: leva à janela do captcha/run ou abre as Opções.
chrome.notifications.onClicked.addListener(async (notificationId) => {
  try {
    chrome.notifications.clear(notificationId).catch(() => {});
    if (notificationId === 'ali-coins-missing-credentials') {
      chrome.runtime.openOptionsPage();
      return;
    }
    const runState = await getRunState();
    if (runState && runState.windowId) {
      await focusWindow(runState.windowId, runState.tabId || null);
    }
  } catch {
    // Sem janela ativa: ignora.
  }
});

// ── Abas abertas pelo PRÓPRIO SITE durante o run (fichas de produto do feed,
// atalhos de tarefa) não devem roubar o primeiro plano do usuário — essencial
// no modo silencioso. Quando uma aba criada A PARTIR da aba do run é ativada,
// devolvemos o foco à última aba do usuário (sem fechar nada; a limpeza de
// abas órfãs cuida do resto).
let lastUserTabId = null;
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const runState = await getRunState();
    if (!runState || !runState.active || tabId === runState.tabId) {
      lastUserTabId = tabId;
      return;
    }
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && runState.tabId && tab.openerTabId === runState.tabId) {
      const target = lastUserTabId || runState.userTabId;
      if (target && target !== tabId) {
        chrome.tabs.update(target, { active: true }).catch(() => {});
      }
      return; // não memoriza a aba automática do site
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
          user: settings.user,
          hasPassword: Boolean(settings.passwordEnc || settings.passwordPlain),
          cryptoOk: settings.cryptoOk,
          scheduleEnabled: settings.scheduleEnabled,
          scheduleTime: settings.scheduleTime,
          runOnStartup: settings.runOnStartup,
          device: settings.device,
          skipAppOnlyTasks: settings.skipAppOnlyTasks,
          keepWindowOpen: settings.keepWindowOpen,
          captchaTimeoutMin: settings.captchaTimeoutMin
        },
        runState,
        lastReport: runtime.lastReport,
        lastStreak: runtime.lastStreak,
        nextRunAt: runtime.nextRunAt,
        blockedUntil: runtime.blockedUntil
      };
    }

    case MSG.CLEAR_COOLDOWN: {
      await patchRuntime({ blockedUntil: null });
      return { ok: true };
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
