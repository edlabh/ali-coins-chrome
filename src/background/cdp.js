/**
 * Cliques "de verdade" via Chrome DevTools Protocol (chrome.debugger).
 *
 * Por que existe: eventos sintéticos disparados por content script têm
 * `isTrusted === false` e alguns SPAs (como a central de moedas do AliExpress)
 * ignoram-nos. `Input.dispatchMouseEvent` entrega um clique REAL do navegador,
 * nas coordenadas do viewport — equivalente ao que o Playwright faz no projeto
 * ali-coins. O Chrome exibe um aviso de depuração na janela de execução; se o
 * usuário cancelar, a extensão cai no fallback sintético automaticamente.
 *
 * O content script solicita o clique via mensagem TRUSTED_CLICK; o service
 * worker resolve a aba pelo `sender.tab.id` e executa aqui.
 */

import { pickDevice } from '../common/constants.js';

const CDP_VERSION = '1.3';
const attachedTabs = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Anexa o depurador à aba (idempotente). Retorna false quando indisponível
 * (ex.: DevTools aberto na aba ou aviso de depuração cancelado).
 * @param {number} tabId
 * @returns {Promise<boolean>}
 */
export async function attachCdp(tabId) {
  if (attachedTabs.has(tabId)) return true;
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
    attachedTabs.add(tabId);
    return true;
  } catch {
    // Já anexado por este SW antes de um restart, ou anexado por outro cliente:
    // confirma via getTargets antes de desistir.
    try {
      const targets = await chrome.debugger.getTargets();
      const target = targets.find((t) => t.tabId === tabId && t.attached);
      if (target) {
        attachedTabs.add(tabId);
        return true;
      }
    } catch {
      // segue para o retorno false
    }
    return false;
  }
}

/**
 * Remove a aba do conjunto local (usado no evento onDetach).
 * @param {number} tabId
 */
export function forgetCdp(tabId) {
  attachedTabs.delete(tabId);
}

/**
 * Desanexa o depurador (best-effort).
 * @param {number} tabId
 */
export async function detachCdp(tabId) {
  attachedTabs.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Não anexado/janela fechada: ignora.
  }
}

/**
 * Modo silencioso: aplica a emulação de viewport do aparelho (Pixel 8) na aba
 * de fundo via CDP — o layout renderiza em 412×915 mesmo com a aba oculta em
 * uma janela desktop, e o toque é habilitado. Também emula o foco para que a
 * página não se comporte como "não visível". Efeitos são revertidos ao
 * desanexar o depurador.
 * @param {number} tabId
 * @param {object} settings
 * @returns {Promise<boolean>}
 */
export async function applySilentEmulation(tabId, settings) {
  const attached = await attachCdp(tabId);
  if (!attached) return false;

  const device = pickDevice(settings);
  const send = (method, params) => chrome.debugger.sendCommand({ tabId }, method, params);

  try {
    await send('Emulation.setDeviceMetricsOverride', {
      width: device.width,
      height: device.height,
      deviceScaleFactor: device.scaleFactor || 2.625,
      mobile: true,
      screenWidth: device.width,
      screenHeight: device.height
    });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Aplica um clique real (mouse move + press + release) nas coordenadas do
 * viewport da aba. O clique é "trusted" (isTrusted === true).
 * @param {number} tabId
 * @param {number} x
 * @param {number} y
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function clickTrusted(tabId, x, y) {
  const attached = await attachCdp(tabId);
  if (!attached) return { ok: false, error: 'debugger-indisponivel' };

  const send = (method, params) => chrome.debugger.sendCommand({ tabId }, method, params);

  try {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1
    });
    await sleep(45);
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}
