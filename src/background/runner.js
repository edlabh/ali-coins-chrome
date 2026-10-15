/**
 * Orquestrador da execução (runner fino).
 *
 * O fluxo é dirigido pelo service worker, que delega cada fase aos módulos:
 *   context.js        primitivas compartilhadas (comandos, logs, esperas, erros)
 *   gates.js          captcha e 2FA (intervenção do usuário)
 *   auth.js           verificação de sessão / login automático
 *   ledger-read.js    leitura do extrato desktop (mycoin)
 *   checkin-phase.js  check-in + contabilidade (valores, saldo, sequência)
 *   tasks-phase.js    painel "Ganhe mais moedas"
 *   finalize.js       contabilidade final, relatório e política de janela
 *
 * Estado vive em chrome.storage (runState em storage.session), o que torna o
 * run resiliente a navegações completas e a reinícios do service worker (MV3).
 */

import { CMD, PHASE, RUN_STATUS } from '../common/constants.js';
import { randInt } from '../common/schedule.js';
import { buildReport, shouldScheduleRetry } from '../common/state-utils.js';
import {
  getRunState,
  getSettings,
  patchRunState
} from './storage.js';
import { applySilentEmulation, attachCdp } from './cdp.js';
import { ensureAuthenticated } from './auth.js';
import { runCheckinPhase } from './checkin-phase.js';
import {
  RunAbortedError,
  RunBlockedError,
  appendLog,
  isStopRequestedNow,
  sleepAbortable,
  updatePhase
} from './context.js';
import { applyWindowPolicy, finalize, runFinalAccounting } from './finalize.js';
import { setBadge } from './notify.js';
import { clearRetry, scheduleRetry } from './retry.js';
import { runTasksPhase } from './tasks-phase.js';
import { closeOrphanTabs, prepareRunTab } from './tabs.js';

const KEEPALIVE_MS = 20000;
// Um run sem NENHUMA atualização de estado por este tempo é considerado órfão
// (ex.: service worker morto no meio). Heartbeats mantêm updatedAt fresco.
const RUN_STALE_MS = 15 * 60 * 1000;
let keepAliveTimer = null;
// Lock síncrono em memória para evitar que dois gatilhos simultâneos (ex.:
// onStartup + alarme ou duplo clique) passem pela checagem antes de gravar active=true.
let startingLock = false;

/** Mantém o service worker vivo durante o run (MV3 encerra o SW ocioso em ~30s). */
function startKeepAlive() {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => {
    // Qualquer chamada de API da extensão reinicia o timer de idle do SW.
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, KEEPALIVE_MS);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function reasonLabel(reason) {
  if (reason === 'schedule') return 'agendamento diário';
  if (reason === 'catchup') return 'recuperação de agenda (Chrome estava fechado)';
  if (reason === 'retry') return 'nova tentativa automática';
  if (reason === 'startup') return 'abertura do Chrome';
  return 'execução manual';
}

/**
 * Ponto de entrada do run. Não lança: sempre finaliza com relatório.
 * @param {{reason?: string, manual?: boolean}} options
 * @returns {Promise<{started: boolean, alreadyRunning?: boolean}>}
 */
export async function startRun({ reason = 'manual', manual = false } = {}) {
  if (startingLock) {
    return { started: false, alreadyRunning: true };
  }
  startingLock = true;

  let runId;
  let startedAt;
  let settings;
  let staleUnlocked = false;
  try {
    const existing = await getRunState();
    if (existing && existing.active) {
      const updatedAt = Number.isFinite(existing.updatedAt) ? existing.updatedAt : 0;
      if (Date.now() - updatedAt > RUN_STALE_MS) {
        // Estado órfão (SW morto no meio do run): destrava para não bloquear
        // execuções futuras para sempre.
        staleUnlocked = true;
        await patchRunState({
          active: false,
          phase: PHASE.ERROR,
          message: 'Execução anterior órfã destravada.',
          stopRequested: false
        });
      } else {
        return { started: false, alreadyRunning: true };
      }
    }

    settings = await getSettings();

    // Uma nova execução supersede uma retentativa automática pendente.
    await clearRetry();

    runId = crypto.randomUUID();
    startedAt = Date.now();
    await patchRunState({
      active: true,
      runId,
      reason,
      silentMode: Boolean(settings.silentMode),
      phase: PHASE.STARTING,
      message: 'Preparando janela mobile…',
      startedAt,
      finishedAt: null,
      stopRequested: false,
      stats: { captchaEvents: 0, tasks: [], skipped: [], errors: [] },
      checkin: null,
      log: []
    });
  } finally {
    startingLock = false;
  }
  await setBadge('RUN', 'run');
  startKeepAlive();

  const stats = { captchaEvents: 0, tasks: [], skipped: [], errors: [], taskAttempts: {} };
  const ctx = {
    settings,
    runId,
    reason,
    startedAt,
    stats,
    tabId: null,
    windowId: null,
    balanceBefore: null,
    log: []
  };

  await appendLog(ctx, `Execução iniciada (${reasonLabel(reason)}).`);
  if (staleUnlocked) {
    await appendLog(ctx, 'Execução anterior órfã (>15 min sem atividade) foi destravada.');
  }

  let status = RUN_STATUS.SUCCESS;
  let checkin = null;
  let auth = null;

  try {
    // Atraso inicial aleatório (apenas agendado/startup, espelhando START_DELAY_* do ali-coins).
    if (!manual && settings.startDelayMaxMin > 0) {
      const delayMs = randInt(0, settings.startDelayMaxMin * 60 * 1000);
      if (delayMs > 5000) {
        await updatePhase(PHASE.WAITING_DELAY, `Aguardando início em até ${settings.startDelayMaxMin} min…`);
        await sleepAbortable(delayMs);
      }
    }

    if (await isStopRequestedNow()) throw new RunAbortedError();

    // 1. Janela/aba de fundo + snapshot de abas + CDP (viewport 412×915) ANTES
    // da primeira navegação, para que nenhuma aba apareça em primeiro plano e o
    // primeiro load já seja mobile.
    let cdpReady = false;
    let emuOk = false;
    const win = await prepareRunTab(ctx.settings, {
      onTabCreated: async (createdWin) => {
        ctx.windowId = createdWin.windowId;
        ctx.tabId = createdWin.tabId;
        try {
          const windowTabs = await chrome.tabs.query({ windowId: ctx.windowId });
          ctx.knownTabIds = new Set(windowTabs.map((t) => t.id).filter(Boolean));
        } catch {
          ctx.knownTabIds = new Set();
        }
        let userTabId = null;
        try {
          const activeTabs = await chrome.tabs.query({ active: true, windowId: ctx.windowId });
          const other = activeTabs.find((t) => t.id && t.id !== ctx.tabId);
          userTabId = other ? other.id : null;
        } catch {
          // mantém null
        }
        ctx.userTabId = userTabId;
        await patchRunState({
          tabId: ctx.tabId,
          windowId: ctx.windowId,
          knownTabIds: [...ctx.knownTabIds],
          userTabId
        });

        cdpReady = await attachCdp(ctx.tabId).catch(() => false);
        if (ctx.settings.silentMode && cdpReady) {
          emuOk = await applySilentEmulation(ctx.tabId, ctx.settings).catch(() => false);
        }
      }
    });
    ctx.windowId = win.windowId;
    ctx.tabId = win.tabId;

    await appendLog(
      ctx,
      ctx.settings.silentMode
        ? 'Modo silencioso: execução em segundo plano (nenhuma janela/aba em primeiro plano).'
        : 'Janela mobile (Pixel 8) preparada com as regras de User-Agent.'
    );
    await appendLog(
      ctx,
      cdpReady
        ? 'Cliques confiáveis (CDP) ativos para esta execução.'
        : 'CDP indisponível (aviso de depuração cancelado?) — usando eventos sintéticos como fallback.'
    );
    if (ctx.settings.silentMode) {
      if (cdpReady) {
        await appendLog(
          ctx,
          emuOk
            ? 'Emulação de viewport 412×915 aplicada à aba de fundo.'
            : 'Emulação de viewport indisponível; o layout pode variar no modo silencioso.'
        );
      } else {
        await appendLog(
          ctx,
          'Modo silencioso solicitado, mas o CDP está indisponível (aviso de depuração cancelado?) — o layout pode variar.'
        );
      }
    }

    // 2. Autenticação — SOMENTE se a sessão ainda não estiver ativa.
    auth = await ensureAuthenticated(ctx);
    if (!auth.ok) {
      throw new Error(auth.error || 'Falha de autenticação.');
    }

    // 3. Check-in + contabilidade (fase própria; inclui auto-cura de sessão)
    const checkinPhase = await runCheckinPhase(ctx, auth);
    checkin = checkinPhase.checkin;

    // 4. Tarefas
    await updatePhase(PHASE.TASKS, 'Executando tarefas "Ganhe mais moedas"…');
    await runTasksPhase(ctx);
    await closeOrphanTabs(
      ctx.windowId,
      ctx.tabId,
      ctx.ledgerTabId ? [ctx.ledgerTabId] : [],
      ctx.knownTabIds
    ).catch(() => {});

    // 5. Contabilidade final + relatório
    const { balanceAfter, tasksGained, ledgerSummary } = await runFinalAccounting(
      ctx,
      checkin,
      checkinPhase.initialBalanceForTasks,
      checkinPhase.postMissions
    );

    if (stats.errors.length > 0) status = RUN_STATUS.PARTIAL;

    const report = buildReport({
      runId,
      reason,
      startedAt,
      endedAt: Date.now(),
      status,
      auth: { ok: true, already: Boolean(auth.already) },
      checkin,
      balanceBefore: ctx.balanceBefore,
      balanceAfter,
      tasks: stats.tasks,
      skipped: stats.skipped,
      errors: stats.errors,
      captchaEvents: stats.captchaEvents,
      log: ctx.log
    });
    report.tasksGained = tasksGained;
    report.ledger = ledgerSummary;
    await finalize(report, settings, true);
    return { started: true };
  } catch (err) {
    const aborted = err instanceof RunAbortedError;
    const blocked = err instanceof RunBlockedError;
    status = aborted ? RUN_STATUS.STOPPED : blocked ? RUN_STATUS.BLOCKED : RUN_STATUS.ERROR;
    if (!aborted) stats.errors.push(err.message);

    const report = buildReport({
      runId,
      reason,
      startedAt,
      endedAt: Date.now(),
      status,
      auth: auth ? { ok: Boolean(auth.ok), already: Boolean(auth.already) } : null,
      checkin,
      balanceBefore: ctx.balanceBefore,
      balanceAfter: null,
      tasks: stats.tasks,
      skipped: stats.skipped,
      errors: stats.errors,
      captchaEvents: stats.captchaEvents,
      log: ctx.log
    });
    await finalize(report, settings, false);

    // Falha (não bloqueio/parada): agenda UMA retentativa automática. O motivo
    // 'retry' nunca retenta de novo — evita loop. Login manual exigido é a
    // exceção: o usuário foi avisado para entrar e executar novamente — uma
    // retentativa só repetiria o erro e roubaria o foco da tela de login.
    if (
      !ctx.manualLoginRequired &&
      shouldScheduleRetry({ status, reason, retryOnFailure: settings.retryOnFailure })
    ) {
      await scheduleRetry().catch(() => {});
      await appendLog(
        ctx,
        'Falha na execução — nova tentativa automática agendada para daqui a ~45 min.'
      );
    }
    return { started: true };
  } finally {
    stopKeepAlive();
    await applyWindowPolicy(ctx, settings);
  }
}

/**
 * Marca a execução como cancelada (chamado pelo popup).
 * Avisa também o content script para interromper loops longos (scroll, espera de captcha).
 */
export async function requestStop() {
  const state = await getRunState();
  if (!state || !state.active) return false;
  await patchRunState({ stopRequested: true, message: 'Cancelando…' });
  if (state.tabId) {
    chrome.tabs
      .sendMessage(state.tabId, { type: CMD.ABORT, payload: { runId: state.runId } })
      .catch(() => {});
  }
  await setBadge('…', 'idle');
  return true;
}
