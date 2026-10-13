/**
 * Autenticação: verificação de sessão e login automático quando necessário.
 */

import { CMD, PHASE } from '../common/constants.js';
import {
  RunAbortedError,
  appendLog,
  cmd,
  isStopRequestedNow,
  sleepAbortable,
  updatePhase
} from './context.js';
import { captchaGate, twoFAGate } from './gates.js';
import { notify } from './notify.js';
import { getPassword } from './storage.js';

/**
 * Garante que a sessão está autenticada SEM tentar login desnecessário:
 *   1. consulta o estado da página (CHECK_AUTH — somente leitura);
 *   2. só dispara o fluxo de login quando há formulário/prompt de login visível;
 *   3. UI indecisa por muito tempo → prossegue como sessão existente, deixando
 *      o check-in validar (auto-cura autentica se a página for de login).
 * @param {object} ctx
 * @returns {Promise<{ok: boolean, already?: boolean, assumed?: boolean, error?: string}>}
 */
export async function ensureAuthenticated(ctx) {
  await updatePhase(PHASE.AUTH, 'Verificando se a sessão do AliExpress já está ativa…');

  const deadline = Date.now() + 25000;
  let sawLoginForm = false;
  while (Date.now() < deadline) {
    if (await isStopRequestedNow()) throw new RunAbortedError();

    let st;
    try {
      st = await cmd(ctx, CMD.CHECK_AUTH, {}, { retries: 3 });
    } catch {
      // Página em transição (content script ainda não pronto): aguarda e repete.
      await sleepAbortable(1200);
      continue;
    }

    if (st.state === 'captcha') {
      await captchaGate(ctx, 'auth-check');
      continue;
    }
    if (st.state === 'two_fa') {
      await twoFAGate(ctx);
      continue;
    }
    if (st.state === 'logged_in') {
      await updatePhase(PHASE.AUTH, 'Sessão do AliExpress já autenticada; login dispensado.');
      await appendLog(ctx, 'Sessão já autenticada — login dispensado.');
      return { ok: true, already: true };
    }
    if (st.state === 'needs_login') {
      sawLoginForm = true;
      break;
    }
    // 'pending': esqueleto do SPA ainda carregando.
    await sleepAbortable(1800);
  }

  if (!sawLoginForm) {
    // UI não decidiu em 25s (sem formulário e sem central de moedas visíveis):
    // prossegue como sessão existente — o check-in valida de fato e a auto-cura
    // autentica (ou pede credenciais) se a página for de login.
    await updatePhase(PHASE.AUTH, 'Sessão não confirmada pela UI; prosseguindo.');
    await appendLog(
      ctx,
      'A página não confirmou a sessão em 25s; prosseguindo — o check-in valida e a auto-cura autentica se necessário.'
    );
    return { ok: true, already: true, assumed: true };
  }

  // Login realmente necessário: sem credenciais não há como prosseguir. Avisa
  // o usuário (notificação + log) e encerra o run com mensagem acionável.
  const password = await getPassword(ctx.settings);
  if (!ctx.settings.user || !password) {
    const message =
      'O AliExpress não está logado e não há usuário/senha configurados. Abra as Opções da extensão e informe as credenciais para o login automático.';
    await appendLog(ctx, `⚠ Login necessário: ${message}`);
    await notify(ctx.settings, {
      id: 'ali-coins-missing-credentials',
      title: 'Ali Coins: login necessário',
      message,
      requireInteraction: true
    });
    return { ok: false, missingCredentials: true, error: message };
  }

  await updatePhase(PHASE.AUTH, 'Login necessário. Autenticando no AliExpress…');
  await appendLog(ctx, 'Login necessário — autenticando com as credenciais salvas.');
  const result = await authenticate(ctx, password);
  if (result.ok) await appendLog(ctx, 'Login concluído com sucesso.');
  return result;
}

/**
 * Executa o plano de autenticação: DO_LOGIN em loop, tratando captcha/2FA.
 * A senha é decifrada uma única vez pelo chamador (ensureAuthenticated).
 * @param {object} ctx
 * @param {string} password
 */
async function authenticate(ctx, password) {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    if (await isStopRequestedNow()) throw new RunAbortedError();
    const res = await cmd(ctx, CMD.DO_LOGIN, {
      user: ctx.settings.user,
      password
    }, { retries: 3 });

    if (res.needsCaptcha) {
      await captchaGate(ctx, 'login');
      continue;
    }
    if (res.twoFA) {
      await twoFAGate(ctx);
      continue;
    }
    if (res.ok) {
      return { ok: true, already: Boolean(res.already) };
    }
    if (res.pending) {
      await sleepAbortable(2500);
      continue;
    }
    if (res.error) {
      return { ok: false, error: res.error };
    }
    await sleepAbortable(1500);
  }
  return { ok: false, error: 'Não foi possível concluir o login após várias tentativas.' };
}
