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

  // Anuncia a presença do content script (útil para diagnóstico).
  try {
    chrome.runtime
      .sendMessage({ type: 'CONTENT_READY', payload: { url: location.href } })
      .catch(() => {});
  } catch {
    // runtime indisponível (ex.: contexto invalidado): ignora
  }
})();
