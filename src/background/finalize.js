/**
 * Contabilidade final (extrato pós-tarefas) e encerramento do run
 * (relatório, notificação, política de janela/aba).
 */

import { CMD, DESKTOP_LOGIN_URL, PHASE, RUN_STATUS } from '../common/constants.js';
import { computeTasksCoinsGained, desktopStreakOf } from '../common/accounting.js';
import { toNumberOrNull } from '../common/format.js';
import { formatDuration } from '../common/schedule.js';
import { detachCdp } from './cdp.js';
import { appendLog, updatePhase } from './context.js';
import { commandWithCaptcha } from './gates.js';
import { readLedger } from './ledger-read.js';
import { notifyResult, setBadge } from './notify.js';
import { patchRunState, pushReport } from './storage.js';
import {
  clearDeviceRules,
  closeLedgerTab,
  ensureCoinPage,
  focusWindow,
  navigateTab
} from './tabs.js';

/**
 * Contabilidade final: relê o extrato desktop e fecha os números do run
 * (saldo final, ganho de tarefas por delta de saldo e missões do dia).
 * @param {object} ctx
 * @param {object} checkin check-in consolidado (checkin-phase)
 * @param {number|null} initialBalanceForTasks saldo-base pós-checkin
 * @param {number|null} postMissions missões do extrato logo após o check-in
 * @returns {Promise<{balanceAfter: (number|null), tasksGained: (number|null), ledgerSummary: (object|null)}>}
 */
export async function runFinalAccounting(ctx, checkin, initialBalanceForTasks, postMissions = null) {
  await updatePhase(PHASE.FINALIZING, 'Lendo extrato final…');
  const finalLedger = await readLedger(ctx, 'saldo final');
  let balanceAfter = finalLedger?.totalBalance ?? null;
  if (balanceAfter === null) {
    await ensureCoinPage(ctx, true);
    const balanceRead = await commandWithCaptcha(ctx, CMD.READ_BALANCE, {}, 'balance');
    balanceAfter = toNumberOrNull(balanceRead.balance);
    await appendLog(ctx, 'Saldo final lido na página mobile (extrato indisponível).', { detail: true });
  }

  // Ganho de tarefas: delta de saldo (base pós-checkin, como o ali-coins), com a
  // guarda legada de saldo capturado antes do crédito do check-in.
  let tasksGained = null;
  if (Number.isFinite(balanceAfter) && Number.isFinite(initialBalanceForTasks)) {
    const rawTasksGained = balanceAfter - initialBalanceForTasks;
    tasksGained = computeTasksCoinsGained(
      { coinsGained: rawTasksGained, initialBalance: initialBalanceForTasks, coinsFromLedger: false },
      checkin
    );
  }

  // Missões de moedas do extrato (soma das tarefas do dia) e delta neste run.
  const ledgerSummary =
    finalLedger && Number.isFinite(finalLedger.todayMissionsCoins)
      ? {
          missionsCoins: finalLedger.todayMissionsCoins,
          missionsCount: finalLedger.todayMissionsCount ?? null,
          missionsGained:
            Number.isFinite(postMissions) && postMissions !== null
              ? Math.max(0, finalLedger.todayMissionsCoins - postMissions)
              : null,
          desktopStreak: desktopStreakOf(finalLedger)
        }
      : null;

  if (balanceAfter !== null) {
    const delta =
      ctx.balanceBefore !== null
        ? ` (${balanceAfter - ctx.balanceBefore >= 0 ? '+' : ''}${balanceAfter - ctx.balanceBefore} no run)`
        : '';
    await appendLog(ctx, `Saldo final: ${balanceAfter} moedas${delta}.`);
  } else {
    await appendLog(ctx, 'Saldo final não disponível (N/D).');
  }
  if (tasksGained !== null) {
    await appendLog(ctx, `Tarefas (delta de saldo): ${tasksGained >= 0 ? '+' : ''}${tasksGained} moedas.`);
  }

  return { balanceAfter, tasksGained, ledgerSummary };
}

/**
 * Fecha a janela/aba no fim do run conforme a preferência (keepWindowOpen).
 * Fechando a janela, as session rules da aba são descartadas junto.
 * Exceção: quando o login manual foi exigido (ctx.manualLoginRequired), a aba é
 * convertida na TELA DE LOGIN DA VERSÃO DESKTOP (sem emulação mobile) e SEMPRE
 * preservada — o usuário precisa entrar nela e executar a extensão novamente.
 */
export async function applyWindowPolicy(ctx, settings) {
  if (!ctx.windowId) return;
  if (ctx.tabId) await detachCdp(ctx.tabId).catch(() => {});

  // Login manual exigido: converte a aba na tela de login da versão desktop
  // (remove UA/Client Hints mobile e a viewport emulada), traz para frente e
  // NÃO fecha nada — a tela fica aberta para o usuário entrar.
  if (ctx.manualLoginRequired) {
    await clearDeviceRules().catch(() => {});
    if (ctx.tabId) {
      await appendLog(ctx, 'Abrindo a tela de login da versão desktop (sem emulação mobile)…');
      await navigateTab(ctx.tabId, DESKTOP_LOGIN_URL, 30000).catch(() => {});
    }
    await appendLog(
      ctx,
      'Tela de login mantida aberta — faça login na versão desktop e execute a extensão novamente.'
    );
    await focusWindow(ctx.windowId, ctx.tabId || null);
    await closeLedgerTab();
    return;
  }

  // Modo silencioso: a aba vive em uma janela normal do usuário — NUNCA fechar
  // a janela dele; no máximo a própria aba de execução (e uma janela popup
  // vazia, caso a aba tenha sido reaproveitada de uma abertura manual).
  if (settings.silentMode) {
    if (settings.keepWindowOpen) {
      await appendLog(ctx, 'Modo silencioso: aba de execução mantida aberta (configuração).', {
        detail: true
      });
    } else if (ctx.tabId) {
      await appendLog(ctx, 'Concluído — fechando a aba de execução (modo silencioso).', { detail: true });
      const tabInfo = await chrome.tabs.get(ctx.tabId).catch(() => null);
      await chrome.tabs.remove(ctx.tabId).catch(() => {});
      if (tabInfo) {
        try {
          const win = await chrome.windows.get(tabInfo.windowId);
          if (win && win.type === 'popup') {
            await chrome.windows.remove(win.id).catch(() => {});
          }
        } catch {
          // Janela já fechada: ignora.
        }
      }
    }
    await clearDeviceRules().catch(() => {});
    await closeLedgerTab();
    return;
  }

  if (settings.keepWindowOpen) {
    await appendLog(ctx, 'Janela mobile mantida aberta (configuração).', { detail: true });
    await closeLedgerTab();
    return;
  }
  await appendLog(ctx, 'Concluído — fechando a janela mobile.', { detail: true });
  await closeLedgerTab();
  await chrome.windows.remove(ctx.windowId).catch(() => {});
  await clearDeviceRules().catch(() => {});
}

/**
 * Persiste o relatório, atualiza o badge e notifica (respeitando
 * `notifyOnlyOnChange`: erros sempre avisam; sucesso pode ser silencioso).
 */
export async function finalize(report, settings, ok) {
  await pushReport(report);
  await patchRunState({
    active: false,
    phase:
      report.status === RUN_STATUS.SUCCESS || report.status === RUN_STATUS.PARTIAL
        ? PHASE.DONE
        : mapErrorPhase(report.status),
    message: describeReport(report),
    finishedAt: Date.now(),
    stats: null
  });
  await setBadge(ok ? '✓' : '!', ok ? 'ok' : 'error');

  const hasNews =
    Boolean(
      report.checkin &&
        (report.checkin.justCollected ||
          report.checkin.confirmedByLedger ||
          report.checkin.checkinCoinsFromLedger)
    ) || (Array.isArray(report.tasks) && report.tasks.length > 0);
  const shouldNotify = !ok || !settings.notifyOnlyOnChange || hasNews;
  if (shouldNotify) {
    await notifyResult(settings, ok, describeReport(report));
  }
}

function mapErrorPhase(status) {
  if (status === RUN_STATUS.STOPPED) return PHASE.STOPPED;
  if (status === RUN_STATUS.BLOCKED) return PHASE.BLOCKED;
  return PHASE.ERROR;
}

export function describeReport(report) {
  const parts = [];
  const c = report.checkin;
  if (c) {
    if (c.justCollected) parts.push(`check-in +${c.coins ?? '?'} moedas`);
    else if (c.already) parts.push('check-in já feito hoje');
    else parts.push('check-in não confirmado');
  }
  const acted = (report.tasks || []).length;
  if (acted) parts.push(`${acted} ação(ões) de tarefas`);
  else if (c && c.already) parts.push('sem tarefas novas');
  if (report.gained !== null) parts.push(`saldo ${report.gained >= 0 ? '+' : ''}${report.gained}`);
  parts.push(`duração ${formatDuration(report.durationMs)}`);
  if (report.status !== RUN_STATUS.SUCCESS) {
    parts.push(`status: ${report.status}`);
    // Inclui o primeiro erro (ex.: "Login manual necessário…") para a notificação
    // final e o popup serem acionáveis em vez de só "status: error".
    if (Array.isArray(report.errors) && report.errors.length > 0) {
      parts.push(String(report.errors[0]).slice(0, 140));
    }
  }
  return parts.join(' • ');
}
