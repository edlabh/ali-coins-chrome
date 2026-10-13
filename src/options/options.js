/**
 * Página de opções: credenciais, agendamento, tarefas, captcha, aparelho e extrato.
 */
import { MSG } from '../common/constants.js';
import {
  getSettings,
  saveSettings,
  clearCredentials,
  patchRuntime,
  getRuntime
} from '../background/storage.js';

const $ = (id) => document.getElementById(id);

function statusLabelPt(status) {
  return (
    {
      success: 'sucesso',
      partial: 'parcial',
      error: 'erro',
      stopped: 'cancelado',
      blocked: 'bloqueado'
    }[status] || status || 'desconhecido'
  );
}

function sourceLabel(source) {
  return (
    {
      'desktop-bonus': 'extrato',
      'desktop-checkin': 'extrato',
      'mobile-modal': 'modal mobile',
      'streak-estimate': 'estimativa pela sequência'
    }[source] || source || ''
  );
}

function fmtNum(v) {
  return Number.isFinite(v) ? String(v) : '—';
}

function runSummaryLine(run) {
  const when = run.startedAt ? new Date(run.startedAt).toLocaleString('pt-BR') : '—';
  const bits = [when, statusLabelPt(run.status)];
  if (run.checkin) {
    if (run.checkin.justCollected) bits.push(`check-in +${run.checkin.coins ?? '?'}`);
    else if (run.checkin.already) bits.push('check-in já coletado');
  }
  if (Number.isFinite(run.gained)) bits.push(`saldo ${run.gained >= 0 ? '+' : ''}${run.gained}`);
  return bits.join(' • ');
}

/** Linhas de detalhe do extrato de uma execução (texto puro, sem innerHTML). */
function runDetailLines(run) {
  const lines = [];
  const c = run.checkin;
  if (c) {
    if (c.justCollected) {
      const src = c.coinsSource ? ` (${sourceLabel(c.coinsSource)})` : '';
      lines.push(`Check-in: +${c.coins ?? '?'} moedas${src}`);
    } else if (c.already) {
      lines.push('Check-in: já realizado hoje');
    } else {
      lines.push('Check-in: não confirmado');
    }
    if (c.streak) lines.push(`Sequência: ${c.streak} dias`);
    if (c.streakBroken) lines.push('🚨 Sequência de check-in quebrada neste run');
  }
  if (Number.isFinite(run.balanceBefore) || Number.isFinite(run.balanceAfter)) {
    const delta = Number.isFinite(run.gained) ? ` (${run.gained >= 0 ? '+' : ''}${run.gained} no período)` : '';
    lines.push(`Saldo: ${fmtNum(run.balanceBefore)} → ${fmtNum(run.balanceAfter)}${delta}`);
  }
  if (Number.isFinite(run.tasksGained)) {
    lines.push(`Tarefas (saldo): ${run.tasksGained >= 0 ? '+' : ''}${run.tasksGained} moedas`);
  }
  if (run.ledger && Number.isFinite(run.ledger.missionsCoins)) {
    const count = run.ledger.missionsCount ? ` (${run.ledger.missionsCount} lançamentos)` : '';
    lines.push(`Missões de moedas no extrato (hoje): +${run.ledger.missionsCoins}${count}`);
  }
  for (const t of run.tasks || []) {
    const kind = t.kind === 'claim' ? 'resgate' : t.kind || 'ação';
    lines.push(`• ${t.title || '(sem título)'} — ${kind}`);
  }
  const skipped = run.skipped || [];
  if (skipped.length) lines.push(`Ignoradas (app): ${skipped.join('; ')}`);
  if (run.captchaEvents) lines.push(`Captchas resolvidos no run: ${run.captchaEvents}`);
  for (const err of run.errors || []) lines.push(`⚠ ${err}`);
  for (const entry of run.log || []) {
    lines.push(`⏱ ${new Date(entry.t).toLocaleTimeString('pt-BR')} ${entry.msg}`);
  }
  return lines;
}

async function renderHistory() {
  const container = $('historyList');
  const runtime = await getRuntime();
  const history = Array.isArray(runtime.history) ? runtime.history : [];

  container.replaceChildren();

  if (history.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted small';
    empty.textContent = 'Nenhuma execução registrada ainda.';
    container.appendChild(empty);
    return;
  }

  for (const run of history) {
    const details = document.createElement('details');
    details.className = 'run';

    const summary = document.createElement('summary');
    summary.textContent = runSummaryLine(run);
    details.appendChild(summary);

    const list = document.createElement('ul');
    for (const text of runDetailLines(run)) {
      const li = document.createElement('li');
      li.textContent = text;
      if (text.startsWith('⏱')) li.className = 'log-line';
      list.appendChild(li);
    }
    details.appendChild(list);
    container.appendChild(details);
  }
}

function setStatus(text, kind = '') {
  const el = $('saveStatus');
  el.textContent = text;
  el.className = `status ${kind}`;
}

async function load() {
  const s = await getSettings();
  $('user').value = s.user || '';
  $('passwordState').textContent = s.passwordEnc
    ? 'Senha configurada (cifrada).'
    : s.passwordPlain
      ? 'Senha configurada em texto puro (criptografia indisponível neste navegador).'
      : 'Nenhuma senha configurada.';

  $('scheduleEnabled').checked = Boolean(s.scheduleEnabled);
  $('scheduleTime').value = s.scheduleTime || '09:30';
  $('runOnStartup').checked = Boolean(s.runOnStartup);
  $('startDelayMaxMin').value = s.startDelayMaxMin ?? 15;

  $('skipAppOnlyTasks').checked = s.skipAppOnlyTasks !== false;
  $('maxTaskActions').value = s.maxTaskActions ?? 25;
  $('maxAttemptsPerTask').value = s.maxAttemptsPerTask ?? 3;
  $('pauseMinS').value = Math.round((s.pauseBetweenTasksMinMs ?? 5000) / 1000);
  $('pauseMaxS').value = Math.round((s.pauseBetweenTasksMaxMs ?? 20000) / 1000);
  $('searchQuery').value = s.searchQuery || 'fone bluetooth';
  $('scrollSeconds').value = s.scrollSeconds ?? 10;

  $('captchaTimeoutMin').value = s.captchaTimeoutMin ?? 5;
  $('riskCooldownHours').value = s.riskCooldownHours ?? 48;

  $('device').value = s.device || 'pixel8';
  $('customUA').value = s.customUA || '';
  $('customWidth').value = s.customWidth ?? 412;
  $('customHeight').value = s.customHeight ?? 915;
  $('customFields').classList.toggle('hidden', $('device').value !== 'custom');

  $('keepWindowOpen').checked = s.keepWindowOpen !== false;
  $('notifications').checked = s.notifications !== false;
}

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function save() {
  const pauseMinS = toInt($('pauseMinS').value, 5);
  const pauseMaxS = toInt($('pauseMaxS').value, 20);
  if (pauseMaxS < pauseMinS) {
    setStatus('A pausa máxima deve ser >= à mínima.', 'error');
    return;
  }

  const patch = {
    user: $('user').value.trim(),
    scheduleEnabled: $('scheduleEnabled').checked,
    scheduleTime: $('scheduleTime').value || '09:30',
    runOnStartup: $('runOnStartup').checked,
    startDelayMaxMin: toInt($('startDelayMaxMin').value, 15),

    skipAppOnlyTasks: $('skipAppOnlyTasks').checked,
    maxTaskActions: toInt($('maxTaskActions').value, 25),
    maxAttemptsPerTask: toInt($('maxAttemptsPerTask').value, 3),
    pauseBetweenTasksMinMs: pauseMinS * 1000,
    pauseBetweenTasksMaxMs: pauseMaxS * 1000,
    searchQuery: $('searchQuery').value.trim() || 'fone bluetooth',
    scrollSeconds: toInt($('scrollSeconds').value, 10),

    captchaTimeoutMin: toInt($('captchaTimeoutMin').value, 5),
    riskCooldownHours: toInt($('riskCooldownHours').value, 48),

    device: $('device').value,
    customUA: $('customUA').value.trim(),
    customWidth: toInt($('customWidth').value, 412),
    customHeight: toInt($('customHeight').value, 915),
    keepWindowOpen: $('keepWindowOpen').checked,
    notifications: $('notifications').checked
  };

  const password = $('password').value;
  if (password) patch.password = password;

  await saveSettings(patch);
  $('password').value = '';
  if (password) {
    const after = await getSettings();
    $('passwordState').textContent = after.passwordEnc
      ? 'Senha configurada (cifrada).'
      : 'Senha configurada em texto puro (criptografia indisponível neste navegador).';
  }

  // Reagenda o alarme diário no service worker.
  await chrome.runtime.sendMessage({ type: 'SETTINGS_CHANGED' }).catch(() => {});
  setStatus('Configurações salvas.', 'ok');
  setTimeout(() => setStatus(''), 3000);
}

$('device').addEventListener('change', () => {
  $('customFields').classList.toggle('hidden', $('device').value !== 'custom');
});

$('btnSave').addEventListener('click', save);

$('btnRun').addEventListener('click', async () => {
  setStatus('Iniciando execução…');
  const res = await chrome.runtime.sendMessage({ type: MSG.RUN_NOW }).catch(() => null);
  if (res && res.alreadyRunning) setStatus('Já existe uma execução em andamento.', 'error');
  else if (res && res.blockedUntil) setStatus(`Bloqueio anti-bot ativo até ${new Date(res.blockedUntil).toLocaleString('pt-BR')}.`, 'error');
  else setStatus('Execução iniciada. Acompanhe pelo popup da extensão.', 'ok');
});

$('btnClearCreds').addEventListener('click', async () => {
  await clearCredentials();
  $('user').value = '';
  $('password').value = '';
  $('passwordState').textContent = 'Nenhuma senha configurada.';
  setStatus('Credenciais removidas.', 'ok');
});

$('btnClearHistory').addEventListener('click', async () => {
  await patchRuntime({ lastReport: null, history: [], blockedUntil: null });
  await renderHistory();
  setStatus('Histórico e cooldown limpos.', 'ok');
});

$('btnRefreshHistory').addEventListener('click', () => {
  renderHistory().catch(() => {});
});

load()
  .then(() => renderHistory())
  .catch((err) => setStatus(`Falha ao carregar opções: ${err.message}`, 'error'));
