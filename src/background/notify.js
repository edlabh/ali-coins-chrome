/**
 * Badge e notificações do navegador.
 */

import { CAPTCHA_NOTIFICATION } from '../common/constants.js';

const BADGE_COLORS = {
  run: '#f97316',
  captcha: '#dc2626',
  ok: '#16a34a',
  error: '#991b1b',
  idle: '#6b7280'
};

/**
 * Atualiza o badge da extensão.
 * @param {string} text
 * @param {'run'|'captcha'|'ok'|'error'|'idle'} [kind='run']
 */
export async function setBadge(text, kind = 'run') {
  try {
    await chrome.action.setBadgeText({ text: text || '' });
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLORS[kind] || BADGE_COLORS.run });
  } catch {
    // action pode não estar pronta (SW frio): ignora.
  }
}

/**
 * Mostra uma notificação do sistema (se permitido nas configurações).
 * @param {object} settings
 * @param {{id?: string, title: string, message: string, requireInteraction?: boolean}} payload
 */
export async function notify(settings, payload) {
  if (settings && settings.notifications === false) return;
  try {
    await chrome.notifications.create(payload.id || `ali-coins-${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: payload.title,
      message: payload.message,
      requireInteraction: Boolean(payload.requireInteraction),
      silent: false
    });
  } catch {
    // Notificações podem estar desabilitadas pelo SO: segue o jogo.
  }
}

/**
 * Notificação de captcha com clique levando à janela de execução.
 * @param {object} settings
 */
export async function notifyCaptcha(settings) {
  await setBadge('CAPTCHA', 'captcha');
  await notify(settings, {
    id: 'ali-coins-captcha',
    title: CAPTCHA_NOTIFICATION.title,
    message: CAPTCHA_NOTIFICATION.message,
    requireInteraction: true
  });
}

export async function notifyResult(settings, ok, message) {
  await setBadge(ok ? '✓' : '!', ok ? 'ok' : 'error');
  await notify(settings, {
    title: ok ? 'Ali Coins: execução concluída' : 'Ali Coins: falha na execução',
    message
  });
}
