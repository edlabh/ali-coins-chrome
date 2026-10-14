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
const scriptInjectedTabs = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const NEW_DOC_STEALTH_SCRIPT = `
(function () {
  try {
    self.__acRunTab = true;
    if (self.sessionStorage) self.sessionStorage.setItem('ac_run', '1');
  } catch (e) {
    self.__acRunTab = true;
  }
  try {
    self.open = function (url) {
      if (url && typeof url === 'string' && url !== 'about:blank' && !/^javascript:/i.test(url)) {
        try { location.assign(url); } catch (e) {}
      }
      return self;
    };
  } catch (e) {}
  try {
    if (typeof Element !== 'undefined' && Element.prototype && Element.prototype.setAttribute) {
      var origSetAttr = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function (name, value) {
        if (typeof name === 'string' && name.toLowerCase() === 'target' && typeof value === 'string' && value.toLowerCase() !== '_self') {
          return origSetAttr.call(this, name, '_self');
        }
        return origSetAttr.call(this, name, value);
      };
    }
  } catch (e) {}
  try {
    if (typeof HTMLAnchorElement !== 'undefined' && HTMLAnchorElement.prototype) {
      var desc = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, 'target');
      if (desc && desc.set) {
        Object.defineProperty(HTMLAnchorElement.prototype, 'target', {
          configurable: true,
          enumerable: true,
          get: function () { return '_self'; },
          set: function () { desc.set.call(this, '_self'); }
        });
      }
      if (HTMLAnchorElement.prototype.click) {
        var origClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          try { this.setAttribute('target', '_self'); } catch (e) {}
          return origClick.apply(this, arguments);
        };
      }
    }
  } catch (e) {}
})();
`;

/**
 * Garante que a aba anexada tenha o script de bloqueio de novas abas injetado
 * antes de qualquer documento/subdomínio carregar.
 * @param {number} tabId
 */
async function ensureNewDocScript(tabId) {
  if (scriptInjectedTabs.has(tabId)) return;
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
    await chrome.debugger.sendCommand({ tabId }, 'Page.addScriptToEvaluateOnNewDocument', {
      source: NEW_DOC_STEALTH_SCRIPT
    });
    scriptInjectedTabs.add(tabId);
  } catch {
    // Melhor esforço.
  }
}

/**
 * Anexa o depurador à aba (idempotente). Retorna false quando indisponível
 * (ex.: DevTools aberto na aba ou aviso de depuração cancelado).
 * @param {number} tabId
 * @returns {Promise<boolean>}
 */
export async function attachCdp(tabId) {
  if (attachedTabs.has(tabId)) {
    await ensureNewDocScript(tabId);
    return true;
  }
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
    attachedTabs.add(tabId);
    await ensureNewDocScript(tabId);
    return true;
  } catch {
    // Já anexado por este SW antes de um restart, ou anexado por outro cliente:
    // confirma via getTargets antes de desistir.
    try {
      const targets = await chrome.debugger.getTargets();
      const target = targets.find((t) => t.tabId === tabId && t.attached);
      if (target) {
        attachedTabs.add(tabId);
        await ensureNewDocScript(tabId);
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
  scriptInjectedTabs.delete(tabId);
}

/**
 * Desanexa o depurador (best-effort).
 * @param {number} tabId
 */
export async function detachCdp(tabId) {
  attachedTabs.delete(tabId);
  scriptInjectedTabs.delete(tabId);
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
    await send('Emulation.setUserAgentOverride', {
      userAgent: device.userAgent,
      platform: 'Linux armv8l'
    }).catch(() => {});
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
