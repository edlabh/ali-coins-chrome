/**
 * Retentativa automática de execuções que falharam.
 * Alarme de disparo único, gerenciado aqui para evitar dependência circular
 * entre runner.js e scheduler.js.
 */

export const RETRY_ALARM = 'ali-coins-retry';
export const RETRY_DELAY_MIN = 45;

/**
 * Agenda UMA retentativa para daqui a `RETRY_DELAY_MIN` minutos.
 */
export async function scheduleRetry() {
  const when = Date.now() + RETRY_DELAY_MIN * 60 * 1000;
  await chrome.alarms.clear(RETRY_ALARM).catch(() => {});
  await chrome.alarms.create(RETRY_ALARM, { when });
}

/**
 * Cancela uma retentativa pendente (chamada no início de qualquer nova execução,
 * que a supersede).
 */
export async function clearRetry() {
  await chrome.alarms.clear(RETRY_ALARM).catch(() => {});
}
