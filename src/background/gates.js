/**
 * Gates de intervenção do usuário (captcha, 2FA e login manual) e o wrapper de
 * comandos que os utiliza de forma transparente.
 */

import { CMD, MANUAL_LOGIN_NOTIFICATION, PHASE } from '../common/constants.js';
import {
  RunAbortedError,
  RunBlockedError,
  appendLog,
  cmd,
  isStopRequestedNow,
  sleepAbortable,
  updatePhase
} from './context.js';
import { focusWindow, restoreBackgroundFocus } from './tabs.js';
import { notify, notifyCaptcha, setBadge } from './notify.js';
import { patchRunState } from './storage.js';

/**
 * Gate de captcha: foca a janela, notifica o usuário e aguarda a resolução
 * (em fatias de 60s para não estourar limites de mensagem). Sem tempo máximo:
 * resolve ou pare pelo popup — o campo de tempo foi removido das Opções.
 */
export async function captchaGate(ctx, origin) {
  ctx.stats.captchaEvents += 1;
  await updatePhase(PHASE.CAPTCHA, 'Aguardando você resolver o captcha na janela aberta…');
  await appendLog(ctx, 'Captcha detectado — aguardando a resolução na janela mobile.');
  if (ctx.settings.silentMode) {
    await appendLog(ctx, 'Modo silencioso: trazendo a aba de execução para frente para você resolver.');
  }
  await focusWindow(ctx.windowId, ctx.tabId);
  await notifyCaptcha(ctx.settings);

  for (;;) {
    if (await isStopRequestedNow()) throw new RunAbortedError();
    const res = await cmd(ctx, CMD.WAIT_CAPTCHA, { chunkMs: 60000, origin }, { retries: 2 });
    await patchRunState({}).catch(() => {}); // heartbeat anti-stale
    if (res.solved) {
      await setBadge('RUN', 'run');
      await appendLog(ctx, 'Captcha resolvido — retomando a automação.');
      if (ctx.settings.silentMode) {
        await restoreBackgroundFocus(ctx.windowId, ctx.tabId, ctx.userTabId);
      }
      return;
    }
    if (res.blocked) {
      await appendLog(ctx, 'Bloqueio anti-bot (RGV587) detectado — encerrando a execução por precaução.');
      throw new RunBlockedError(
        'O AliExpress exibiu um bloqueio de risco (RGV587/verificação de segurança). Execução encerrada por precaução.'
      );
    }
    // res.still === true: continua aguardando (sem limite de tempo)
  }
}

/**
 * Gate de 2FA: o usuário digita o código na própria janela; aguardamos a
 * conclusão sem limite de tempo (pare pelo popup para cancelar).
 */
export async function twoFAGate(ctx) {
  await updatePhase(PHASE.TWO_FA, 'Digite o código de verificação 2FA na janela aberta…');
  await appendLog(ctx, 'Verificação 2FA solicitada — aguardando o código na janela mobile.');
  await focusWindow(ctx.windowId, ctx.tabId);
  for (;;) {
    if (await isStopRequestedNow()) throw new RunAbortedError();
    const res = await cmd(ctx, CMD.WAIT_2FA, { chunkMs: 60000 }, { retries: 2 });
    await patchRunState({}).catch(() => {}); // heartbeat anti-stale
    if (res.ok) {
      await appendLog(ctx, '2FA concluído — retomando a automação.');
      if (ctx.settings.silentMode) {
        await restoreBackgroundFocus(ctx.windowId, ctx.tabId, ctx.userTabId);
      }
      return;
    }
  }
}

/**
 * Valor do cookie de sessão do AliExpress (login_aliyunid_ticket), ou null.
 * Serve para detectar login feito em OUTRA aba do navegador: os cookies são do
 * perfil, então a sessão muda mesmo que a aba do run ainda mostre o formulário.
 * Sem a permissão `cookies` (ou erro), retorna null e o DOM é o único sinal.
 * @returns {Promise<string|null>}
 */
async function loginTicket() {
  try {
    const cookie = await chrome.cookies.get({
      url: 'https://www.aliexpress.com/',
      name: 'login_aliyunid_ticket'
    });
    return cookie && cookie.value ? cookie.value : null;
  } catch {
    return null;
  }
}

/**
 * Gate de login MANUAL: não há mais login por credenciais. Traz a janela/aba
 * do AliExpress para frente, avisa por notificação + relatório e aguarda o
 * usuário entrar (na própria aba ou em qualquer aba do navegador — a sessão é
 * do perfil). A automação continua sozinha após o login. Captcha/2FA que
 * aparecerem no meio do login são tratados pelos gates correspondentes.
 */
export async function manualLoginGate(ctx) {
  await updatePhase(PHASE.AUTH, 'Login manual necessário: entre no AliExpress na janela aberta…');
  await appendLog(
    ctx,
    '⚠ Login manual necessário: faça login no AliExpress (na janela aberta ou em qualquer aba do navegador). A automação continua automaticamente após o login.'
  );
  if (ctx.settings.silentMode) {
    await appendLog(ctx, 'Modo silencioso: trazendo a aba de execução para frente para você fazer o login.');
  }
  await focusWindow(ctx.windowId, ctx.tabId);
  await notify(ctx.settings, {
    id: 'ali-coins-manual-login',
    title: MANUAL_LOGIN_NOTIFICATION.title,
    message: MANUAL_LOGIN_NOTIFICATION.message,
    requireInteraction: true
  });

  // Linha de base do cookie: só conta como "login detectado" quando o ticket
  // APARECE ou MUDA de valor durante o gate (um ticket antigo/stale não pode
  // liberar a automação — nesse caso o DOM da aba continua sendo a verdade).
  const ticketAtStart = await loginTicket();

  for (;;) {
    if (await isStopRequestedNow()) throw new RunAbortedError();
    let st;
    try {
      st = await cmd(ctx, CMD.CHECK_AUTH, {}, { retries: 2 });
    } catch {
      // Página em transição (login navegou/pendente): aguarda e repete.
      await sleepAbortable(3000);
      continue;
    }
    await patchRunState({}).catch(() => {}); // heartbeat anti-stale
    if (st.state === 'logged_in') {
      await appendLog(ctx, 'Login manual concluído — retomando a automação.');
      if (ctx.settings.silentMode) {
        await restoreBackgroundFocus(ctx.windowId, ctx.tabId, ctx.userTabId);
      }
      return;
    }
    if (st.state === 'captcha') {
      await captchaGate(ctx, 'login-manual');
      continue;
    }
    if (st.state === 'two_fa') {
      await twoFAGate(ctx);
      continue;
    }

    // Login pode ter sido feito em OUTRA aba (cookie do perfil mudou) enquanto
    // esta aba ainda mostra o formulário: a central será recarregada depois.
    const ticketNow = await loginTicket();
    if (ticketNow && (ticketAtStart === null || ticketNow !== ticketAtStart)) {
      await appendLog(
        ctx,
        'Login detectado no navegador (sessão atualizada) — recarregando a central de moedas.'
      );
      if (ctx.settings.silentMode) {
        await restoreBackgroundFocus(ctx.windowId, ctx.tabId, ctx.userTabId);
      }
      return;
    }

    // 'needs_login'/'pending': continua aguardando o login do usuário.
    await sleepAbortable(3000);
  }
}

/**
 * Executa um comando tratando interrupções de captcha de forma transparente:
 * se a página indicar captcha, abre o gate e repete o comando (até 3 vezes).
 */
export async function commandWithCaptcha(ctx, type, payload = {}, label = '') {
  for (let i = 0; i < 4; i += 1) {
    if (await isStopRequestedNow()) throw new RunAbortedError();
    const res = await cmd(ctx, type, payload, { retries: 3 });
    if (res && res.needsCaptcha) {
      await captchaGate(ctx, label);
      continue;
    }
    return res;
  }
  throw new Error(`Comando ${type} interrompido repetidamente por captcha.`);
}
