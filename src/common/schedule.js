/**
 * Utilitários puros de agendamento e formatação.
 * Usados pelo service worker e testáveis com `node --test`.
 */

/**
 * Valida e normaliza uma string de horário "HH:MM".
 * @param {string} timeStr
 * @returns {{hours: number, minutes: number} | null}
 */
export function parseTimeOfDay(timeStr) {
  if (typeof timeStr !== 'string') return null;
  const m = timeStr.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return null;
  return { hours: Number.parseInt(m[1], 10), minutes: Number.parseInt(m[2], 10) };
}

/**
 * Calcula o próximo timestamp (ms epoch) para um horário diário "HH:MM".
 * Se o horário de hoje ainda não passou, retorna hoje; senão, amanhã.
 * @param {string} timeStr "HH:MM"
 * @param {Date} [now=new Date()]
 * @returns {number | null} timestamp em ms ou null se o formato for inválido
 */
export function computeNextRunAt(timeStr, now = new Date()) {
  const parsed = parseTimeOfDay(timeStr);
  if (!parsed) return null;
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parsed.hours, parsed.minutes, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

/**
 * Formata duração em ms para "Xm Ys" / "Xs".
 * @param {number} ms
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

/**
 * Formata timestamp para HH:MM:SS local.
 * @param {number} ts
 */
export function formatClock(ts) {
  if (!Number.isFinite(ts)) return '—';
  return new Date(ts).toLocaleTimeString('pt-BR', { hour12: false });
}

/**
 * Sorteia um inteiro em [min, max] (inclusive). Valores invertidos são normalizados.
 */
export function randInt(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/**
 * Catch-up da agenda: indica se o horário agendado passou com o Chrome fechado
 * (portanto a execução deve acontecer na próxima abertura do navegador).
 * @param {{scheduleEnabled?: boolean, catchUpMissed?: boolean, missedAt?: (number|null), now?: number}} params
 * @returns {boolean}
 */
export function shouldCatchUp({
  scheduleEnabled = false,
  catchUpMissed = true,
  missedAt = null,
  now = Date.now()
} = {}) {
  if (!scheduleEnabled) return false;
  if (catchUpMissed === false) return false;
  if (!Number.isFinite(missedAt)) return false;
  return now > missedAt;
}
