/**
 * Fase de tarefas: abre a gaveta "Ganhe mais moedas", extrai, executa, resgata
 * e repete — com os mesmos limites e logs do relatório do ali-coins.
 */

import { CMD, PHASE } from '../common/constants.js';
import { randInt } from '../common/schedule.js';
import { pickNextTask, summarizeTasks, taskKey } from '../common/state-utils.js';
import { truncate } from '../common/format.js';
import {
  RunAbortedError,
  appendLog,
  cmd,
  isStopRequestedNow,
  sleepAbortable,
  updatePhase
} from './context.js';
import { commandWithCaptcha } from './gates.js';
import { patchRunState } from './storage.js';
import { closeOrphanTabs, ensureCoinPage, waitPossibleNavigation } from './tabs.js';

/**
 * @param {object} ctx
 */
export async function runTasksPhase(ctx) {
  const { settings, stats } = ctx;
  const attempts = stats.taskAttempts;
  const claimed = new Set();
  let actions = 0;
  let guard = 0;

  while (actions < settings.maxTaskActions && guard < 80) {
    guard += 1;
    if (await isStopRequestedNow()) throw new RunAbortedError();

    await ensureCoinPage(ctx, false);
    const drawer = await commandWithCaptcha(ctx, CMD.OPEN_DRAWER, {}, 'drawer');
    if (!drawer || !drawer.ok) {
      const dbg = drawer && drawer.debug ? ` Diagnóstico: ${JSON.stringify(drawer.debug)}` : '';
      stats.errors.push(`Painel "Ganhe mais moedas" inacessível.${dbg}`.slice(0, 500));
      await appendLog(ctx, 'Falha ao abrir o painel de tarefas "Ganhe mais moedas".');
      break;
    }

    const extraction = await commandWithCaptcha(ctx, CMD.EXTRACT_TASKS, {}, 'tasks');
    let tasks = (extraction && extraction.tasks) || [];

    // Primeira abertura do painel: os cards podem renderizar com atraso — faz
    // UMA re-extração antes de concluir que não há nada (o sintoma clássico era
    // a gaveta abrir, a extração achar 0 e o run encerrar sem executar tarefa).
    if (tasks.length === 0 && guard === 1) {
      await sleepAbortable(1500);
      const retry = await commandWithCaptcha(ctx, CMD.EXTRACT_TASKS, {}, 'tasks');
      tasks = (retry && retry.tasks) || [];
    }

    if (guard === 1) {
      const summary = summarizeTasks(tasks);
      await appendLog(
        ctx,
        `Painel de tarefas: ${summary.total} cards (${summary.done} concluídas, ${summary.actionable} executáveis, ${summary.claimable} resgatáveis).`
      );
    }

    // Marca em lote as tarefas exclusivas do app (evita reabrir a gaveta por tarefa).
    if (settings.skipAppOnlyTasks) {
      for (const t of tasks) {
        if (!t) continue;
        const kind = t.kind || 'scroll';
        if (kind !== 'app-only' && kind !== 'prize-land') continue;
        const key = taskKey(t);
        if ((attempts[key] || 0) < settings.maxAttemptsPerTask) {
          attempts[key] = settings.maxAttemptsPerTask;
          if (!stats.skipped.includes(t.title)) {
            stats.skipped.push(t.title || '(sem título)');
            await appendLog(ctx, `Tarefa ignorada (exclusiva do app): ${truncate(t.title, 60)}.`);
          }
        }
      }
    }

    const next = pickNextTask(tasks, attempts, {
      maxAttemptsPerTask: settings.maxAttemptsPerTask,
      skipAppOnlyTasks: settings.skipAppOnlyTasks,
      claimed
    });

    if (!next) {
      const dbg = extraction && extraction.debug ? ` Diagnóstico: ${JSON.stringify(extraction.debug)}` : '';
      await appendLog(
        ctx,
        tasks.length === 0
          ? `Nenhum card de tarefa encontrado no painel.${dbg}`
          : 'Sem tarefas pendentes (concluídas ou no limite de tentativas).'
      );
      break;
    }

    const key = taskKey(next);

    if (next.action === 'skip_app_only') {
      attempts[key] = settings.maxAttemptsPerTask; // não re-seleciona
      if (!stats.skipped.includes(next.title)) {
        stats.skipped.push(next.title || '(sem título)');
        await appendLog(ctx, `Tarefa ignorada (exclusiva do app): ${truncate(next.title, 60)}.`);
      }
      await updatePhase(PHASE.TASKS, `Ignorando tarefa exclusiva do app: ${truncate(next.title, 48)}`);
      continue;
    }

    if (next.action === 'claim') {
      await cmd(ctx, CMD.CLICK_TASK, { index: next.index, title: next.title }, { retries: 2 });
      claimed.add(key);
      actions += 1;
      stats.tasks.push({ title: next.title, kind: 'claim', result: 'claimed' });
      await appendLog(ctx, `Resgate solicitado: ${truncate(next.title, 60)}.`);
      await sleepAbortable(1500);
      continue;
    }

    // action === 'run'
    await updatePhase(PHASE.TASKS, `Tarefa: ${truncate(next.title, 48)} (${next.kind})`);
    await cmd(ctx, CMD.CLICK_TASK, { index: next.index, title: next.title }, { retries: 2 });
    const navigated = await waitPossibleNavigation(ctx, 3500);

    const seconds = next.scrollSeconds || settings.scrollSeconds;
    const actionRes = await commandWithCaptcha(
      ctx,
      CMD.RUN_ACTION,
      { kind: next.kind, query: settings.searchQuery, seconds, navigated },
      'action'
    );

    attempts[key] = (attempts[key] || 0) + 1;
    actions += 1;
    stats.tasks.push({
      title: next.title,
      kind: next.kind,
      result: actionRes && actionRes.ok === false ? 'error' : 'attempt'
    });
    await appendLog(
      ctx,
      `Tarefa executada: ${truncate(next.title, 60)} (${next.kind}, tentativa ${attempts[key]}).`
    );
    await patchRunState({ stats: { ...stats } });

    await ensureCoinPage(ctx, false);
    await closeOrphanTabs(
      ctx.windowId,
      ctx.tabId,
      ctx.ledgerTabId ? [ctx.ledgerTabId] : [],
      ctx.knownTabIds
    ).catch(() => {});

    // Pausa aleatória entre tarefas (anti-detecção), como TASK_PAUSE_* do ali-coins.
    const pause = randInt(settings.pauseBetweenTasksMinMs, settings.pauseBetweenTasksMaxMs);
    if (pause > 1000) await sleepAbortable(pause);
  }

  // Varredura final de resgates pendentes.
  for (let sweep = 0; sweep < 5; sweep += 1) {
    await ensureCoinPage(ctx, false);
    const drawer = await commandWithCaptcha(ctx, CMD.OPEN_DRAWER, {}, 'drawer');
    if (!drawer || !drawer.ok) break;
    const extraction = await commandWithCaptcha(ctx, CMD.EXTRACT_TASKS, {}, 'tasks');
    const tasks = (extraction && extraction.tasks) || [];
    const claimables = tasks.filter((t) => t && t.isClaimable && !t.isDone && !claimed.has(taskKey(t)));
    if (claimables.length === 0) break;
    for (const t of claimables.slice(0, 3)) {
      await cmd(ctx, CMD.CLICK_TASK, { index: t.index, title: t.title }, { retries: 2 });
      claimed.add(taskKey(t));
      stats.tasks.push({ title: t.title, kind: 'claim', result: 'claimed' });
      await appendLog(ctx, `Resgate solicitado: ${truncate(t.title, 60)}.`);
      await sleepAbortable(1200);
    }
  }
}
