/**
 * Fase de tarefas: abre a gaveta "Ganhe mais moedas", extrai, executa, resgata
 * e repete — com os mesmos limites e logs do relatório do ali-coins.
 */

import { CMD, PHASE } from '../common/constants.js';
import { randInt } from '../common/schedule.js';
import {
  applyTaskProgress,
  claimKey,
  pickNextTask,
  resetTaskTracking,
  roundKeyOf,
  selectLateProgressCandidates,
  summarizeTasks,
  taskKey
} from '../common/state-utils.js';
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
import { getRunState, getSurpriseTapped, patchRunState, saveSurpriseTapped } from './storage.js';
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
  // A aba ADOTADA da tarefa pode ter sido fechada pelo site/navegador:
  // restaura a aba principal ANTES de tentar navegar (antes, o comando seguinte
  // ia para uma aba morta e derrubava a fase sem recuperação).
  if (ctx.taskTabId) {
    await restoreTaskTab(ctx).catch(() => {});
  }
  const alive = ctx.tabId ? await chrome.tabs.get(ctx.tabId).catch(() => null) : null;
  if (!alive) {
    throw new Error('A aba de execução não está mais disponível — a execução foi encerrada.');
  }
  await ensureCoinPage(ctx, true).catch(() => {});
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
  // P4: com o fluxo de popup restaurado, a aba da tarefa pode ainda estar em
  // navegação pendente quando a consulta roda (URL vazia/about:blank) — tenta
  // algumas vezes, considera `pendingUrl` e aceita aba em branco filha da aba
  // do run (antes, uma única consulta perdia a aba; a ação rodava na central e
  // a rodada era queimada sem nenhum toque).
  let candidate = null;
  for (let attempt = 0; attempt < 6 && !candidate; attempt += 1) {
    const tabs = await chrome.tabs.query({ windowId: ctx.windowId }).catch(() => []);
    candidate =
      tabs.find(
        (t) =>
          t.id &&
          t.id !== ctx.tabId &&
          t.id !== runState?.ledgerTabId &&
          !known.has(t.id) &&
          !/coin-pc-index/.test(t.url || '') &&
          !/coin-pc-index/.test(t.pendingUrl || '') &&
          (isAliexpressUrl(t.url || '') ||
            isAliexpressUrl(t.pendingUrl || '') ||
            (t.openerTabId === ctx.tabId && !t.url && !t.pendingUrl))
      ) || null;
    if (!candidate) await sleepAbortable(250);
  }
  if (!candidate) return false;

  // A aba pode ter sido fechada pelo site/navegador a qualquer momento:
  // confirma que ela ainda existe ANTES de adotar — adotar uma aba já fechada
  // fazia os comandos seguintes falharem em "Sem content script" e derrubavam a
  // fase inteira.
  const preAlive = await chrome.tabs.get(candidate.id).catch(() => null);
  if (!preAlive) return false;

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

  // ...e DEPOIS de adotar: se a aba sumiu nesse meio-tempo (fechada pelo site
  // ou pelo usuário), desfaz a adoção e a rodada segue na aba PRINCIPAL em vez
  // de operar numa aba morta.
  const postAlive = await chrome.tabs.get(candidate.id).catch(() => null);
  if (!postAlive) {
    await restoreTaskTab(ctx).catch(() => {});
    await appendLog(ctx, 'A aba aberta pela tarefa foi fechada pelo controle de abas — seguindo na aba principal.');
    return false;
  }

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
 * Itens tocados NUNCA se repetem e a memória é DIÁRIA e persistente (storage),
 * como o arquivo por dia da referência: repetições não contam progresso.
 *
 * Fallback de detalhe (como o SURPRISE_DETAIL_FALLBACK do ali-coins): se os
 * toques não abriram NENHUMA ficha, o site pode exigir abrir o DETALHE do
 * produto para contabilizar a rodada — abre 1 card ainda não tocado e espera.
 * @returns {Promise<{ok: boolean, clicked: number}>}
 */
async function runSurpriseTaps(ctx) {
  const feedUrl = await getTabUrl(ctx.tabId);
  await appendLog(ctx, `Surpresas: rodada em ${truncate(feedUrl || '', 80)}.`);
  // Memória do dia (persistente entre execuções, paridade com o arquivo por dia
  // da referência) + tentativas desta rodada. P3: o card entra na memória no
  // CLIQUE bem-sucedido (como a origem) — repetir o mesmo toque não conta
  // progresso; o fallback de detalhe abaixo garante a visita quando nenhuma
  // ficha abrir.
  const daily = await getSurpriseTapped().catch(() => new Set());
  const attempted = new Set();
  let clicked = 0;
  let openedAny = false;
  let feedReloaded = false;

  const tapOnce = async () =>
    safeTaskCmd(ctx, CMD.SURPRISE_TAP, { exclude: [...daily, ...attempted] });

  for (let i = 0; i < 3; i += 1) {
    if (await isStopRequestedNow()) throw new RunAbortedError();
    const beforeUrl = await getTabUrl(ctx.tabId);

    let res = await safeTaskCmd(ctx, CMD.SURPRISE_TAP, { exclude: [...daily, ...attempted] });
    if (res === null) break; // página sem content script: já voltamos à central

    if (i === 0 && res.debug) {
      const links =
        Array.isArray(res.debug.links) && res.debug.links.length
          ? ` links: ${res.debug.links.map((l) => truncate(l, 70)).join(' | ')}`
          : '';
      await appendLog(
        ctx,
        `Feed de surpresas: ${res.debug.raw} card(s) no DOM (${res.debug.visible} visíveis, .feeds-discount-card=${res.debug.discount ?? '?'}).${links}`
      );
    }

    if (!res.clicked) {
      // Sem item novo: recarrega o feed UMA vez para buscar cards diferentes.
      if (!feedReloaded && feedUrl) {
        feedReloaded = true;
        await appendLog(ctx, 'Feed de surpresas sem itens novos — recarregando uma vez.');
        await navigateTab(ctx.tabId, feedUrl, 30000).catch(() => {});
        res = await tapOnce();
        if (res === null) break;
      }
      if (!res || !res.clicked) {
        await appendLog(ctx, `Feed de surpresas sem itens novos após ${clicked} toque(s).`);
        break;
      }
    }

    clicked += 1;
    if (res.signature) {
      attempted.add(res.signature);
      if (!daily.has(res.signature)) {
        daily.add(res.signature);
        await saveSurpriseTapped(daily).catch(() => {});
      }
    }
    const settle = await settleAfterSurpriseTap(ctx, beforeUrl, feedUrl);
    if (settle.opened) openedAny = true;
  }

  // Fallback de detalhe (paridade com o ali-coins): nenhum toque abriu ficha —
  // abre UM detalhe de produto ainda não tocado para contabilizar a rodada.
  if (clicked > 0 && !openedAny && !(await isStopRequestedNow())) {
    await appendLog(
      ctx,
      'Surpresas: nenhuma ficha abriu nos toques — abrindo 1 detalhe de produto (fallback).'
    );
    const beforeUrl = await getTabUrl(ctx.tabId);
    const res = await tapOnce();
    if (res && res.clicked) {
      clicked += 1;
      if (res.signature) {
        attempted.add(res.signature);
        if (!daily.has(res.signature)) {
          daily.add(res.signature);
          await saveSurpriseTapped(daily).catch(() => {});
        }
      }
      // Diagnósticos da ficha já foram logados pelo próprio settle.
      await settleAfterSurpriseTap(ctx, beforeUrl, feedUrl);
    }
  }

  return { ok: clicked > 0, clicked };
}

/**
 * Pós-toque (equivalentes ao waitForEvent('page')/goBack do ali-coins):
 *  - aba de item aberta → trata como mini aba de run (mobile + foco), aguarda
 *    os beacons e fecha;
 *  - a própria página navegou → aguarda, volta e garante a tela do feed;
 *  - sem navegação visível → pequena pausa.
 * @returns {Promise<{opened: boolean}>} opened=true quando uma ficha abriu
 */
async function settleAfterSurpriseTap(ctx, beforeUrl, feedUrl) {
  const item = await consumeItemTab(ctx.windowId, {
    settings: ctx.settings,
    timeoutMs: 2500,
    graceMs: 1500
  });
  if (item && item.closed) {
    // Diagnóstico de crédito (P2): URL aberta (com flag de missão), contagem de
    // beacons de tracking e visibilidade real da página — a evidência que
    // confirma/derruba as hipóteses sobre o crédito da missão.
    const vis = item.visibility ? `, visibilidade "${item.visibility}"` : '';
    const mission = /[?&](from=mission|idem_id=)/i.test(item.url || '') ? 'sim' : 'não';
    await appendLog(
      ctx,
      `Ficha do item: ${truncate(item.url || '(sem URL)', 90)} (missão: ${mission}), ${Number.isFinite(item.tracking) ? item.tracking : 0} beacon(s)${vis} (diagnóstico).`
    );
    await sleepAbortable(600);
    return { opened: true };
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
    return { opened: true };
  }

  // Sem navegação visível (overlay/SPA): pausa curta antes do próximo toque.
  await sleepAbortable(600);
  return { opened: false };
}

// Confirmação extra antes de aceitar "sem progresso" numa rodada: o status do
// AliExpress costuma chegar alguns segundos depois da ação (mesma janela de
// LATE_PROGRESS_CONFIRM_MS do ali-coins).
const LATE_PROGRESS_CONFIRM_MS = 4000;
// Cap de tentativas por RODADA (título + status "n/m"): sem progresso após N
// tentativas na MESMA rodada, a tarefa falha. Avanço de rodada cria uma chave
// nova (e o progresso observado zera as tentativas do título) — igual ao
// TASK_ROUND_MAX_ATTEMPTS do ali-coins.
const MAX_ROUND_ATTEMPTS = 3;

/**
 * @param {object} ctx
 */
export async function runTasksPhase(ctx) {
  const { settings, stats } = ctx;
  const attempts = stats.taskAttempts;
  // Tentativas por rodada (título + statusText), falhas por título e memória do
  // último progresso/status visto — máquina de estados do ali-coins.
  const roundAttempts = {};
  const failed = {};
  const progressMap = {};
  const statusMap = {};
  // Tarefas ignoradas por configuração (app-only/surpresa): nunca reabertas.
  const disabledTitles = new Set();
  const claimed = new Set();
  const lateChecked = new Set();
  let actions = 0;
  let guard = 0;
  let drawerRetries = 0;

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
      // Recuperação: a aba pode ter ficado numa subpágina do coin-index (ex.:
      // recommends.html do feed patrocinado) ou a gaveta falhou de forma
      // transitória. Recarrega a central FORÇADO e tenta UMA vez antes de
      // encerrar a fase — antes, uma única falha abandonava as tarefas restantes.
      if (drawerRetries < 1) {
        drawerRetries += 1;
        const dbgRetry = drawer.debug ? ` Diagnóstico: ${JSON.stringify(drawer.debug)}` : '';
        await appendLog(
          ctx,
          `Painel "Ganhe mais moedas" não abriu.${dbgRetry} Recarregando a central de moedas e tentando novamente.`
        );
        await ensureCoinPage(ctx, true);
        await sleepAbortable(1500);
        continue;
      }
      const dbg = drawer.debug ? ` Diagnóstico: ${JSON.stringify(drawer.debug)}` : '';
      stats.errors.push(`Painel "Ganhe mais moedas" inacessível.${dbg}`.slice(0, 500));
      await appendLog(ctx, 'Falha ao abrir o painel de tarefas "Ganhe mais moedas".');
      break;
    }
    drawerRetries = 0;

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
      if (t.title) disabledTitles.add(t.title);
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

    // Progresso observado no painel reinicia tentativas/falhas (a progressão do
    // AliExpress chega com ATRASO): sem isso, uma tarefa que já avançou de
    // rodada ficava bloqueada pelo resto da execução — era o sintoma de
    // "executou só a primeira rodada" em tarefas "n/m" (ex.: super descontos).
    const advanced = applyTaskProgress(tasks, {
      attempts,
      roundAttempts,
      progressMap,
      statusMap,
      failed,
      disabled: disabledTitles
    });
    for (const title of advanced) {
      await appendLog(
        ctx,
        `Tarefa "${truncate(title, 60)}" avançou de rodada — tentativas resetadas (progresso confirmado).`
      );
    }

    // Confirmação de progresso tardio: rodada com tentativas esgotadas e ainda
    // sem falha — relê o painel uma vez após alguns segundos antes de desistir.
    const lateCandidates = selectLateProgressCandidates(tasks, {
      roundAttempts,
      failed,
      disabled: disabledTitles,
      maxRoundAttempts: MAX_ROUND_ATTEMPTS,
      skipAppOnlyTasks: settings.skipAppOnlyTasks,
      skipSurpriseTask: settings.skipSurpriseTask !== false
    }).filter((c) => !lateChecked.has(c.key));
    if (lateCandidates.length > 0) {
      for (const c of lateCandidates) lateChecked.add(c.key);
      await appendLog(
        ctx,
        `Possível progresso tardio em ${lateCandidates.length} tarefa(s) (${lateCandidates
          .map((c) => truncate(c.title, 40))
          .join(' | ')}); relendo o painel em ${Math.round(LATE_PROGRESS_CONFIRM_MS / 1000)}s antes de desistir.`
      );
      await sleepAbortable(LATE_PROGRESS_CONFIRM_MS);
      const confirm = await safeTaskCommand(ctx, CMD.EXTRACT_TASKS, {}, 'tasks');
      if (confirm && Array.isArray(confirm.tasks) && confirm.tasks.length > 0) {
        tasks = confirm.tasks;
        const confirmed = applyTaskProgress(tasks, {
          attempts,
          roundAttempts,
          progressMap,
          statusMap,
          failed,
          disabled: disabledTitles
        });
        for (const title of confirmed) {
          await appendLog(ctx, `Progresso tardio confirmado em "${truncate(title, 60)}".`);
        }
      }
    }

    const failedBefore = new Set(Object.keys(failed));
    const next = pickNextTask(tasks, attempts, {
      maxAttemptsPerTask: settings.maxAttemptsPerTask,
      skipAppOnlyTasks: settings.skipAppOnlyTasks,
      skipSurpriseTask: settings.skipSurpriseTask !== false,
      claimed,
      roundAttempts,
      maxRoundAttempts: MAX_ROUND_ATTEMPTS,
      failed
    });
    for (const title of Object.keys(failed)) {
      if (!failedBefore.has(title)) {
        await appendLog(ctx, `Tarefa "${truncate(title, 60)}" desistida: ${failed[title]}.`);
      }
    }

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
      if (next.title) disabledTitles.add(next.title);
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
      claimed.add(claimKey(next));
      // Resgate bem-sucedido libera a PRÓXIMA rodada da tarefa: zera as
      // tentativas desta tarefa (como o resetTaskAttempt do ali-coins) para
      // que as rodadas seguintes possam ser executadas no mesmo run.
      resetTaskTracking({ attempts, roundAttempts, failed }, next);
      actions += 1;
      stats.tasks.push({ title: next.title, kind: 'claim', result: 'claimed' });
      await appendLog(ctx, `Resgate solicitado: ${truncate(next.title, 60)}.`);
      await sleepAbortable(1500);
      continue;
    }

    // action === 'run'
    await updatePhase(PHASE.TASKS, `Tarefa: ${truncate(next.title, 48)} (${next.kind})`);

    // Tentativas contadas ANTES da execução (terminação garantida: a tarefa é
    // excluída após os caps mesmo se o botão sumir ou um comando falhar) —
    // igual ao recordTaskAttempt/recordRoundAttempt do ali-coins.
    attempts[key] = (attempts[key] || 0) + 1;
    const roundKey = roundKeyOf(next);
    roundAttempts[roundKey] = (roundAttempts[roundKey] || 0) + 1;

    const clickedTask = await safeTaskCmd(ctx, CMD.CLICK_TASK, {
      index: next.index,
      title: next.title
    });
    if (clickedTask === null) {
      await sleepAbortable(1500);
      continue;
    }
    if (clickedTask.clicked === false) {
      // A lista pode ter re-renderizado e o botão não foi localizado (ou o
      // clique foi impedido): a tentativa já está contada — evita "rodada
      // fantasma" sem clique.
      await appendLog(
        ctx,
        `O clique da tarefa "${truncate(next.title, 60)}" não foi disparado (botão ausente ou alvo impedido) — tentativa contada.`
      );
      await sleepAbortable(800);
      continue;
    }
    const navigated = await waitPossibleNavigation(ctx, 5000);

    // A tarefa pode abrir uma página FORA do AliExpress (webgame, loja de app,
    // link externo): sem content script ali, o comando falharia e abortaria o
    // run inteiro no meio das tarefas. Detecta, volta para a central e conta a
    // tentativa sem derrubar a execução.
    const currentUrl = navigated ? await getTabUrl(ctx.tabId) : '';
    if (navigated && currentUrl && !isAliexpressUrl(currentUrl)) {
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
    const adopted = await adoptTaskTab(ctx);

    const seconds = next.scrollSeconds || settings.scrollSeconds;
    let actionRes;
    try {
      if (next.kind === 'surprise') {
        // Surpresas: 3 toques nesta rodada, com navegação orquestrada no
        // background (o content script morre na navegação para a ficha do item).
        // Diagnóstico: registra o resultado do GO (navegou? abriu/adotou aba?)
        // e onde o feed da rodada está — essencial para comparar com a origem.
        await appendLog(
          ctx,
          `Surpresas: GO clicado — navegou: ${navigated ? 'sim' : 'não'}, aba nova adotada: ${adopted ? 'sim' : 'não'} (feed: ${truncate(await getTabUrl(ctx.tabId), 70)}).`
        );
        actionRes = await runSurpriseTaps(ctx);
      } else {
        actionRes = await safeTaskCommand(
          ctx,
          CMD.RUN_ACTION,
          { kind: next.kind, query: settings.searchQuery, seconds, navigated },
          'action'
        );
        if (actionRes === null) {
          // Página sem content script: a tentativa já foi contada; segue (a
          // central já foi reaberta pela recuperação).
          actions += 1;
          stats.tasks.push({ title: next.title, kind: next.kind, result: 'error' });
          continue;
        }
      }
    } finally {
      await restoreTaskTab(ctx).catch(() => {});
    }

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
    const claimables = tasks.filter(
      (t) => t && t.isClaimable && !t.isDone && !claimed.has(claimKey(t)) && !claimed.has(taskKey(t))
    );
    if (claimables.length === 0) break;
    for (const t of claimables.slice(0, 3)) {
      const clicked = await safeTaskCmd(ctx, CMD.CLICK_TASK, { index: t.index, title: t.title });
      if (clicked === null) break;
      claimed.add(claimKey(t));
      stats.tasks.push({ title: t.title, kind: 'claim', result: 'claimed' });
      await appendLog(ctx, `Resgate solicitado: ${truncate(t.title, 60)}.`);
      await sleepAbortable(1200);
    }
  }
}
