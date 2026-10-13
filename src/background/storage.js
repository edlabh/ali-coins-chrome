/**
 * Camada de persistência do background service worker.
 *  - settings: chrome.storage.local (senha cifrada via WebCrypto quando possível)
 *  - runtime: chrome.storage.local (último relatório, histórico, próximo run, cooldown)
 *  - runState: chrome.storage.session (estado vivo da execução; sobrevive a reinícios do SW)
 */

import { DEFAULT_SETTINGS, RUN_HISTORY_LIMIT } from '../common/constants.js';
import { encryptText, decryptText } from '../common/crypt.js';

const SETTINGS_KEY = 'settings';
const RUNTIME_KEY = 'runtime';
const RUN_STATE_KEY = 'runState';

/**
 * Lê as configurações mescladas com os defaults.
 * @returns {Promise<object>}
 */
export async function getSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
}

/**
 * Salva um patch de configurações. O campo `password` (texto puro) é cifrado e removido.
 * @param {object} patch
 * @returns {Promise<object>} settings atualizadas
 */
export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };

  if (typeof patch.password === 'string' && patch.password.length > 0) {
    const enc = await encryptText(patch.password);
    if (enc) {
      next.passwordEnc = enc;
      next.passwordPlain = '';
      next.cryptoOk = true;
    } else {
      next.passwordEnc = null;
      next.passwordPlain = patch.password;
      next.cryptoOk = false;
    }
  }
  delete next.password;

  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/**
 * Recupera a senha em texto puro (apenas em memória do SW, nunca logada).
 * @param {object} [settings]
 * @returns {Promise<string>}
 */
export async function getPassword(settings) {
  const s = settings || (await getSettings());
  if (s.passwordEnc) {
    const dec = await decryptText(s.passwordEnc);
    if (dec) return dec;
  }
  return s.passwordPlain || '';
}

/**
 * Limpa credenciais salvas.
 */
export async function clearCredentials() {
  await saveSettings({ user: '', passwordEnc: null, passwordPlain: '' });
}

/**
 * Estado de runtime (relatórios, agenda, cooldown anti-bot).
 * @returns {Promise<{lastReport?: object|null, history?: object[], nextRunAt?: number|null, blockedUntil?: number|null, lastReadyAt?: number|null}>}
 */
export async function getRuntime() {
  const data = await chrome.storage.local.get(RUNTIME_KEY);
  return {
    lastReport: null,
    history: [],
    nextRunAt: null,
    blockedUntil: null,
    lastReadyAt: null,
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

/**
 * Estado vivo da execução.
 * @returns {Promise<object|null>}
 */
export async function getRunState() {
  const data = await chrome.storage.session.get(RUN_STATE_KEY);
  return data[RUN_STATE_KEY] || null;
}

/**
 * Mescla um patch no run state.
 * @param {object|null} patch — null limpa o estado
 */
export async function patchRunState(patch) {
  if (patch === null) {
    await chrome.storage.session.remove(RUN_STATE_KEY);
    return null;
  }
  const current = (await getRunState()) || {};
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await chrome.storage.session.set({ [RUN_STATE_KEY]: next });
  return next;
}
