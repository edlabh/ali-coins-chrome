/**
 * Agendamento: alarme diário + execução na abertura do Chrome.
 */

import { computeNextRunAt } from '../common/schedule.js';
import { getSettings, patchRuntime } from './storage.js';
import { startRun } from './runner.js';
import { setBadge } from './notify.js';

const ALARM_DAILY = 'ali-coins-daily';

/**
 * (Re)agenda o alarme diário conforme as configurações.
 * @param {object} [settings]
 */
export async function scheduleDaily(settings) {
  const s = settings || (await getSettings());
  await chrome.alarms.clear(ALARM_DAILY);
  if (!s.scheduleEnabled) {
    await patchRuntime({ nextRunAt: null });
    return;
  }
  const nextRunAt = computeNextRunAt(s.scheduleTime);
  if (!nextRunAt) {
    await patchRuntime({ nextRunAt: null });
    return;
  }
  await chrome.alarms.create(ALARM_DAILY, { when: nextRunAt });
  await patchRuntime({ nextRunAt });
}

/**
 * Reagenda para o dia seguinte após um disparo (computeNextRunAt com now > horário).
 */
async function rescheduleAfterFire() {
  const s = await getSettings();
  if (!s.scheduleEnabled) {
    await patchRuntime({ nextRunAt: null });
    return;
  }
  const nextRunAt = computeNextRunAt(s.scheduleTime);
  await chrome.alarms.create(ALARM_DAILY, { when: nextRunAt });
  await patchRuntime({ nextRunAt });
}

/**
 * Instala os listeners de agendamento (chamado uma vez no service worker).
 */
export function installScheduler() {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== ALARM_DAILY) return;
    await rescheduleAfterFire();
    const s = await getSettings();
    if (!s.scheduleEnabled) return;
    await setBadge('…', 'idle');
    await startRun({ reason: 'schedule', manual: false });
  });

  chrome.runtime.onStartup.addListener(async () => {
    const s = await getSettings();
    // Reagenda o alarme diário (alarms sobrevivem a reinícios, mas recriamos por segurança).
    await scheduleDaily(s);
    if (s.runOnStartup) {
      await setBadge('…', 'idle');
      await startRun({ reason: 'startup', manual: false });
    }
  });

  chrome.runtime.onInstalled.addListener(async () => {
    const s = await getSettings();
    await scheduleDaily(s);
  });
}
