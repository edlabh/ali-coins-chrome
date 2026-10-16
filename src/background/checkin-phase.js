/**
 * Fase de check-in: extrato inicial (fonte de verdade), coleta no mobile e a
 * contabilidade completa (valor real, saldo compensado e sequência), espelhando
 * os fluxos do ali-coins (collect.js + libs/report.js).
 */

import { CMD, PHASE } from '../common/constants.js';
import {
  accountCheckin,
  protectConsolidatedStreak
} from '../common/accounting.js';
import { coinsSourceLabel, toNumberOrNull } from '../common/format.js';
import { ensureAuthenticated } from './auth.js';
import { appendLog, updatePhase } from './context.js';
import { commandWithCaptcha } from './gates.js';
import { readLedger } from './ledger-read.js';
import { notify } from './notify.js';
import { getRuntime, patchRunState, patchRuntime } from './storage.js';
import { ensureCoinPage } from './tabs.js';

/**
 * Executa check-in + contabilidade. Atualiza `ctx.balanceBefore` e retorna o
 * objeto consolidado do check-in e o saldo-base das tarefas.
 * @param {object} ctx
 * @param {{already?: boolean}} auth resultado de ensureAuthenticated
 * @returns {Promise<{checkin: object, initialBalanceForTasks: (number|null)}>}
 */
export async function runCheckinPhase(ctx, auth) {
  // Sessão recém-criada: recarrega a central de moedas para partir do estado
  // limpo. Quando a sessão já existia, a página atual já está pronta.
  if (!auth.already) {
    await ensureCoinPage(ctx, true);
  }

  // Leitura inicial do extrato desktop (página mycoin).
  // Espelha o ali-coins: só com sessão pré-existente; serve para saber se o
  // check-in de hoje JÁ foi creditado (evita clique duplo) e para o baseline.
  let earlyLedger = null;
  if (auth.already) {
    await updatePhase(PHASE.CHECKIN, 'Lendo o extrato de moedas…');
    earlyLedger = await readLedger(ctx, 'leitura inicial');
  } else {
    await appendLog(ctx, 'Extrato inicial dispensado (sessão recém-autenticada).', { detail: true });
  }
  const assumeCollected = Boolean(earlyLedger && earlyLedger.hasCheckinToday);

  // Check-in (com auto-cura: se a sessão caiu, autentica e tenta de novo)
  await updatePhase(PHASE.CHECKIN, 'Realizando check-in diário…');
  let checkin = await commandWithCaptcha(ctx, CMD.DO_CHECKIN, { assumeCollected }, 'checkin');
  if (checkin && checkin.needsLogin) {
    await appendLog(ctx, 'A sessão expirou durante o check-in — autenticando e repetindo.');
    const retryAuth = await ensureAuthenticated(ctx);
    if (!retryAuth.ok) throw new Error(retryAuth.error || 'Falha de autenticação.');
    await ensureCoinPage(ctx, true);
    checkin = await commandWithCaptcha(ctx, CMD.DO_CHECKIN, { assumeCollected }, 'checkin');
  }

  // Contabilidade pós check-in: refaz a leitura do extrato quando houve coleta
  // (crédito real, missões do dia e sequência); senão reaproveita a inicial
  // (shouldReuseEarlyDesktop do ali-coins).
  const mobileCheckin = {
    already: Boolean(checkin.already),
    justCollected: Boolean(checkin.justCollected),
    coins: checkin.coins ?? null,
    streak: checkin.streak ?? null,
    balance: toNumberOrNull(checkin.balance)
  };

  let postLedger = earlyLedger;
  if (mobileCheckin.justCollected || !earlyLedger || earlyLedger.totalBalance === null) {
    postLedger = await readLedger(ctx, 'pós check-in');
  } else {
    await appendLog(ctx, 'Extrato reaproveitado da leitura inicial (nada coletado neste run).', {
      detail: true
    });
  }

  const runtimeState = await getRuntime();
  const previousStreak = Number.isFinite(runtimeState.lastStreak) ? runtimeState.lastStreak : null;

  const acct = accountCheckin({
    mobileCheckin,
    earlyLedger,
    postLedger,
    previousStreakDays: previousStreak,
    assumeCollected
  });

  // Saldo "antes" (pré-crédito do check-in) e saldo base das tarefas.
  ctx.balanceBefore = earlyLedger?.totalBalance ?? null;
  const initialBalanceForTasks =
    acct.balanceAfterCheckin ?? mobileCheckin.balance ?? ctx.balanceBefore;

  // Diagnóstico das fontes da sequência: ajuda a diferenciar o ciclo semanal
  // (1..7) da sequência real (ex.: 240) em caso de leitura suspeita.
  await appendLog(
    ctx,
    `Sequência (fontes): mobile=${mobileCheckin.streak ?? 'N/D'}, extrato=${acct.statementStreak ?? 'N/D'}, consolidado=${previousStreak ?? 'N/D'} → ${acct.streakDays}.`,
    { detail: true }
  );

  if (acct.justCollected) {
    const src = acct.coinsSource ? ` (${coinsSourceLabel(acct.coinsSource)})` : '';
    await appendLog(
      ctx,
      `Check-in realizado: +${acct.coins ?? '?'} moedas${src}${
        typeof acct.streakDays === 'number' ? ` — sequência de ${acct.streakDays} dias` : ''
      }.`
    );
  } else if (acct.alreadyCollected) {
    await appendLog(
      ctx,
      acct.coinsGainedToday > 0
        ? `Check-in: já coletado hoje — crédito do dia no extrato: +${acct.coinsGainedToday} moedas.`
        : 'Check-in: já coletado hoje — nenhuma moeda nova de check-in.'
    );
  } else if (acct.confirmedByLedger) {
    await appendLog(ctx, `Check-in confirmado pelo extrato: +${acct.coinsGainedToday} moedas.`);
  } else {
    await appendLog(ctx, 'Check-in: clique não confirmado pela UI nem pelo extrato.');
  }
  if (acct.balanceAdjusted) {
    await appendLog(ctx, 'Saldo sincronizado com o crédito do check-in (extrato defasado).');
  }

  // Protege o consolidado: uma leitura do ciclo semanal (≤7) nunca rebaixa um
  // histórico maior conhecido sem quebra confirmada.
  if (typeof acct.streakDays === 'number') {
    const protectedStreak = protectConsolidatedStreak({
      next: acct.streakDays,
      previous: previousStreak,
      streakBroken: acct.streakBroken
    });
    if (protectedStreak !== acct.streakDays) {
      await appendLog(
        ctx,
        `Leitura de sequência (${acct.streakDays}) abaixo do consolidado (${previousStreak}) e sem quebra confirmada — mantendo ${protectedStreak} dias.`
      );
      acct.streakDays = protectedStreak;
    }
    await appendLog(ctx, `Sequência de check-in: ${acct.streakDays} dias.`);
  }

  if (acct.streakBroken) {
    await appendLog(
      ctx,
      `🚨 Sequência de check-in quebrada: era ${previousStreak} dias e hoje voltou a ${acct.streakDays}.`
    );
    await notify(ctx.settings, {
      id: 'ali-coins-streak',
      title: 'Ali Coins: sequência de check-in quebrada',
      message: `A sequência foi interrompida: ontem com ${previousStreak} dias, hoje em ${acct.streakDays}.`,
      requireInteraction: true
    });
  }
  if (ctx.balanceBefore !== null) {
    await appendLog(ctx, `Saldo no extrato (antes do crédito do dia): ${ctx.balanceBefore} moedas.`);
  }

  // Persiste a sequência consolidada para a detecção de quebra no próximo run.
  if (typeof acct.streakDays === 'number') {
    await patchRuntime({ lastStreak: acct.streakDays, lastStreakAt: Date.now() });
  }

  checkin = {
    already: acct.alreadyCollected,
    justCollected: acct.justCollected,
    confirmedByLedger: acct.confirmedByLedger,
    coins: acct.coins,
    coinsSource: acct.coinsSource,
    coinsGainedToday: acct.coinsGainedToday,
    checkinCoinsFromLedger: acct.checkinCoinsFromLedger,
    streak: typeof acct.streakDays === 'number' ? acct.streakDays : mobileCheckin.streak,
    streakBroken: acct.streakBroken,
    balance: acct.balanceAfterCheckin,
    totalBalance: acct.balanceAfterCheckin
  };

  await patchRunState({
    stats: { ...ctx.stats },
    checkin: {
      already: checkin.already,
      justCollected: checkin.justCollected,
      coins: checkin.coinsGainedToday > 0 ? checkin.coinsGainedToday : checkin.coins
    }
  });

  return {
    checkin,
    initialBalanceForTasks,
    postMissions: Number.isFinite(postLedger?.todayMissionsCoins) ? postLedger.todayMissionsCoins : null
  };
}
