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
