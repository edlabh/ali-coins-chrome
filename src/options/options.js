/**
 * Página de opções: agendamento, tarefas, aparelho e extrato (login é manual —
 * sem campos de credenciais, captcha/cooldown têm comportamento fixo).
 */
import { DEFAULT_SETTINGS, MSG } from '../common/constants.js';
import { statusLabel, coinsSourceLabel, fmtNumber } from '../common/format.js';
import { getSettings, saveSettings, patchRuntime, getRuntime } from '../background/storage.js';

const $ = (id) => document.getElementById(id);

// Mostra a versão da extensão ao lado do nome (ex.: "Ali Coins — Opções v0.4.6").
try {
  const versionEl = $('appVersion');
  if (versionEl) versionEl.textContent = `v${chrome.runtime.getManifest().version}`;
} catch {
  // getManifest indisponível: segue sem a versão
}

function runSummaryLine(run) {
  const when = run.startedAt ? new Date(run.startedAt).toLocaleString('pt-BR') : '—';
  const bits = [when, statusLabel(run.status)];
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
      const src = c.coinsSource ? ` (${coinsSourceLabel(c.coinsSource)})` : '';
      lines.push(`Check-in: +${c.coinsGainedToday ?? c.coins ?? '?'} moedas${src}`);
    } else if (c.already) {
      lines.push(
        Number.isFinite(c.coinsGainedToday) && c.coinsGainedToday > 0
          ? `Check-in: já realizado hoje — crédito no extrato: +${c.coinsGainedToday}`
          : 'Check-in: já realizado hoje'
      );
    } else if (c.confirmedByLedger) {
      lines.push(`Check-in: confirmado pelo extrato (+${c.coinsGainedToday ?? '?'} moedas)`);
    } else {
      lines.push('Check-in: não confirmado');
    }
    if (c.streak) lines.push(`Sequência: ${c.streak} dias`);
    if (c.streakBroken) lines.push('🚨 Sequência de check-in quebrada neste run');
  }
  if (Number.isFinite(run.balanceBefore) || Number.isFinite(run.balanceAfter)) {
    const delta = Number.isFinite(run.gained) ? ` (${run.gained >= 0 ? '+' : ''}${run.gained} no período)` : '';
    lines.push(`Saldo: ${fmtNumber(run.balanceBefore)} → ${fmtNumber(run.balanceAfter)}${delta}`);
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
  if (skipped.length) lines.push(`Ignoradas: ${skipped.join('; ')}`);
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

  $('scheduleEnabled').checked = Boolean(s.scheduleEnabled);
  $('scheduleTime').value = s.scheduleTime || '09:30';
  $('runOnStartup').checked = Boolean(s.runOnStartup);
  $('catchUpMissed').checked = s.catchUpMissed !== false;
  $('retryOnFailure').checked = s.retryOnFailure !== false;
  $('startDelayMaxMin').value = s.startDelayMaxMin ?? 15;

  $('skipAppOnlyTasks').checked = s.skipAppOnlyTasks !== false;
  $('skipSurpriseTask').checked = s.skipSurpriseTask === true;
  $('maxTaskActions').value = s.maxTaskActions ?? DEFAULT_SETTINGS.maxTaskActions;
  $('maxAttemptsPerTask').value = s.maxAttemptsPerTask ?? DEFAULT_SETTINGS.maxAttemptsPerTask;
  $('pauseMinS').value = Math.round((s.pauseBetweenTasksMinMs ?? 5000) / 1000);
  $('pauseMaxS').value = Math.round((s.pauseBetweenTasksMaxMs ?? 20000) / 1000);
  $('searchQuery').value = s.searchQuery || 'fone bluetooth';
  $('scrollSeconds').value = s.scrollSeconds ?? 10;

  $('device').value = s.device || 'pixel8';
  $('customUA').value = s.customUA || '';
  $('customWidth').value = s.customWidth ?? 412;
  $('customHeight').value = s.customHeight ?? 915;
  $('customFields').classList.toggle('hidden', $('device').value !== 'custom');

  $('keepWindowOpen').checked = s.keepWindowOpen !== false;
  $('silentMode').checked = Boolean(s.silentMode);
  $('notifications').checked = s.notifications !== false;
  $('notifyOnlyOnChange').checked = Boolean(s.notifyOnlyOnChange);
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
    scheduleEnabled: $('scheduleEnabled').checked,
    scheduleTime: $('scheduleTime').value || '09:30',
    runOnStartup: $('runOnStartup').checked,
    catchUpMissed: $('catchUpMissed').checked,
    retryOnFailure: $('retryOnFailure').checked,
    startDelayMaxMin: toInt($('startDelayMaxMin').value, 15),

    skipAppOnlyTasks: $('skipAppOnlyTasks').checked,
    skipSurpriseTask: $('skipSurpriseTask').checked,
    maxTaskActions: toInt($('maxTaskActions').value, DEFAULT_SETTINGS.maxTaskActions),
    maxAttemptsPerTask: toInt($('maxAttemptsPerTask').value, DEFAULT_SETTINGS.maxAttemptsPerTask),
    pauseBetweenTasksMinMs: pauseMinS * 1000,
    pauseBetweenTasksMaxMs: pauseMaxS * 1000,
    searchQuery: $('searchQuery').value.trim() || 'fone bluetooth',
    scrollSeconds: toInt($('scrollSeconds').value, 10),

    device: $('device').value,
    customUA: $('customUA').value.trim(),
    customWidth: toInt($('customWidth').value, 412),
    customHeight: toInt($('customHeight').value, 915),
    keepWindowOpen: $('keepWindowOpen').checked,
    silentMode: $('silentMode').checked,
    notifications: $('notifications').checked,
    notifyOnlyOnChange: $('notifyOnlyOnChange').checked
  };

  try {
    await saveSettings(patch);
  } catch (err) {
    setStatus(`Falha ao salvar: ${err.message}`, 'error');
    return;
  }

  // Reagenda o alarme diário no service worker.
  await chrome.runtime.sendMessage({ type: 'SETTINGS_CHANGED' }).catch(() => {});
  hasUnsavedChanges = false;
  setStatus('Configurações salvas.', 'ok');
  setTimeout(() => {
    if (!hasUnsavedChanges) setStatus('');
  }, 3000);
}

let hasUnsavedChanges = false;

function installDirtyTracking() {
  for (const el of document.querySelectorAll('main input, main select')) {
    if (el.id === 'fileImportJson') continue;
    const markDirty = () => {
      hasUnsavedChanges = true;
      setStatus('Há alterações não salvas — clique em Salvar.', 'warn');
    };
    el.addEventListener('change', markDirty);
    if (el.type === 'text' || el.type === 'number') {
      el.addEventListener('input', markDirty);
    }
  }
}

$('device').addEventListener('change', () => {
  $('customFields').classList.toggle('hidden', $('device').value !== 'custom');
});

$('btnSave').addEventListener('click', save);

$('btnRun').addEventListener('click', async () => {
  setStatus('Iniciando execução…');
  const res = await chrome.runtime.sendMessage({ type: MSG.RUN_NOW }).catch(() => null);
  if (res && res.alreadyRunning) setStatus('Já existe uma execução em andamento.', 'error');
  else setStatus('Execução iniciada. Acompanhe pelo popup da extensão.', 'ok');
});

$('btnOpenWindow').addEventListener('click', async () => {
  setStatus('Abrindo janela mobile…');
  const res = await chrome.runtime.sendMessage({ type: MSG.OPEN_WINDOW }).catch(() => null);
  if (res && res.ok) setStatus('Janela mobile (Pixel 8) aberta.', 'ok');
  else setStatus('Falha ao abrir a janela mobile.', 'error');
});

$('btnClearHistory').addEventListener('click', async () => {
  await patchRuntime({ lastReport: null, history: [] });
  await renderHistory();
  setStatus('Histórico limpo.', 'ok');
});

$('btnRefreshHistory').addEventListener('click', () => {
  renderHistory().catch(() => {});
});

$('btnExportJson').addEventListener('click', async () => {
  try {
    const [settings, runtime] = await Promise.all([getSettings(), getRuntime()]);
    const payload = {
      exportedAt: new Date().toISOString(),
      settings,
      runtime: {
        lastStreak: runtime.lastStreak,
        lastStreakAt: runtime.lastStreakAt,
        lastReport: runtime.lastReport,
        history: runtime.history
      }
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ali-coins-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus('Backup JSON exportado.', 'ok');
  } catch (err) {
    setStatus(`Falha ao exportar: ${err.message}`, 'error');
  }
});

$('btnImportJson').addEventListener('click', () => {
  $('fileImportJson').click();
});

$('fileImportJson').addEventListener('change', async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Arquivo JSON inválido.');
    }
    if (parsed.settings && typeof parsed.settings === 'object') {
      // saveSettings remove campos legados (credenciais/cooldown) de backups antigos.
      await saveSettings({ ...parsed.settings });
      await chrome.runtime.sendMessage({ type: MSG.SETTINGS_CHANGED }).catch(() => {});
    }
    if (parsed.runtime && typeof parsed.runtime === 'object') {
      const rtPatch = {};
      if (Array.isArray(parsed.runtime.history)) rtPatch.history = parsed.runtime.history.slice(0, 20);
      if (parsed.runtime.lastReport && typeof parsed.runtime.lastReport === 'object') {
        rtPatch.lastReport = parsed.runtime.lastReport;
      }
      if (Number.isFinite(parsed.runtime.lastStreak)) {
        rtPatch.lastStreak = parsed.runtime.lastStreak;
      }
      if (Object.keys(rtPatch).length > 0) await patchRuntime(rtPatch);
    }
    await load();
    await renderHistory();
    hasUnsavedChanges = false;
    setStatus('Backup JSON importado com sucesso.', 'ok');
  } catch (err) {
    setStatus(`Falha ao importar JSON: ${err.message}`, 'error');
  }
});

load()
  .then(() => {
    installDirtyTracking();
    return renderHistory();
  })
  .catch((err) => setStatus(`Falha ao carregar opções: ${err.message}`, 'error'));
