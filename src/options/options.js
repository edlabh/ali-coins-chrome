/**
 * Página de opções: credenciais, agendamento, tarefas, captcha e aparelho.
 */
import { MSG } from '../common/constants.js';
import { getSettings, saveSettings, clearCredentials, patchRuntime } from '../background/storage.js';

const $ = (id) => document.getElementById(id);

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
  setStatus('Histórico e cooldown limpos.', 'ok');
});

load().catch((err) => setStatus(`Falha ao carregar opções: ${err.message}`, 'error'));
