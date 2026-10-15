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
 * Login manual obrigatório: a extensão NÃO aguarda o login. Registra o erro
 * acionável, traz a tela de login para o primeiro plano, notifica e encerra a
 * execução — o usuário entra no AliExpress e executa a extensão novamente.
 * Marca `ctx.manualLoginRequired` para a política de janela PRESERVAR a tela
 * de login ao fim do run (ela seria fechada junto com a aba/janela normal).
 * @param {object} ctx
 * @returns {Promise<{ok: false, manualLogin: true, error: string}>}
 */
export async function requireManualLogin(ctx) {
  const message =
    'Login manual necessário: o AliExpress não está logado. Faça login na tela trazida para frente e execute a extensão novamente.';
  ctx.manualLoginRequired = true;
  await updatePhase(PHASE.AUTH, 'Login manual necessário — faça login e execute novamente.');
  await appendLog(ctx, `⚠ ${message}`);
  if (ctx.settings.silentMode) {
    await appendLog(ctx, 'Modo silencioso: trazendo a tela de login para frente.');
  }
  await focusWindow(ctx.windowId, ctx.tabId);
  await notify(ctx.settings, {
    id: 'ali-coins-manual-login',
    title: MANUAL_LOGIN_NOTIFICATION.title,
    message: MANUAL_LOGIN_NOTIFICATION.message,
    requireInteraction: true
  });
  return { ok: false, manualLogin: true, error: message };
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
