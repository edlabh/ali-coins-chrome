/**
 * Spoof de navigator para a ABA DE EXECUÇÃO (MAIN world, document_start).
 *
 * Por que existe: o declarativeNetRequest reescreve apenas o header User-Agent da
 * rede — o JavaScript da página continua enxergando o navegador desktop em
 * `navigator.userAgent`, `navigator.userAgentData`, `navigator.maxTouchPoints`,
 * etc. Como o AliExpress decide layout/serviços também no client-side, sem este
 * spoof a página pode renderizar a variante desktop mesmo com o header correto.
 *
 * Escopo: os getters só devolvem valores mobile quando a aba está marcada como
 * aba de execução — sessionStorage `ac_run` = `1` (persiste entre navegações da
 * mesma aba) ou hash `#ac_run` presente na navegação inicial. Nas demais abas do
 * usuário o comportamento é 100% preservado (fallback para os getters originais).
 */
(function () {
  'use strict';

  if (typeof navigator === 'undefined' || typeof location === 'undefined') return;

  var UA =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
  var APP_VERSION =
    '5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';

  function isRunTab() {
    try {
      if (self.sessionStorage && self.sessionStorage.getItem('ac_run') === '1') return true;
    } catch (err) {
      /* sessionStorage bloqueado */
    }
    try {
      if (location.hash && location.hash.indexOf('ac_run') !== -1) return true;
    } catch (err) {
      /* sem hash */
    }
    return false;
  }

  var proto = null;
  try {
    proto = Object.getPrototypeOf(navigator);
  } catch (err) {
    proto = null;
  }
  if (!proto) return;

  function original(prop) {
    try {
      return Object.getOwnPropertyDescriptor(proto, prop) || null;
    } catch (err) {
      return null;
    }
  }

  function define(prop, getter) {
    try {
      // Configurável para nunca tornar o objeto mais restrito que o original.
      Object.defineProperty(proto, prop, { get: getter, configurable: true });
    } catch (err) {
      /* propriedade não configurável: mantém o valor original */
    }
  }

  function fallback(desc, thisArg) {
    if (!desc) return undefined;
    if (desc.get) return desc.get.call(thisArg);
    return desc.value;
  }

  var origUA = original('userAgent');
  define('userAgent', function () {
    return isRunTab() ? UA : fallback(origUA, this);
  });

  var origAppVersion = original('appVersion');
  define('appVersion', function () {
    return isRunTab() ? APP_VERSION : fallback(origAppVersion, this);
  });

  var origPlatform = original('platform');
  define('platform', function () {
    return isRunTab() ? 'Linux armv8l' : fallback(origPlatform, this);
  });

  var origVendor = original('vendor');
  define('vendor', function () {
    return isRunTab() ? 'Google Inc.' : fallback(origVendor, this);
  });

  var origTouchPoints = original('maxTouchPoints');
  define('maxTouchPoints', function () {
    return isRunTab() ? 5 : fallback(origTouchPoints, this);
  });

  var origUAD = original('userAgentData');
  var fakeUAD = null;

  function buildFakeUAD() {
    var brands = [
      { brand: 'Chromium', version: '140' },
      { brand: 'Google Chrome', version: '140' },
      { brand: 'Not_A Brand', version: '24' }
    ];
    var fullVersionList = [
      { brand: 'Chromium', version: '140.0.0.0' },
      { brand: 'Google Chrome', version: '140.0.0.0' },
      { brand: 'Not_A Brand', version: '24.0.0.0' }
    ];
    return {
      brands: brands,
      mobile: true,
      platform: 'Android',
      getHighEntropyValues: function () {
        return Promise.resolve({
          architecture: '',
          bitness: '',
          brands: brands,
          fullVersionList: fullVersionList,
          mobile: true,
          model: 'Pixel 8',
          platform: 'Android',
          platformVersion: '14.0.0',
          uaFullVersion: '140.0.0.0'
        });
      },
      toJSON: function () {
        return { brands: brands, mobile: true, platform: 'Android' };
      }
    };
  }

  define('userAgentData', function () {
    if (!isRunTab()) return fallback(origUAD, this);
    if (!fakeUAD) fakeUAD = buildFakeUAD();
    return fakeUAD;
  });
})();
