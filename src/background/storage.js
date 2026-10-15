/**
 * Camada de persistência do background service worker.
 *  - settings: chrome.storage.local (sem credenciais: o login é 100% manual)
 *  - runtime: chrome.storage.local (último relatório, histórico, próximo run)
 *  - runState: chrome.storage.session (estado vivo da execução; sobrevive a reinícios do SW)
 */

import { DEFAULT_SETTINGS, RUN_HISTORY_LIMIT } from '../common/constants.js';
import { migrateSettings, SETTINGS_VERSION } from '../common/state-utils.js';

const SETTINGS_KEY = 'settings';
const RUNTIME_KEY = 'runtime';
const RUN_STATE_KEY = 'runState';

/**
 * Lê as configurações mescladas com os defaults, aplicando migrações de versão
 * (uma única vez, persistindo o resultado).
 * @returns {Promise<object>}
 */
export async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  const { settings: migrated, changed } = migrateSettings(data[SETTINGS_KEY]);
  const merged = { ...DEFAULT_SETTINGS, ...migrated };
  if (changed) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
  }
  return merged;
}

// Campos que versões antigas gravavam e que NÃO existem mais (login por
// credenciais, tempo máx. de captcha, cooldown anti-bot). São removidos em
// qualquer gravação — inclusive importações de backup antigo — para nunca
// ressuscitarem no armazenamento.
const LEGACY_SETTINGS_KEYS = [
  'user',
  'password',
  'passwordEnc',
  'passwordPlain',
  'cryptoOk',
  'captchaTimeoutMin',
  'riskCooldownHours'
];

/**
 * Salva um patch de configurações (mesclado com as atuais).
 * @param {object} patch
 * @returns {Promise<object>} settings atualizadas
 */
export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };

  for (const key of LEGACY_SETTINGS_KEYS) delete next[key];
  next.settingsVersion = SETTINGS_VERSION;

  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/**
 * Estado de runtime (relatórios, agenda).
 * @returns {Promise<{lastReport?: object|null, history?: object[], nextRunAt?: number|null, lastReadyAt?: number|null}>}
 */
export async function getRuntime() {
  const data = await chrome.storage.local.get(RUNTIME_KEY);
  return {
    lastReport: null,
    history: [],
    nextRunAt: null,
    lastReadyAt: null,
    lastStreak: null,
    lastStreakAt: null,
    ...(data[RUNTIME_KEY] || {})
  };
}

/**
 * Mescla um patch no runtime.
 * @param {object} patch
 */
export async function patchRuntime(patch) {
  const current = await getRuntime();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [RUNTIME_KEY]: next });
  return next;
}

/**
 * Aplica um relatório final no histórico (limite de RUN_HISTORY_LIMIT).
 * @param {object} report
 */
export async function pushReport(report) {
  const current = await getRuntime();
  const history = [report, ...(current.history || [])].slice(0, RUN_HISTORY_LIMIT);
  await patchRuntime({ lastReport: report, history });
}

// Fila serializada para evitar race conditions em read-modify-write concorrentes
// (ex.: heartbeat + appendLog + onActivated ao mesmo tempo).
let runStateChain = Promise.resolve();

/**
 * Estado vivo da execução.
 * @returns {Promise<object|null>}
 */
export async function getRunState() {
  await runStateChain.catch(() => {});
  const data = await chrome.storage.session.get(RUN_STATE_KEY);
  return data[RUN_STATE_KEY] || null;
}

/**
 * Mescla um patch no run state de forma atômica/serializada.
 * @param {object|null} patch — null limpa o estado
 */
export function patchRunState(patch) {
  const op = runStateChain.then(async () => {
    if (patch === null) {
      await chrome.storage.session.remove(RUN_STATE_KEY);
      return null;
    }
    const data = await chrome.storage.session.get(RUN_STATE_KEY);
    const current = data[RUN_STATE_KEY] || {};
    const next = { ...current, ...patch, updatedAt: Date.now() };
    await chrome.storage.session.set({ [RUN_STATE_KEY]: next });
    return next;
  });
  runStateChain = op.catch(() => {});
  return op;
}
