/**
 * Formatadores compartilhados entre background, popup e options (pt-BR).
 * Centraliza rótulos que antes estavam duplicados em três arquivos.
 */

/** Rótulo de status de uma execução. */
export function statusLabel(status) {
  return (
    {
      success: 'sucesso',
      partial: 'parcial',
      error: 'erro',
      stopped: 'cancelado',
      blocked: 'bloqueado'
    }[status] ||
    status ||
    'desconhecido'
  );
}

/** Rótulo da fonte do valor do check-in. */
export function coinsSourceLabel(source) {
  return (
    {
      'desktop-bonus': 'extrato',
      'desktop-checkin': 'extrato',
      'mobile-modal': 'modal mobile',
      'streak-estimate': 'estimativa pela sequência'
    }[source] ||
    source ||
    ''
  );
}

/** Número para exibição ('—' quando ausente). */
export function fmtNumber(value) {
  return Number.isFinite(value) ? String(value) : '—';
}

/** Converte um texto/valor monetário em número (null quando ausente/inválido). */
export function toNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number.parseInt(String(value).replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

/** Trunca um texto para exibição (com reticências). */
export function truncate(text, max) {
  const t = String(text || '').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
