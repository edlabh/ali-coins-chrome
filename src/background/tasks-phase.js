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
  isNoContentScriptError,
  isStopRequestedNow,
  sleepAbortable,
  updatePhase
} from './context.js';
import { commandWithCaptcha } from './gates.js';
import { applySilentEmulation } from './cdp.js';
import { consumeItemTab } from './item-tab.js';
import { getRunState, patchRunState } from './storage.js';
import {
  applyDeviceRules,
  closeOrphanTabs,
  ensureCoinPage,
  getTabUrl,
  isAliexpressUrl,
  navigateTab,
  waitPossibleNavigation,
  waitTabComplete
} from './tabs.js';

/**
 * Recupera a execução quando a aba saiu de páginas com content script
 * (interstitial anti-bot, link externo, reload lento): avisa no extrato, volta
 * para a central de moedas e devolve null — o chamador continua o loop em vez
 * de abortar o run inteiro.
 */
async function recoverToCoinPage(ctx, type) {
  await appendLog(
    ctx,
    `Sem content script durante ${type} — a aba saiu do AliExpress; retornando à central (a execução continua).`
  );
  await ensureCoinPage(ctx, true);
  return null;
}

/** commandWithCaptcha tolerante a páginas sem content script. */
async function safeTaskCommand(ctx, type, payload = {}, label = '') {
  try {
    return await commandWithCaptcha(ctx, type, payload, label);
  } catch (err) {
    if (isNoContentScriptError(err)) return recoverToCoinPage(ctx, type);
    throw err;
  }
}

/** cmd tolerante a páginas sem content script. */
async function safeTaskCmd(ctx, type, payload = {}) {
  try {
    return await cmd(ctx, type, payload, { retries: 2 });
  } catch (err) {
    if (isNoContentScriptError(err)) return recoverToCoinPage(ctx, type);
    throw err;
  }
}

/**
 * Adota uma ABA NOVA aberta pelo clique em "GO" como aba ativa da rodada —
 * paridade com o `activePage = newPageOpened ?? page` do ali-coins. Sem isso, o
 * feed/tarefa que abre em nova aba nunca era encontrado (a ação rodava na
 * central de moedas). A aba adotada é fechada e a principal restaurada no fim
 * da tarefa (restoreTaskTab). Retorna true quando adotou.
 */
async function adoptTaskTab(ctx) {
  const runState = await getRunState();
  const known = new Set(Array.isArray(runState?.knownTabIds) ? runState.knownTabIds : []);
  const tabs = await chrome.tabs.query({ windowId: ctx.windowId }).catch(() => []);
  const candidate = tabs.find(
    (t) =>
      t.id &&
      t.id !== ctx.tabId &&
      t.id !== runState?.ledgerTabId &&
      !known.has(t.id) &&
      isAliexpressUrl(t.url || '') &&
      !/coin-pc-index/.test(t.url || '')
  );
  if (!candidate) return false;

  ctx.taskTabId = candidate.id;
  ctx.previousTabId = ctx.tabId;
  ctx.tabId = candidate.id;
  if (ctx.settings.silentMode) {
    if (runState?.userTabId) {
      await chrome.tabs.update(runState.userTabId, { active: true }).catch(() => {});
    }
    await chrome.tabs.update(candidate.id, { active: false }).catch(() => {});
  }
  await patchRunState({ tabId: candidate.id, knownTabIds: [...known, candidate.id] }).catch(() => {});
  // Inclui a aba adotada nas session rules de User-Agent/Client Hints mobile.
  await applyDeviceRules(ctx.previousTabId, ctx.settings, [candidate.id]).catch(() => {});
  await waitTabComplete(candidate.id, 20000);
  if (ctx.settings.silentMode) {
    // Mantém a emulação de viewport na aba adotada (melhor esforço).
    await applySilentEmulation(candidate.id, ctx.settings).catch(() => {});
  }
  await sleepAbortable(900);
  await appendLog(ctx, 'Tarefa aberta em nova aba — adotada para a execução da rodada.');
  return true;
}

/**
 * Restaura a aba principal e fecha a aba adotada pela tarefa (fim da rodada).
 */
async function restoreTaskTab(ctx) {
  if (!ctx.previousTabId) return;
  const adoptedId = ctx.taskTabId;
  const prevId = ctx.previousTabId;
  ctx.taskTabId = null;
  ctx.previousTabId = null;
  ctx.tabId = prevId;

  const runState = await getRunState();
  const known = Array.isArray(runState?.knownTabIds)
    ? runState.knownTabIds.filter((id) => id !== adoptedId)
    : [];
  await patchRunState({ tabId: prevId, knownTabIds: known }).catch(() => {});
  await applyDeviceRules(prevId, ctx.settings).catch(() => {});
  if (adoptedId) await chrome.tabs.remove(adoptedId).catch(() => {});
}

/**
 * Tarefa de surpresas (paridade com o ali-coins): 3 toques por rodada, com
 * retorno à tela do feed entre eles. A navegação (aba de item, voltar) é
 * tratada aqui no background — o content script morre em navegações completas.
 * Itens nunca se repetem (sessionStorage no content + retomada da rodada).
 * @returns {Promise<{ok: boolean, clicked: number}>}
 */
async function runSurpriseTaps(ctx) {
  const feedUrl = await getTabUrl(ctx.tabId);
  await appendLog(ctx, `Surpresas: rodada em ${truncate(feedUrl || '', 80)}.`);
  let clicked = 0;
  let feedReloaded = false;

  for (let i = 0; i < 3; i += 1) {
    if (await isStopRequestedNow()) throw new RunAbortedError();
    const beforeUrl = await getTabUrl(ctx.tabId);

    let res = await safeTaskCmd(ctx, CMD.SURPRISE_TAP, {});
    if (res === null) break; // página sem content script: já voltamos à central

    if (i === 0 && res.debug) {
      await appendLog(
        ctx,
        `Feed de surpresas: ${res.debug.raw} card(s) no DOM (${res.debug.visible} visíveis).`
      );
    }

    if (!res.clicked) {
      // Sem item novo: recarrega o feed UMA vez para buscar cards diferentes.
      if (!feedReloaded && feedUrl) {
        feedReloaded = true;
        await appendLog(ctx, 'Feed de surpresas sem itens novos — recarregando uma vez.');
        await navigateTab(ctx.tabId, feedUrl, 30000).catch(() => {});
        res = await safeTaskCmd(ctx, CMD.SURPRISE_TAP, {});
        if (res === null) break;
      }
      if (!res || !res.clicked) {
        await appendLog(ctx, `Feed de surpresas sem itens novos após ${clicked} toque(s).`);
        break;
      }
    }

    clicked += 1;
    await settleAfterSurpriseTap(ctx, beforeUrl, feedUrl);
  }
  return { ok: clicked > 0, clicked };
}

/**
 * Pós-toque (equivalentes ao waitForEvent('page')/goBack do ali-coins):
 *  - aba de item aberta → aguarda os beacons e fecha;
 *  - a própria página navegou → aguarda, volta e garante a tela do feed;
 *  - sem navegação visível → pequena pausa.
 */
async function settleAfterSurpriseTap(ctx, beforeUrl, feedUrl) {
  const itemTabClosed = await consumeItemTab(ctx.windowId, { timeoutMs: 2500, graceMs: 3500 });
  if (itemTabClosed) {
    await sleepAbortable(600);
    return;
  }

  const urlNow = await getTabUrl(ctx.tabId);
  if (urlNow && urlNow !== beforeUrl) {
    await sleepAbortable(3500); // deixa os beacons de tracking de missão dispararem
    await chrome.tabs.goBack(ctx.tabId).catch(() => {});
    await waitTabComplete(ctx.tabId, 15000);
    const backUrl = await getTabUrl(ctx.tabId);
    if (feedUrl && backUrl && backUrl !== feedUrl) {
      // Não voltou à tela inicial: força a navegação de volta ao feed.
      await navigateTab(ctx.tabId, feedUrl, 30000).catch(() => {});
    }
    await sleepAbortable(500);
    return;
  }

  // Sem navegação visível (overlay/SPA): pausa curta antes do próximo toque.
  await sleepAbortable(600);
}

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

    // Guarda de navegação: a aba pode ter saído do AliExpress entre iterações
    // (interstitial anti-bot/reload) — volta antes de tentar qualquer comando.
    const urlNow = await getTabUrl(ctx.tabId);
    if (urlNow && !isAliexpressUrl(urlNow)) {
      await appendLog(ctx, `A aba saiu do AliExpress (${truncate(urlNow, 60)}) — retornando à central.`);
      await ensureCoinPage(ctx, true);
      await sleepAbortable(1500);
      continue;
    }

    const drawer = await safeTaskCommand(ctx, CMD.OPEN_DRAWER, {}, 'drawer');
    if (drawer === null) {
      // Página sem content script: a central já foi reaberta — tenta de novo.
      await sleepAbortable(1500);
      continue;
    }
    if (!drawer.ok) {
      const dbg = drawer.debug ? ` Diagnóstico: ${JSON.stringify(drawer.debug)}` : '';
      stats.errors.push(`Painel "Ganhe mais moedas" inacessível.${dbg}`.slice(0, 500));
      await appendLog(ctx, 'Falha ao abrir o painel de tarefas "Ganhe mais moedas".');
      break;
    }

    const extraction = await safeTaskCommand(ctx, CMD.EXTRACT_TASKS, {}, 'tasks');
    if (extraction === null) {
      await sleepAbortable(1200);
      continue;
    }
    let tasks = (extraction && extraction.tasks) || [];

    // Primeira abertura do painel: os cards podem renderizar com atraso — faz
    // UMA re-extração antes de concluir que não há nada (o sintoma clássico era
    // a gaveta abrir, a extração achar 0 e o run encerrar sem executar tarefa).
    if (tasks.length === 0 && guard === 1) {
      await sleepAbortable(1500);
      const retry = await safeTaskCommand(ctx, CMD.EXTRACT_TASKS, {}, 'tasks');
      if (retry === null) {
        await sleepAbortable(1200);
        continue;
      }
      tasks = (retry && retry.tasks) || [];
    }

    if (guard === 1) {
      const summary = summarizeTasks(tasks);
      await appendLog(
        ctx,
        `Painel de tarefas: ${summary.total} cards (${summary.done} concluídas, ${summary.actionable} executáveis, ${summary.claimable} resgatáveis).`
      );
    }

    // Marca em lote as tarefas puladas por configuração (evita reabrir a
    // gaveta por tarefa): exclusivas do app (padrão) e "Explore itens surpresa"
    // (não funciona no site mobile — ignorada por padrão).
    const shouldSkipKind = (kind) => {
      if (kind === 'surprise') return settings.skipSurpriseTask !== false;
      return settings.skipAppOnlyTasks && (kind === 'app-only' || kind === 'prize-land');
    };
    for (const t of tasks) {
      if (!t) continue;
      const kind = t.kind || 'scroll';
      if (!shouldSkipKind(kind)) continue;
      const key = taskKey(t);
      if ((attempts[key] || 0) < settings.maxAttemptsPerTask) {
        attempts[key] = settings.maxAttemptsPerTask;
        if (!stats.skipped.includes(t.title)) {
          stats.skipped.push(t.title || '(sem título)');
          await appendLog(
            ctx,
            kind === 'surprise'
              ? `Tarefa ignorada (opção — não funciona no site mobile): ${truncate(t.title, 60)}.`
              : `Tarefa ignorada (exclusiva do app): ${truncate(t.title, 60)}.`
          );
        }
      }
    }

    const next = pickNextTask(tasks, attempts, {
      maxAttemptsPerTask: settings.maxAttemptsPerTask,
      skipAppOnlyTasks: settings.skipAppOnlyTasks,
      skipSurpriseTask: settings.skipSurpriseTask !== false,
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

    if (next.action === 'skip_app_only' || next.action === 'skip_surprise') {
      attempts[key] = settings.maxAttemptsPerTask; // não re-seleciona
      const reason =
        next.action === 'skip_surprise'
          ? 'opção — não funciona no site mobile'
          : 'exclusiva do app';
      if (!stats.skipped.includes(next.title)) {
        stats.skipped.push(next.title || '(sem título)');
        await appendLog(ctx, `Tarefa ignorada (${reason}): ${truncate(next.title, 60)}.`);
      }
      await updatePhase(PHASE.TASKS, `Ignorando tarefa (${reason}): ${truncate(next.title, 48)}`);
      continue;
    }

    if (next.action === 'claim') {
      const clicked = await safeTaskCmd(ctx, CMD.CLICK_TASK, {
        index: next.index,
        title: next.title
      });
      if (clicked === null) {
        await sleepAbortable(1500);
        continue;
      }
      claimed.add(key);
      actions += 1;
      stats.tasks.push({ title: next.title, kind: 'claim', result: 'claimed' });
      await appendLog(ctx, `Resgate solicitado: ${truncate(next.title, 60)}.`);
      await sleepAbortable(1500);
      continue;
    }

    // action === 'run'
    await updatePhase(PHASE.TASKS, `Tarefa: ${truncate(next.title, 48)} (${next.kind})`);
    const clickedTask = await safeTaskCmd(ctx, CMD.CLICK_TASK, {
      index: next.index,
      title: next.title
    });
    if (clickedTask === null) {
      await sleepAbortable(1500);
      continue;
    }
    const navigated = await waitPossibleNavigation(ctx, 5000);

    // A tarefa pode abrir uma página FORA do AliExpress (webgame, loja de app,
    // link externo): sem content script ali, o comando falharia e abortaria o
    // run inteiro no meio das tarefas. Detecta, volta para a central e conta a
    // tentativa sem derrubar a execução.
    const currentUrl = navigated ? await getTabUrl(ctx.tabId) : '';
    if (navigated && currentUrl && !isAliexpressUrl(currentUrl)) {
      attempts[key] = (attempts[key] || 0) + 1;
      actions += 1;
      stats.tasks.push({ title: next.title, kind: next.kind, result: 'error' });
      await appendLog(
        ctx,
        `Tarefa "${truncate(next.title, 60)}" abriu uma página externa (${truncate(currentUrl, 60)}) — retornando à central.`
      );
      await ensureCoinPage(ctx, true);
      const pauseExternal = randInt(
        settings.pauseBetweenTasksMinMs,
        settings.pauseBetweenTasksMaxMs
      );
      if (pauseExternal > 1000) await sleepAbortable(pauseExternal);
      continue;
    }

    // O clique em "GO" pode abrir a tarefa/feed numa ABA NOVA (na referência:
    // `activePage = newPageOpened ?? page`). Adota a aba para a rodada; ela é
    // fechada e a principal restaurada no finally.
    await adoptTaskTab(ctx);

    const seconds = next.scrollSeconds || settings.scrollSeconds;
    let actionRes;
    try {
      if (next.kind === 'surprise') {
        // Surpresas: 3 toques nesta rodada, com navegação orquestrada no
        // background (o content script morre na navegação para a ficha do item).
        actionRes = await runSurpriseTaps(ctx);
      } else {
        actionRes = await safeTaskCommand(
          ctx,
          CMD.RUN_ACTION,
          { kind: next.kind, query: settings.searchQuery, seconds, navigated },
          'action'
        );
        if (actionRes === null) {
          // Página sem content script: conta a tentativa e segue (a central já
          // foi reaberta pela recuperação).
          attempts[key] = (attempts[key] || 0) + 1;
          actions += 1;
          stats.tasks.push({ title: next.title, kind: next.kind, result: 'error' });
          continue;
        }
      }
    } finally {
      await restoreTaskTab(ctx).catch(() => {});
    }

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

  // Deixa explícito quando o run parou pelo teto de ações (tarefas restantes
  // ficam para a próxima execução) — antes o encerramento era silencioso.
  if (actions >= settings.maxTaskActions) {
    await appendLog(
      ctx,
      `Limite de ações por execução atingido (${settings.maxTaskActions}); tarefas restantes ficam para o próximo run (aumente em Opções para concluir tudo numa só execução).`
    );
  }

  // Varredura final de resgates pendentes.
  for (let sweep = 0; sweep < 5; sweep += 1) {
    await ensureCoinPage(ctx, false);
    const drawer = await safeTaskCommand(ctx, CMD.OPEN_DRAWER, {}, 'drawer');
    if (drawer === null) continue;
    if (!drawer.ok) break;
    const extraction = await safeTaskCommand(ctx, CMD.EXTRACT_TASKS, {}, 'tasks');
    if (extraction === null) continue;
    const tasks = (extraction && extraction.tasks) || [];
    const claimables = tasks.filter((t) => t && t.isClaimable && !t.isDone && !claimed.has(taskKey(t)));
    if (claimables.length === 0) break;
    for (const t of claimables.slice(0, 3)) {
      const clicked = await safeTaskCmd(ctx, CMD.CLICK_TASK, { index: t.index, title: t.title });
      if (clicked === null) break;
      claimed.add(taskKey(t));
      stats.tasks.push({ title: t.title, kind: 'claim', result: 'claimed' });
      await appendLog(ctx, `Resgate solicitado: ${truncate(t.title, 60)}.`);
      await sleepAbortable(1200);
    }
  }
}
