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
  getRuntime,
  getSettings,
  patchRunState,
  patchRuntime
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
 * @returns {Promise<{started: boolean, alreadyRunning?: boolean, blockedUntil?: number|null}>}
 */
export async function startRun({ reason = 'manual', manual = false } = {}) {
  const existing = await getRunState();
  let staleUnlocked = false;
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

  const runtime = await getRuntime();
  if (manual === false && runtime.blockedUntil && Date.now() < runtime.blockedUntil) {
    return { started: false, blockedUntil: runtime.blockedUntil };
  }

  const settings = await getSettings();
  // Sem credenciais salvas também é permitido: o AliExpress pode já estar
  // logado no perfil. O login só é exigido quando a página pedir (ver auth.js),
  // com um aviso claro pedindo para configurar as Opções.
  const credentialsConfigured = Boolean(
    settings.user && (settings.passwordEnc || settings.passwordPlain)
  );

  // Uma nova execução supersede uma retentativa automática pendente.
  await clearRetry();

  const runId = crypto.randomUUID();
  const startedAt = Date.now();
  await patchRunState({
    active: true,
    runId,
    reason,
    phase: PHASE.STARTING,
    message: 'Preparando janela mobile…',
    startedAt,
    finishedAt: null,
    stopRequested: false,
    stats: { captchaEvents: 0, tasks: [], skipped: [], errors: [] },
    checkin: null,
    log: []
  });
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
  if (!credentialsConfigured) {
    await appendLog(
      ctx,
      'Sem credenciais salvas — executando com a sessão existente do AliExpress (o login será solicitado apenas se a sessão estiver inválida).'
    );
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

    // 1. Janela + regras de rede (Pixel 8) + primeira navegação JÁ em mobile.
    const win = await prepareRunTab(ctx.settings);
    ctx.windowId = win.windowId;
    ctx.tabId = win.tabId;
    await patchRunState({ tabId: ctx.tabId, windowId: ctx.windowId });
    await appendLog(
      ctx,
      ctx.settings.silentMode
        ? 'Modo silencioso: execução em segundo plano (nenhuma janela foi aberta).'
        : 'Janela mobile (Pixel 8) preparada com as regras de User-Agent.'
    );

    // Snapshot das abas da janela: a limpeza de abas órfãs só fecha o que foi
    // criado DURANTE o run — nunca abas pessoais (essencial no modo silencioso,
    // que compartilha uma janela normal do usuário).
    try {
      const windowTabs = await chrome.tabs.query({ windowId: ctx.windowId });
      ctx.knownTabIds = new Set(windowTabs.map((t) => t.id).filter(Boolean));
    } catch {
      ctx.knownTabIds = new Set();
    }

    // Cliques reais via CDP (isTrusted): o AliExpress ignora eventos sintéticos
    // em alguns botões (ex.: o painel "Ganhe mais moedas" não abria). O aviso de
    // depuração do Chrome aparece na janela; se indisponível, o content script
    // cai no fallback sintético sozinho.
    const cdpReady = await attachCdp(ctx.tabId).catch(() => false);
    await appendLog(
      ctx,
      cdpReady
        ? 'Cliques confiáveis (CDP) ativos para esta execução.'
        : 'CDP indisponível (aviso de depuração cancelado?) — usando eventos sintéticos como fallback.'
    );

    // Modo silencioso: emula a viewport do aparelho na aba de fundo via CDP
    // (o layout renderiza em 412×915 mesmo oculto numa janela desktop).
    if (ctx.settings.silentMode) {
      if (cdpReady) {
        const emuOk = await applySilentEmulation(ctx.tabId, ctx.settings).catch(() => false);
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

    if (blocked) {
      const blockedUntil = Date.now() + settings.riskCooldownHours * 3600 * 1000;
      await patchRuntime({ blockedUntil });
    }

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
    // 'retry' nunca retenta de novo — evita loop.
    if (shouldScheduleRetry({ status, reason, retryOnFailure: settings.retryOnFailure })) {
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
