/**
 * Gates de intervenção do usuário (captcha e 2FA) e o wrapper de comandos que
 * os utiliza de forma transparente.
 */

import { CMD, PHASE } from '../common/constants.js';
import {
  RunAbortedError,
  RunBlockedError,
  appendLog,
  cmd,
  isStopRequestedNow,
  updatePhase
} from './context.js';
import { focusWindow } from './tabs.js';
import { notifyCaptcha, setBadge } from './notify.js';
import { patchRunState } from './storage.js';

/**
 * Gate de captcha: foca a janela, notifica o usuário e aguarda a resolução
 * (em fatias de 60s para não estourar limites de mensagem).
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

  const deadline = Date.now() + ctx.settings.captchaTimeoutMin * 60 * 1000;
  while (Date.now() < deadline) {
    if (await isStopRequestedNow()) throw new RunAbortedError();
    const remaining = deadline - Date.now();
    const chunkMs = Math.min(60000, Math.max(5000, remaining));
    const res = await cmd(ctx, CMD.WAIT_CAPTCHA, { chunkMs, origin }, { retries: 2 });
    await patchRunState({}).catch(() => {}); // heartbeat anti-stale
    if (res.solved) {
      await setBadge('RUN', 'run');
      await appendLog(ctx, 'Captcha resolvido — retomando a automação.');
      return;
    }
    if (res.blocked) {
      await appendLog(ctx, 'Bloqueio anti-bot (RGV587) detectado — pausando por precaução.');
      throw new RunBlockedError(
        'O AliExpress exibiu um bloqueio de risco (RGV587/verificação de segurança). Execuções pausadas por precaução.'
      );
    }
    // res.still === true: continua aguardando
  }
  throw new Error(
    `Tempo esgotado (${ctx.settings.captchaTimeoutMin} min) aguardando a resolução do captcha.`
  );
}

/**
 * Gate de 2FA: o usuário digita o código na própria janela; aguardamos a conclusão.
 */
export async function twoFAGate(ctx) {
  await updatePhase(PHASE.TWO_FA, 'Digite o código de verificação 2FA na janela aberta…');
  await appendLog(ctx, 'Verificação 2FA solicitada — aguardando o código na janela mobile.');
  await focusWindow(ctx.windowId, ctx.tabId);
  const deadline = Date.now() + ctx.settings.captchaTimeoutMin * 60 * 1000;
  while (Date.now() < deadline) {
    if (await isStopRequestedNow()) throw new RunAbortedError();
    const res = await cmd(ctx, CMD.WAIT_2FA, { chunkMs: 60000 }, { retries: 2 });
    await patchRunState({}).catch(() => {}); // heartbeat anti-stale
    if (res.ok) {
      await appendLog(ctx, '2FA concluído — retomando a automação.');
      return;
    }
  }
  throw new Error('Tempo esgotado aguardando o código 2FA.');
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
