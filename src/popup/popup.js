/**
 * Popup: mostra o estado vivo do run, agenda, último relatório e ações rápidas.
 */
import { MSG, PHASE } from '../common/constants.js';
import { formatClock, formatDuration } from '../common/schedule.js';

const $ = (id) => document.getElementById(id);

const PHASE_LABELS = {
  [PHASE.IDLE]: 'Inativo',
  [PHASE.STARTING]: 'Iniciando',
  [PHASE.WAITING_DELAY]: 'Aguardando horário',
  [PHASE.AUTH]: 'Login',
  [PHASE.CAPTCHA]: 'Captcha — ação necessária',
  [PHASE.TWO_FA]: '2FA — ação necessária',
  [PHASE.CHECKIN]: 'Check-in',
  [PHASE.TASKS]: 'Tarefas',
  [PHASE.FINALIZING]: 'Finalizando',
  [PHASE.DONE]: 'Concluído',
  [PHASE.ERROR]: 'Erro',
  [PHASE.STOPPED]: 'Cancelado',
  [PHASE.BLOCKED]: 'Bloqueado (anti-bot)'
};

function dotKind(phase, active) {
  if (phase === PHASE.CAPTCHA || phase === PHASE.TWO_FA) return 'captcha';
  if (phase === PHASE.ERROR || phase === PHASE.BLOCKED) return 'error';
  if (phase === PHASE.DONE) return 'ok';
  if (active) return 'running';
  return 'idle';
}

async function refresh() {
  const data = await chrome.runtime.sendMessage({ type: MSG.GET_OVERVIEW }).catch(() => null);
  if (!data || !data.ok) return;
  const { settings, runState, lastReport, nextRunAt, blockedUntil } = data;

  const active = Boolean(runState && runState.active);
  const phase = (runState && runState.phase) || PHASE.IDLE;

  $('statusDot').className = `dot ${dotKind(phase, active)}`;
  $('statusPhase').textContent = PHASE_LABELS[phase] || phase;
  $('statusMessage').textContent = (runState && runState.message) || 'Pronto para executar.';

  const timing = [];
  if (active && runState.startedAt) {
    timing.push(`início ${formatClock(runState.startedAt)} • decorrido ${formatDuration(Date.now() - runState.startedAt)}`);
  } else if (runState && runState.finishedAt) {
    timing.push(`última conclusão ${formatClock(runState.finishedAt)}`);
  }
  $('statusTiming').textContent = timing.join(' • ');

  $('warnCredentials').classList.toggle('hidden', Boolean(settings.user && settings.hasPassword));
  $('warnBlocked').classList.toggle('hidden', !blockedUntil || blockedUntil < Date.now());
  if (blockedUntil && blockedUntil > Date.now()) {
    $('warnBlocked').textContent = `Bloqueio anti-bot ativo. Novas tentativas liberadas após ${new Date(blockedUntil).toLocaleString('pt-BR')}.`;
  }
  $('warnings').classList.toggle('hidden', $('warnCredentials').classList.contains('hidden') && $('warnBlocked').classList.contains('hidden'));

  $('btnRun').classList.toggle('hidden', active);
  $('btnStop').classList.toggle('hidden', !active);

  // Agenda
  const scheduleCard = $('scheduleCard');
  if (settings.scheduleEnabled || settings.runOnStartup) {
    scheduleCard.classList.remove('hidden');
    const parts = [];
    if (settings.scheduleEnabled) {
      parts.push(`diariamente às ${settings.scheduleTime}`);
      if (nextRunAt) parts.push(`próxima: ${new Date(nextRunAt).toLocaleString('pt-BR')}`);
    }
    if (settings.runOnStartup) parts.push('ao abrir o Chrome');
    $('scheduleText').textContent = parts.join(' • ');
  } else {
    scheduleCard.classList.add('hidden');
  }

  // Último relatório
  const reportCard = $('reportCard');
  if (lastReport) {
    reportCard.classList.remove('hidden');
    $('reportHead').textContent = `${new Date(lastReport.startedAt).toLocaleString('pt-BR')} • ${statusLabel(lastReport.status)} • ${formatDuration(lastReport.durationMs)}`;
    const lines = [];
    const c = lastReport.checkin;
    if (c) {
      if (c.justCollected) lines.push(`Check-in: +${c.coins ?? '?'} moedas${c.streak ? ` (sequência ${c.streak} dias)` : ''}`);
      else if (c.already) lines.push('Check-in: já realizado hoje');
      else lines.push('Check-in: não confirmado');
    }
    if (Number.isFinite(lastReport.balanceBefore) || Number.isFinite(lastReport.balanceAfter)) {
      lines.push(`Saldo: ${fmt(lastReport.balanceBefore)} → ${fmt(lastReport.balanceAfter)}${lastReport.gained !== null ? ` (${lastReport.gained >= 0 ? '+' : ''}${lastReport.gained})` : ''}`);
    }
    const claimed = (lastReport.tasks || []).filter((t) => t.kind === 'claim').length;
    const attempted = (lastReport.tasks || []).filter((t) => t.kind !== 'claim').length;
    if (attempted) lines.push(`Tarefas executadas: ${attempted}`);
    if (claimed) lines.push(`Resgates: ${claimed}`);
    if ((lastReport.skipped || []).length) lines.push(`Ignoradas (app): ${lastReport.skipped.length}`);
    if (lastReport.captchaEvents) lines.push(`Captchas: ${lastReport.captchaEvents}`);
    for (const err of (lastReport.errors || []).slice(0, 3)) lines.push(`⚠ ${err}`);
    $('reportLines').replaceChildren(...lines.map((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }));
  } else {
    reportCard.classList.add('hidden');
  }
}

function statusLabel(status) {
  return (
    {
      success: 'sucesso',
      partial: 'parcial',
      error: 'erro',
      stopped: 'cancelado',
      blocked: 'bloqueado'
    }[status] || status
  );
}

function fmt(v) {
  return Number.isFinite(v) ? String(v) : '—';
}

$('btnRun').addEventListener('click', async () => {
  $('btnRun').disabled = true;
  await chrome.runtime.sendMessage({ type: MSG.RUN_NOW }).catch(() => {});
  $('btnRun').disabled = false;
  setTimeout(refresh, 400);
});

$('btnStop').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: MSG.STOP_RUN }).catch(() => {});
  setTimeout(refresh, 400);
});

$('btnOpen').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: MSG.OPEN_WINDOW }).catch(() => {});
  window.close();
});

$('btnOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

refresh();
const timer = setInterval(refresh, 1500);
window.addEventListener('unload', () => clearInterval(timer));
