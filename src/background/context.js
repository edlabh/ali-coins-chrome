/**
 * Primitivas compartilhadas do orquestrador (runner) e das fases:
 * comunicação com o content script, estado do run, logs e esperas abortáveis.
 */

import { RUN_LOG_LIMIT } from '../common/constants.js';
import { getRunState, patchRunState } from './storage.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RunAbortedError extends Error {
  constructor(reason) {
    super(reason || 'Execução cancelada.');
    this.name = 'RunAbortedError';
  }
}

export class RunBlockedError extends Error {
  constructor(message) {
    super(message || 'Bloqueio anti-bot detectado.');
    this.name = 'RunBlockedError';
  }
}

/**
 * Anexa uma linha ao extrato da execução (persistido no run state para o popup
 * acompanhar ao vivo e para o relatório final no histórico).
 * @param {object} ctx
 * @param {string} message
 */
export async function appendLog(ctx, message) {
  if (!ctx || !Array.isArray(ctx.log)) return;
  ctx.log.push({ t: Date.now(), msg: String(message).slice(0, 220) });
  if (ctx.log.length > RUN_LOG_LIMIT) {
    ctx.log.splice(0, ctx.log.length - RUN_LOG_LIMIT);
  }
  await patchRunState({ log: ctx.log }).catch(() => {});
}

export async function updatePhase(phase, message) {
  await patchRunState({ phase, message });
}

export async function isStopRequestedNow() {
  const state = await getRunState();
  return Boolean(state && state.stopRequested);
}

/**
 * Espera abortável com heartbeat: mantém `updatedAt` fresco (detecção de runs
 * órfãos) e interrompe quando um cancelamento é pedido.
 * @param {number} ms
 */
export async function sleepAbortable(ms) {
  const step = 500;
  let waited = 0;
  let sinceHeartbeat = 0;
  while (waited < ms) {
    if (await isStopRequestedNow()) throw new RunAbortedError();
    const chunk = Math.min(step, ms - waited);
    await sleep(chunk);
    waited += chunk;
    sinceHeartbeat += chunk;
    if (sinceHeartbeat >= 60000) {
      sinceHeartbeat = 0;
      await patchRunState({}).catch(() => {});
    }
  }
}

/** Envia um comando a uma aba específica com retries (aguardando o content script). */
export async function sendCmd(ctx, tabId, type, payload = {}, { retries = 3 } = {}) {
  let lastErr = null;
  for (let i = 0; i < retries; i += 1) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, {
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
  // Marca o erro para o chamador diferenciar "aba fora do escopo do content
  // script" (página de terceiros) de outras falhas e recuperar sem abortar.
  const err = new Error(
    `Sem resposta do content script para ${type}: ${lastErr ? lastErr.message : 'desconhecido'}`
  );
  err.noContentScript = true;
  throw err;
}

/** Indica erro de comando sem content script na aba (página fora do escopo). */
export function isNoContentScriptError(err) {
  return Boolean(err && err.noContentScript === true);
}

/** Envia um comando à aba principal (mobile) de execução. */
export async function cmd(ctx, type, payload = {}, opts) {
  return sendCmd(ctx, ctx.tabId, type, payload, opts);
}
