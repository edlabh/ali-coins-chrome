/**
 * Lógica pura da fila de tarefas do painel "Ganhe mais moedas".
 * Espelha a máquina de estados simplificada do ali-coins (libs/tasks/state.js):
 *  - tarefas resgatáveis (COLLECT/+N) têm prioridade;
 *  - tarefas executáveis (GO/IR) rodam até `maxAttemptsPerTask` tentativas;
 *  - tarefas exclusivas do app (Prize Land, minigames, quizzes, avaliações)
 *    são puladas quando `skipAppOnlyTasks` estiver ligado.
 */

/**
 * Chave estável de uma tarefa para contagem de tentativas.
 * @param {{title?: string, desc?: string, index?: number}} task
 * @returns {string}
 */
export function taskKey(task) {
  const title = (task?.title || '').trim();
  const desc = (task?.desc || '').trim();
  if (title || desc) return `${title}::${desc}`.slice(0, 180);
  return `idx-${task?.index ?? 0}`;
}

/**
 * Decide a próxima tarefa a executar.
 * @param {Array<object>} tasks lista extraída da gaveta
 * @param {Record<string, number>} attempts tentativas por chave (taskKey)
 * @param {object} options
 * @param {number} [options.maxAttemptsPerTask=3]
 * @param {boolean} [options.skipAppOnlyTasks=true]
 * @param {Set<string>} [options.claimed] chaves de claims já clicados nesta execução
 * @returns {null | (object & {action: 'claim' | 'run' | 'skip_app_only'})}
 */
export function pickNextTask(tasks, attempts = {}, options = {}) {
  const maxAttempts = Number.isFinite(options.maxAttemptsPerTask)
    ? options.maxAttemptsPerTask
    : 3;
  const skipAppOnly = options.skipAppOnlyTasks !== false;
  const claimed = options.claimed instanceof Set ? options.claimed : new Set();
  const list = Array.isArray(tasks) ? tasks : [];

  // 1. Resgates pendentes (COLLECT / +N) — antes de qualquer nova navegação.
  for (const t of list) {
    if (!t || t.isDone) continue;
    const key = taskKey(t);
    if (t.isClaimable && !claimed.has(key)) {
      return { ...t, action: 'claim' };
    }
  }

  // 2. Tarefas executáveis pendentes dentro do limite de tentativas.
  for (const t of list) {
    if (!t || t.isDone || !t.isActionable) continue;
    const key = taskKey(t);
    const used = attempts[key] || 0;
    if (used >= maxAttempts) continue;
    const kind = t.kind || 'scroll';
    if ((kind === 'app-only' || kind === 'prize-land') && skipAppOnly) {
      return { ...t, action: 'skip_app_only' };
    }
    return { ...t, action: 'run', kind };
  }

  return null;
}

/**
 * Resume o progresso de uma lista de tarefas para o relatório.
 * @param {Array<object>} tasks
 */
export function summarizeTasks(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  return {
    total: list.length,
    done: list.filter((t) => t && t.isDone).length,
    actionable: list.filter((t) => t && t.isActionable && !t.isDone).length,
    claimable: list.filter((t) => t && t.isClaimable && !t.isDone).length
  };
}

/**
 * Versão do schema de configurações salvas.
 * v2: a janela mobile passa a ser fechada ao concluir (antes ficava aberta).
 * v3: execução em segundo plano por padrão (a aba só aparece para captcha/2FA);
 *     o run passa a gravar o extrato/log (v2 já incluía).
 */
export const SETTINGS_VERSION = 3;

/**
 * Migra configurações salvas por versões anteriores.
 * @param {object | undefined} stored
 * @returns {{settings: object, changed: boolean}}
 */
export function migrateSettings(stored) {
  const settings = { ...(stored || {}) };
  let changed = false;
  const fromVersion = Number.isFinite(settings.settingsVersion) ? settings.settingsVersion : 0;

  // v2: fechar a janela mobile ao concluir (o valor `true` era o antigo padrão).
  if (fromVersion < 2) {
    if (settings.keepWindowOpen === undefined || settings.keepWindowOpen === true) {
      settings.keepWindowOpen = false;
    }
    changed = true;
  }

  // v3: segundo plano por padrão. O `false` armazenado era o antigo padrão —
  // quem quiser acompanhar a execução desmarca nas Opções depois (o valor
  // explícito daí em diante é preservado, pois a versão passa a ser 3).
  if (fromVersion < 3) {
    if (settings.silentMode === undefined || settings.silentMode === false) {
      settings.silentMode = true;
    }
    changed = true;
  }

  if (changed || fromVersion !== SETTINGS_VERSION) {
    settings.settingsVersion = SETTINGS_VERSION;
    changed = true;
  }

  return { settings, changed };
}

/**
 * Decide se uma retentativa automática deve ser agendada após uma falha.
 * Apenas para erros (nunca bloqueio/parada/sucesso) e nunca a partir de uma
 * retentativa — garante no máximo 1 nova tentativa por falha, sem loop.
 * @param {{status?: string, reason?: string, retryOnFailure?: boolean}} params
 * @returns {boolean}
 */
export function shouldScheduleRetry({ status, reason, retryOnFailure = true } = {}) {
  if (retryOnFailure === false) return false;
  if (status !== 'error') return false;
  if (reason === 'retry') return false;
  return true;
}

/**
 * Verifica se um cancelamento foi pedido no run state.
 * @param {{stopRequested?: boolean} | null | undefined} runState
 */
export function isStopRequested(runState) {
  return Boolean(runState && runState.stopRequested === true);
}

/**
 * Reconstrói o JSON do relatório final (usado por popup/tests).
 * @param {object} input
 */
export function buildReport(input = {}) {
  const {
    runId = '',
    reason = 'manual',
    startedAt = 0,
    endedAt = 0,
    status = 'error',
    auth = null,
    checkin = null,
    balanceBefore = null,
    balanceAfter = null,
    tasks = [],
    skipped = [],
    errors = [],
    captchaEvents = 0,
    log = []
  } = input;

  const gained =
    Number.isFinite(balanceBefore) && Number.isFinite(balanceAfter)
      ? balanceAfter - balanceBefore
      : null;

  return {
    runId,
    reason,
    startedAt,
    endedAt,
    durationMs: endedAt && startedAt ? endedAt - startedAt : 0,
    status,
    auth,
    checkin,
    balanceBefore,
    balanceAfter,
    gained,
    tasks,
    skipped,
    errors,
    captchaEvents,
    log
  };
}
