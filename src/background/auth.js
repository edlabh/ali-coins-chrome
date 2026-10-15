/**
 * Autenticação: verificação de sessão e espera pelo LOGIN MANUAL do usuário.
 *
 * A extensão NÃO faz login por credenciais (usuário/senha foram removidos das
 * Opções): quando o AliExpress não está logado, o run traz a janela/aba para
 * frente, avisa (notificação + relatório) e aguarda o login — continuando
 * automaticamente quando a sessão aparecer.
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
import { captchaGate, manualLoginGate, twoFAGate } from './gates.js';

/**
 * Garante que a sessão está autenticada SEM tentar login automático:
 *   1. consulta o estado da página (CHECK_AUTH — somente leitura);
 *   2. se houver formulário/prompt de login, abre o gate de login manual
 *      (aguarda o usuário entrar; continua sozinho depois);
 *   3. UI indecisa por muito tempo → prossegue como sessão existente, deixando
 *      o check-in validar (a auto-cura usa este mesmo fluxo).
 * @param {object} ctx
 * @returns {Promise<{ok: boolean, already?: boolean, assumed?: boolean, manual?: boolean}>}
 */
export async function ensureAuthenticated(ctx) {
  await updatePhase(PHASE.AUTH, 'Verificando se a sessão do AliExpress já está ativa…');

  const deadline = Date.now() + 25000;
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
      // Login manual: aguarda o usuário entrar (sem tempo máximo); o gate só
      // retorna quando a sessão estiver ativa ou o run for cancelado.
      await manualLoginGate(ctx);
      return { ok: true, already: false, manual: true };
    }
    // 'pending': esqueleto do SPA ainda carregando.
    await sleepAbortable(1800);
  }

  // UI não decidiu em 25s (sem formulário e sem central de moedas visíveis):
  // prossegue como sessão existente — o check-in valida de fato e a auto-cura
  // abre o gate de login manual se a página for de login.
  await updatePhase(PHASE.AUTH, 'Sessão não confirmada pela UI; prosseguindo.');
  await appendLog(
    ctx,
    'A página não confirmou a sessão em 25s; prosseguindo — o check-in valida e, se necessário, o login manual é solicitado.'
  );
  return { ok: true, already: true, assumed: true };
}
