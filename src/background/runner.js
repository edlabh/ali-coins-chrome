/**
 * Orquestrador da execução (máquina de estados no background).
 *
 * Diferença de fundo em relação ao ali-coins: aqui o fluxo é dirigido pelo service
 * worker, que envia comandos curtos ao content script a cada página. Isso torna o
 * run resiliente a navegações completas (busca, fichas de produto) e a reinícios do
 * próprio service worker (MV3), pois todo o estado vive em chrome.storage.
 *
 * Fluxo: auth -> checkin -> tasks -> finalize, com gate de captcha em qualquer passo.
 */

import { CMD, PHASE, RUN_STATUS } from '../common/constants.js';
import { formatDuration, randInt } from '../common/schedule.js';
import { buildReport, pickNextTask, taskKey } from '../common/state-utils.js';
import {
  getPassword,
  getRunState,
  getRuntime,
  getSettings,
  patchRunState,
  patchRuntime,
  pushReport
} from './storage.js';
import {
  applyDeviceRules,
  closeOrphanTabs,
  focusWindow,
  isCoinUrl,
  navigateTab,
  prepareRunTab,
  sleep,
  waitTabComplete
} from './tabs.js';
import { notifyCaptcha, notifyResult, setBadge } from './notify.js';
import { COIN_URL_TASKS } from '../common/constants.js';

const KEEPALIVE_MS = 20000;
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

class RunAbortedError extends Error {
  constructor(reason) {
    super(reason || 'Execução cancelada.');
    this.name = 'RunAbortedError';
  }
}

class RunBlockedError extends Error {
  constructor(message) {
    super(message || 'Bloqueio anti-bot detectado.');
    this.name = 'RunBlockedError';
  }
}

/**
 * Ponto de entrada do run. Não lança: sempre finaliza com relatório.
 * @param {{reason?: string, manual?: boolean}} options
 * @returns {Promise<{started: boolean, alreadyRunning?: boolean, blockedUntil?: number|null}>}
 */
export async function startRun({ reason = 'manual', manual = false } = {}) {
  const existing = await getRunState();
  if (existing && existing.active) {
    return { started: false, alreadyRunning: true };
  }

  const runtime = await getRuntime();
  if (manual === false && runtime.blockedUntil && Date.now() < runtime.blockedUntil) {
    return { started: false, blockedUntil: runtime.blockedUntil };
  }

  const settings = await getSettings();
  if (!settings.user) {
    await notifyResult(settings, false, 'Configure usuário e senha na página de opções da extensão.');
    return { started: false };
  }

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
    stats: { captchaEvents: 0, tasks: [], skipped: [], errors: [] }
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
    abortableSleep: sleepAbortable
  };

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
    // prepareRunTab cria a janela em about:blank, aplica as regras de UA na aba
    // e só então navega para a central de moedas (com #ac_run=1, consumido pelo
    // content script para o spoof de navigator no MAIN world).
    const win = await prepareRunTab(ctx.settings);
    ctx.windowId = win.windowId;
    ctx.tabId = win.tabId;
    await patchRunState({ tabId: ctx.tabId, windowId: ctx.windowId });

    // 2. Autenticação — SOMENTE se a sessão ainda não estiver ativa.
    auth = await ensureAuthenticated(ctx);
    if (!auth.ok) {
      throw new Error(auth.error || 'Falha de autenticação.');
    }

    // Sessão recém-criada: recarrega a central de moedas para partir do estado
    // limpo. Quando a sessão já existia, a página atual já está pronta.
    if (!auth.already) {
      await ensureCoinPage(ctx, true);
    }

    // 3. Check-in (com auto-cura: se a sessão caiu, autentica e tenta de novo)
    await updatePhase(PHASE.CHECKIN, 'Realizando check-in diário…');
    checkin = await commandWithCaptcha(ctx, CMD.DO_CHECKIN, {}, 'checkin');
    if (checkin && checkin.needsLogin) {
      const retryAuth = await ensureAuthenticated(ctx);
      if (!retryAuth.ok) throw new Error(retryAuth.error || 'Falha de autenticação.');
      await ensureCoinPage(ctx, true);
      checkin = await commandWithCaptcha(ctx, CMD.DO_CHECKIN, {}, 'checkin');
    }
    ctx.balanceBefore = toNumberOrNull(checkin.balance);
    await patchRunState({ stats: { ...stats } });

    // 4. Tarefas
    await updatePhase(PHASE.TASKS, 'Executando tarefas "Ganhe mais moedas"…');
    await runTasksPhase(ctx);
    await closeOrphanTabs(ctx.windowId, ctx.tabId).catch(() => {});

    // 5. Saldo final
    await updatePhase(PHASE.FINALIZING, 'Lendo saldo final…');
    await ensureCoinPage(ctx, true);
    const balanceRead = await commandWithCaptcha(ctx, CMD.READ_BALANCE, {}, 'balance');
    const balanceAfter = toNumberOrNull(balanceRead.balance);

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
      captchaEvents: stats.captchaEvents
    });
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
      captchaEvents: stats.captchaEvents
    });
    await finalize(report, settings, false);
    return { started: true };
  } finally {
    stopKeepAlive();
    await applyWindowPolicy(ctx, settings);
  }
}

/**
 * Fecha a janela no fim do run conforme a preferência (keepWindowOpen).
 */
async function applyWindowPolicy(ctx, settings) {
  if (!ctx.windowId) return;
  if (settings.keepWindowOpen) return;
  await chrome.windows.remove(ctx.windowId).catch(() => {});
}

async function finalize(report, settings, ok) {
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
  await notifyResult(settings, ok, describeReport(report));
}

function mapErrorPhase(status) {
  if (status === RUN_STATUS.STOPPED) return PHASE.STOPPED;
  if (status === RUN_STATUS.BLOCKED) return PHASE.BLOCKED;
  return PHASE.ERROR;
}

function describeReport(report) {
  const parts = [];
  if (report.checkin) {
    if (report.checkin.already) parts.push('check-in já feito hoje');
    else if (report.checkin.justCollected) parts.push(`check-in +${report.checkin.coins ?? '?'} moedas`);
  }
  const acted = (report.tasks || []).length;
  if (acted) parts.push(`${acted} ação(ões) de tarefas`);
  if (report.gained !== null) parts.push(`saldo ${report.gained >= 0 ? '+' : ''}${report.gained}`);
  parts.push(`duração ${formatDuration(report.durationMs)}`);
  if (report.status !== RUN_STATUS.SUCCESS) parts.push(`status: ${report.status}`);
  return parts.join(' • ');
}

/**
 * Verificação de cookie forte de sessão, usada como desempate quando a UI demora
 * a decidir se está autenticada (ex.: rede lenta). O login_aliyunid_ticket só é
 * emitido com autenticação bem-sucedida.
 * @returns {Promise<boolean>}
 */
async function hasAuthCookie() {
  try {
    const ticket = await chrome.cookies.get({
      url: 'https://www.aliexpress.com/',
      name: 'login_aliyunid_ticket'
    });
    return Boolean(ticket && ticket.value);
  } catch {
    return false;
  }
}

/**
 * Garante que a sessão está autenticada SEM tentar login desnecessário:
 *   1. consulta o estado da página (CHECK_AUTH — somente leitura);
 *   2. só dispara o fluxo de login quando há formulário/prompt de login visível;
 *   3. UI indecisa por muito tempo → decide pelo cookie de sessão.
 * @param {object} ctx
 * @returns {Promise<{ok: boolean, already?: boolean, cookieOnly?: boolean, error?: string}>}
 */
async function ensureAuthenticated(ctx) {
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
      return { ok: true, already: true };
    }
    if (st.state === 'needs_login') {
      break;
    }
    // 'pending': esqueleto do SPA ainda carregando.
    await sleepAbortable(1800);
  }

  // UI não decidiu dentro da janela: o cookie de sessão decide.
  if (await hasAuthCookie()) {
    await updatePhase(PHASE.AUTH, 'Cookie de sessão presente; login dispensado.');
    return { ok: true, already: true, cookieOnly: true };
  }

  await updatePhase(PHASE.AUTH, 'Login necessário. Autenticando no AliExpress…');
  return await authenticate(ctx);
}

/**
 * Executa o plano de autenticação: DO_LOGIN em loop, tratando captcha/2FA.
 */
async function authenticate(ctx) {
  const password = await getPassword(ctx.settings);
  if (!password) {
    return { ok: false, error: 'Senha não configurada.' };
  }

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

/**
 * Gate de captcha: foca a janela, notifica o usuário e aguarda a resolução
 * (em fatias de 60s para não estourar limites de mensagem).
 */
async function captchaGate(ctx, origin) {
  ctx.stats.captchaEvents += 1;
  await updatePhase(PHASE.CAPTCHA, 'Aguardando você resolver o captcha na janela aberta…');
  await focusWindow(ctx.windowId);
  await notifyCaptcha(ctx.settings);

  const deadline = Date.now() + ctx.settings.captchaTimeoutMin * 60 * 1000;
  while (Date.now() < deadline) {
    if (await isStopRequestedNow()) throw new RunAbortedError();
    const remaining = deadline - Date.now();
    const chunkMs = Math.min(60000, Math.max(5000, remaining));
    const res = await cmd(ctx, CMD.WAIT_CAPTCHA, { chunkMs, origin }, { retries: 2 });
    if (res.solved) {
      await setBadge('RUN', 'run');
      return;
    }
    if (res.blocked) {
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
async function twoFAGate(ctx) {
  await updatePhase(PHASE.TWO_FA, 'Digite o código de verificação 2FA na janela aberta…');
  await focusWindow(ctx.windowId);
  const deadline = Date.now() + ctx.settings.captchaTimeoutMin * 60 * 1000;
  while (Date.now() < deadline) {
    if (await isStopRequestedNow()) throw new RunAbortedError();
    const res = await cmd(ctx, CMD.WAIT_2FA, { chunkMs: 60000 }, { retries: 2 });
    if (res.ok) return;
  }
  throw new Error('Tempo esgotado aguardando o código 2FA.');
}

/**
 * Executa um comando tratando interrupções de captcha de forma transparente:
 * se a página indicar captcha, abre o gate e repete o comando (até 3 vezes).
 */
async function commandWithCaptcha(ctx, type, payload = {}, label = '') {
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

/** Fase de tarefas: abre a gaveta, extrai, executa, resgata e repete. */
async function runTasksPhase(ctx) {
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
      break;
    }

    const extraction = await commandWithCaptcha(ctx, CMD.EXTRACT_TASKS, {}, 'tasks');
    const tasks = (extraction && extraction.tasks) || [];

    // Marca em lote as tarefas exclusivas do app (evita reabrir a gaveta por tarefa).
    if (settings.skipAppOnlyTasks) {
      for (const t of tasks) {
        if (!t) continue;
        const kind = t.kind || 'scroll';
        if (kind !== 'app-only' && kind !== 'prize-land') continue;
        const key = taskKey(t);
        if ((attempts[key] || 0) < settings.maxAttemptsPerTask) {
          attempts[key] = settings.maxAttemptsPerTask;
          if (!stats.skipped.includes(t.title)) stats.skipped.push(t.title || '(sem título)');
        }
      }
    }

    const next = pickNextTask(tasks, attempts, {
      maxAttemptsPerTask: settings.maxAttemptsPerTask,
      skipAppOnlyTasks: settings.skipAppOnlyTasks,
      claimed
    });

    if (!next) break;

    const key = taskKey(next);

    if (next.action === 'skip_app_only') {
      attempts[key] = settings.maxAttemptsPerTask; // não re-seleciona
      if (!stats.skipped.includes(next.title)) stats.skipped.push(next.title || '(sem título)');
      await updatePhase(PHASE.TASKS, `Ignorando tarefa exclusiva do app: ${truncate(next.title, 48)}`);
      continue;
    }

    if (next.action === 'claim') {
      await cmd(ctx, CMD.CLICK_TASK, { index: next.index, title: next.title }, { retries: 2 });
      claimed.add(key);
      actions += 1;
      stats.tasks.push({ title: next.title, kind: 'claim', result: 'claimed' });
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
    await patchRunState({ stats: { ...stats } });

    await ensureCoinPage(ctx, false);
    await closeOrphanTabs(ctx.windowId, ctx.tabId).catch(() => {});

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
      await sleepAbortable(1200);
    }
  }
}

/**
 * Aguarda uma possível navegação completa após clicar em "GO/IR".
 * @returns {Promise<boolean>} true se a URL mudou
 */
async function waitPossibleNavigation(ctx, timeoutMs) {
  const before = await getTabUrl(ctx.tabId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(400);
    const now = await getTabUrl(ctx.tabId);
    if (now && now !== before) {
      await waitTabComplete(ctx.tabId, 30000);
      await sleep(1000);
      return true;
    }
  }
  return false;
}

async function getTabUrl(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.url || '';
  } catch {
    return '';
  }
}

/**
 * Garante que a aba principal está na central de moedas.
 * @param {object} ctx
 * @param {boolean} force força navegação mesmo se já parecer na URL
 */
async function ensureCoinPage(ctx, force = false) {
  const url = await getTabUrl(ctx.tabId);
  if (!isCoinUrl(url) || force) {
    await navigateTab(ctx.tabId, COIN_URL_TASKS);
    await applyDeviceRules(ctx.tabId, ctx.settings);
  }
}

/** Envia um comando ao content script com retries (aguardando o script ficar pronto). */
async function cmd(ctx, type, payload = {}, { retries = 3 } = {}) {
  let lastErr = null;
  for (let i = 0; i < retries; i += 1) {
    try {
      const res = await chrome.tabs.sendMessage(ctx.tabId, {
        type,
        payload: { ...payload, runId: ctx.runId }
      });
      return res || {};
    } catch (err) {
      lastErr = err;
      // Content script pode ainda não ter sido injetado após navegação: aguarda e tenta de novo.
      await sleep(900);
    }
  }
  throw new Error(
    `Sem resposta do content script para ${type}: ${lastErr ? lastErr.message : 'desconhecido'}`
  );
}

async function updatePhase(phase, message) {
  await patchRunState({ phase, message });
}

async function isStopRequestedNow() {
  const state = await getRunState();
  return Boolean(state && state.stopRequested);
}

async function sleepAbortable(ms) {
  const step = 500;
  let waited = 0;
  while (waited < ms) {
    if (await isStopRequestedNow()) throw new RunAbortedError();
    const chunk = Math.min(step, ms - waited);
    await sleep(chunk);
    waited += chunk;
  }
}

function toNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number.parseInt(String(value).replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function truncate(text, max) {
  const t = String(text || '').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
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
