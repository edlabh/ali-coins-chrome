/**
 * Popup: mostra o estado vivo do run, agenda, último relatório e ações rápidas.
 */
import { MSG, PHASE } from '../common/constants.js';
import { formatClock, formatDuration } from '../common/schedule.js';
import { statusLabel, coinsSourceLabel, fmtNumber } from '../common/format.js';

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
  const { settings, runState, lastReport, lastStreak, nextRunAt, blockedUntil } = data;

  // Chips rápidos de saldo e sequência no topo
  const latestBalance =
    lastReport && Number.isFinite(lastReport.balanceAfter)
      ? lastReport.balanceAfter
      : lastReport && Number.isFinite(lastReport.balanceBefore)
        ? lastReport.balanceBefore
        : null;
  const latestStreak =
    lastReport && lastReport.checkin && Number.isFinite(lastReport.checkin.streak)
      ? lastReport.checkin.streak
      : Number.isFinite(lastStreak)
        ? lastStreak
        : null;

  const metricBalance = $('metricBalance');
  const metricStreak = $('metricStreak');
  if (latestBalance !== null) {
    metricBalance.textContent = `🪙 ${latestBalance} moedas`;
    metricBalance.classList.remove('hidden');
  } else {
    metricBalance.classList.add('hidden');
  }
  if (latestStreak !== null) {
    metricStreak.textContent = `🔥 ${latestStreak} dias`;
    metricStreak.classList.remove('hidden');
  } else {
    metricStreak.classList.add('hidden');
  }
  $('metricsBar').classList.toggle('hidden', latestBalance === null && latestStreak === null);

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
    $('warnBlockedText').textContent = `Bloqueio anti-bot ativo. Novas tentativas liberadas após ${new Date(blockedUntil).toLocaleString('pt-BR')}. `;
  }

  // Aviso de check-in já coletado (ao vivo durante o run ou no último relatório).
  const alreadyCollected =
    Boolean(runState && runState.checkin && runState.checkin.already) ||
    Boolean(lastReport && lastReport.checkin && lastReport.checkin.already);
  $('warnAlready').classList.toggle('hidden', !alreadyCollected);

  const anyWarning =
    !$('warnCredentials').classList.contains('hidden') ||
    !$('warnAlready').classList.contains('hidden') ||
    !$('warnBlocked').classList.contains('hidden');
  $('warnings').classList.toggle('hidden', !anyWarning);

  // Extrato ao vivo (últimas linhas do log da execução).
  const liveLog = $('liveLog');
  const logEntries = (runState && Array.isArray(runState.log) ? runState.log : []).slice(-6);
  if (active && logEntries.length > 0) {
    liveLog.classList.remove('hidden');
    liveLog.replaceChildren(
      ...logEntries.map((entry) => {
        const li = document.createElement('li');
        li.textContent = `${formatClock(entry.t)} ${entry.msg}`;
        return li;
      })
    );
  } else {
    liveLog.classList.add('hidden');
    liveLog.replaceChildren();
  }

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
      const gained = Number.isFinite(c.coinsGainedToday) ? c.coinsGainedToday : c.coins;
      if (c.justCollected) {
        const src = coinsSourceLabel(c.coinsSource);
        lines.push(
          `Check-in: +${gained ?? '?'} moedas${src ? ` (${src})` : ''}${
            c.streak ? ` — sequência ${c.streak} dias` : ''
          }`
        );
      } else if (c.already) {
        lines.push(
          Number.isFinite(c.coinsGainedToday) && c.coinsGainedToday > 0
            ? `Check-in: já realizado hoje — crédito do dia no extrato: +${c.coinsGainedToday}`
            : 'Check-in: já realizado hoje (nenhuma moeda nova)'
        );
        if (c.streak) lines.push(`Sequência: ${c.streak} dias`);
      } else if (c.confirmedByLedger) {
        lines.push(`Check-in: confirmado pelo extrato (+${c.coinsGainedToday ?? '?'} moedas)`);
      } else {
        lines.push('Check-in: não confirmado');
      }
      if (c.streakBroken) lines.push('🚨 Sequência de check-in quebrada neste run');
    }
    if (Number.isFinite(lastReport.balanceBefore) || Number.isFinite(lastReport.balanceAfter)) {
      lines.push(
        `Saldo: ${fmtNumber(lastReport.balanceBefore)} → ${fmtNumber(lastReport.balanceAfter)}${
          lastReport.gained !== null ? ` (${lastReport.gained >= 0 ? '+' : ''}${lastReport.gained} no período)` : ''
        }`
      );
    }
    if (Number.isFinite(lastReport.tasksGained)) {
      lines.push(
        `Tarefas (delta de saldo): ${lastReport.tasksGained >= 0 ? '+' : ''}${lastReport.tasksGained} moedas`
      );
    }
    if (lastReport.ledger && Number.isFinite(lastReport.ledger.missionsCoins)) {
      lines.push(`Missões de moedas (extrato hoje): +${lastReport.ledger.missionsCoins}`);
    }

    // Extrato das ações de tarefas (título + tipo), como no relatório do ali-coins.
    const taskEntries = lastReport.tasks || [];
    for (const t of taskEntries.slice(0, 8)) {
      const kindLabel = t.kind === 'claim' ? 'resgate' : t.kind || 'ação';
      const icon = t.result === 'claimed' ? '✓' : t.result === 'error' ? '⚠' : '•';
      lines.push(`${icon} ${t.title || '(sem título)'} — ${kindLabel}`);
    }
    if (taskEntries.length > 8) lines.push(`… e mais ${taskEntries.length - 8} ação(ões).`);

    const skipped = lastReport.skipped || [];
    if (skipped.length) {
      lines.push(`Ignoradas: ${skipped.slice(0, 3).join('; ')}${skipped.length > 3 ? '…' : ''}`);
    }
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

$('btnOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

$('btnClearCooldown').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: MSG.CLEAR_COOLDOWN }).catch(() => {});
  await refresh();
});

refresh();
const timer = setInterval(refresh, 1500);
window.addEventListener('unload', () => clearInterval(timer));
