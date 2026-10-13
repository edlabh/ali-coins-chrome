/**
 * Service worker (MV3): roteia mensagens entre popup/options, content scripts e o runner.
 */

import { MSG } from '../common/constants.js';
import { startRun, requestStop } from './runner.js';
import { installScheduler, scheduleDaily } from './scheduler.js';
import { ensureRunWindow } from './tabs.js';
import { getRunState, getRuntime, getSettings, pushReport } from './storage.js';

installScheduler();

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
        nextRunAt: runtime.nextRunAt,
        blockedUntil: runtime.blockedUntil
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
      const win = await ensureRunWindow(settings);
      return { ok: true, ...win };
    }

    case MSG.SETTINGS_CHANGED: {
      await scheduleDaily();
      return { ok: true };
    }

    // O content script anuncia que carregou (usado para depuração e futuras esperas).
    case MSG.CONTENT_READY: {
      return { ok: true };
    }

    case MSG.CONTENT_PROGRESS: {
      return { ok: true };
    }

    default:
      return { ok: false, error: `Mensagem desconhecida: ${type}` };
  }
}

// Exposição para depuração manual no console do service worker.
self.__aliCoins = { startRun, requestStop, scheduleDaily, pushReport };
