/**
 * Ponte de mensagens entre o service worker e as ações na página.
 * Comandos são curtos e idempotentes; a orquestração vive no background.
 */
(function () {
  'use strict';

  const AC = self.AC;
  if (!AC || !AC.actions) return;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const type = message && message.type;
    const payload = (message && message.payload) || {};

    // Um novo runId zera o flag de cancelamento deixado por um run anterior.
    if (payload.runId && payload.runId !== AC.state.runId) {
      AC.state.runId = payload.runId;
      AC.state.stopRequested = false;
    }

    (async () => {
      switch (type) {
        case 'ABORT':
          AC.state.stopRequested = true;
          return { ok: true };

        case 'DO_LOGIN':
          return await AC.actions.doLogin(payload);
        case 'WAIT_CAPTCHA':
          return await AC.actions.waitCaptcha(payload);
        case 'WAIT_2FA':
          return await AC.actions.wait2FA(payload);
        case 'DO_CHECKIN':
          return await AC.actions.doCheckin();
        case 'READ_BALANCE':
          return AC.actions.readBalance();
        case 'OPEN_DRAWER':
          return await AC.actions.openDrawer();
        case 'EXTRACT_TASKS':
          return AC.actions.extractTasks();
        case 'CLICK_TASK':
          return AC.actions.clickTask(payload);
        case 'RUN_ACTION':
          return await AC.actions.runAction(payload);

        default:
          return { error: `Comando desconhecido: ${type}` };
      }
    })()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ error: err && err.message ? err.message : String(err) }));

    // Mantém o canal aberto para a resposta assíncrona.
    return true;
  });

  // Marca a aba como "aba de execução" para o spoof de navigator do MAIN world
  // (src/content/main-world.js). Duas fontes:
  //  1) hash `#ac_run=1` presente na navegação inicial disparada pelo runner;
  //  2) confirmação do service worker na resposta ao CONTENT_READY.
  function markRunTab() {
    try {
      sessionStorage.setItem('ac_run', '1');
    } catch {
      /* sessionStorage indisponível: o hash cobre a primeira navegação */
    }
  }

  try {
    if (location.hash && location.hash.indexOf('ac_run') !== -1) {
      markRunTab();
      // Remove o marcador da URL (o SPA reescreve a location logo em seguida).
      try {
        history.replaceState(null, '', location.pathname + location.search);
      } catch {
        /* SPA sem history API: mantém o hash, inofensivo */
      }
    }
  } catch {
    /* ignora */
  }

  // Anuncia a presença do content script e confirma se esta é a aba de execução.
  try {
    chrome.runtime
      .sendMessage({ type: 'CONTENT_READY', payload: { url: location.href } })
      .then((res) => {
        if (res && res.runTab) markRunTab();
      })
      .catch(() => {});
  } catch {
    // runtime indisponível (ex.: contexto invalidado): ignora
  }
})();
