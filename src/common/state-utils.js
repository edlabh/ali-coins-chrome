/**
 * Lógica pura da fila de tarefas do painel "Ganhe mais moedas".
 * Espelha a máquina de estados do ali-coins (libs/tasks/state.js):
 *  - tarefas resgatáveis (COLLECT/+N) têm prioridade;
 *  - tentativas por TÍTULO (maxAttemptsPerTask) e por RODADA
 *    (título + statusText, cap fixo de 3 — evita insistir numa rodada travada);
 *  - progresso observado no painel (avanço de rodada ou mudança de status)
 *    RESETA as tentativas e reabre a tarefa — o AliExpress atualiza o
 *    progresso com atraso e, sem isso, a rodada seguinte nunca era executada;
 *  - tarefas exclusivas do app (Prize Land, minigames, quizzes, avaliações)
 *    e "Explore itens surpresa" são puladas conforme configuração (nunca
 *    reabertas pelo progresso).
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
 * Chave da RODADA atual (título + status "n/m" exibido no card) — igual ao
 * getRoundKey do ali-coins. Cada avanço de rodada cria uma chave nova.
 * @param {object} task
 * @returns {string}
 */
export function roundKeyOf(task) {
  return `${taskKey(task)}:::${task?.statusText || ''}`;
}

/**
 * Chave de um resgate pendente (título + status + rótulo do botão): evita
 * re-clicar o MESMO resgate, mas permite novo resgate quando o estado mudar
 * (ex.: resgate por rodada em tarefas "n/m").
 * @param {object} task
 * @returns {string}
 */
export function claimKey(task) {
  return `${taskKey(task)}:::${task?.statusText || ''}:::${task?.btnText || ''}`;
}

/**
 * Zera tentativas (por título e por rodada) e limpa a falha residual de uma
 * tarefa. Usado quando o painel confirma progresso (a progressão do AliExpress
 * chega com atraso) ou após um resgate bem-sucedido — mesma mecânica do
 * resetTaskAttempt/resetTaskForProgress do ali-coins.
 * @param {{attempts?: object, roundAttempts?: object, failed?: object}} state
 * @param {object} task
 */
export function resetTaskTracking(state = {}, task = null) {
  if (!task) return;
  const key = taskKey(task);
  if (state.attempts) state.attempts[key] = 0;
  if (state.roundAttempts) {
    const prefix = `${key}:::`;
    for (const roundKey of Object.keys(state.roundAttempts)) {
      if (roundKey.startsWith(prefix)) delete state.roundAttempts[roundKey];
    }
  }
  if (state.failed && task.title && state.failed[task.title]) delete state.failed[task.title];
}

/**
 * Aplica o progresso observado no painel (mesma mecânica do applyTaskProgress
 * do ali-coins): avanço de `completedRounds` ou mudança de `statusText` RESETA
 * as tentativas da tarefa e limpa falha residual — sem isso, uma tarefa marcada
 * "sem progresso" segundos antes de a rodada avançar ficava bloqueada pelo
 * resto da execução (ex.: "Veja super descontos" 2/3 e 3/3 nunca executavam).
 * @param {Array<object>} tasks
 * @param {{attempts?: object, roundAttempts?: object, progressMap?: object, statusMap?: object, failed?: object, disabled?: Set<string>|null}} state
 * @returns {string[]} títulos que avançaram (para log)
 */
export function applyTaskProgress(tasks, state = {}) {
  const { attempts, roundAttempts, progressMap, statusMap, failed, disabled } = state;
  const advanced = [];
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t || !t.title) continue;
    if (disabled && disabled.has(t.title)) continue;
    let progressed = false;
    if (Number.isFinite(t.completedRounds)) {
      const prev =
        progressMap && Number.isFinite(progressMap[t.title]) ? progressMap[t.title] : -1;
      if (t.completedRounds > prev) {
        if (prev >= 0) progressed = true;
        if (progressMap) progressMap[t.title] = t.completedRounds;
      }
    }
    if (typeof t.statusText === 'string') {
      const prevStatus = statusMap ? statusMap[t.title] : undefined;
      if (prevStatus !== undefined && prevStatus !== t.statusText) progressed = true;
      if (statusMap) statusMap[t.title] = t.statusText;
    }
    if (progressed) {
      resetTaskTracking({ attempts, roundAttempts, failed }, t);
      advanced.push(t.title);
    }
  }
  return advanced;
}

/**
 * Candidatos à confirmação de progresso tardio: esgotaram as tentativas da
 * rodada atual e ainda não falharam — antes de desistir, o chamador relê o
 * painel após alguns segundos (mesma lista do selectLateProgressCandidates do
 * ali-coins; o status do AliExpress costuma chegar segundos depois).
 * @param {Array<object>} tasks
 * @param {{roundAttempts?: object, failed?: object, disabled?: Set<string>|null, maxRoundAttempts?: number, skipAppOnlyTasks?: boolean, skipSurpriseTask?: boolean}} options
 * @returns {Array<{title: string, key: string}>}
 */
export function selectLateProgressCandidates(tasks, options = {}) {
  const {
    roundAttempts = {},
    failed = {},
    disabled = null,
    maxRoundAttempts = 3,
    skipAppOnlyTasks = true,
    skipSurpriseTask = true
  } = options;
  const out = [];
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t || t.isDone || !t.title) continue;
    if (failed[t.title]) continue;
    if (disabled && disabled.has(t.title)) continue;
    const kind = t.kind || 'scroll';
    if (kind === 'surprise' && skipSurpriseTask) continue;
    if ((kind === 'app-only' || kind === 'prize-land') && skipAppOnlyTasks) continue;
    const roundKey = roundKeyOf(t);
    if ((roundAttempts[roundKey] || 0) >= maxRoundAttempts) {
      out.push({ title: t.title, key: roundKey });
    }
  }
  return out;
}

/**
 * Decide a próxima tarefa a executar.
 * @param {Array<object>} tasks lista extraída da gaveta
 * @param {Record<string, number>} attempts tentativas por chave (taskKey)
 * @param {object} options
 * @param {number} [options.maxAttemptsPerTask=3]
 * @param {boolean} [options.skipAppOnlyTasks=true]
 * @param {Set<string>} [options.claimed] chaves de claims já clicados (claimKey)
 * @param {object} [options.roundAttempts] tentativas por rodada (roundKeyOf)
 * @param {number} [options.maxRoundAttempts=3] cap de tentativas por rodada
 * @param {object} [options.failed] mapa título -> motivo (mutado ao esgotar)
 * @returns {null | (object & {action: 'claim' | 'run' | 'skip_app_only' | 'skip_surprise'})}
 */
export function pickNextTask(tasks, attempts = {}, options = {}) {
  const maxAttempts = Number.isFinite(options.maxAttemptsPerTask)
    ? options.maxAttemptsPerTask
    : 3;
  const skipAppOnly = options.skipAppOnlyTasks !== false;
  const skipSurprise = options.skipSurpriseTask !== false;
  const claimed = options.claimed instanceof Set ? options.claimed : new Set();
  const roundAttempts = options.roundAttempts || {};
  const failed = options.failed || {};
  const maxRoundAttempts = Number.isFinite(options.maxRoundAttempts)
    ? options.maxRoundAttempts
    : 3;
  const list = Array.isArray(tasks) ? tasks : [];

  // 1. Resgates pendentes (COLLECT / +N) — antes de qualquer nova navegação.
  for (const t of list) {
    if (!t || t.isDone || !t.title) continue;
    if (failed[t.title]) continue;
    if (t.isClaimable) {
      // Aceita chaves novas (claimKey) e legadas (taskKey) para compatibilidade.
      const key = claimKey(t);
      if (!claimed.has(key) && !claimed.has(taskKey(t))) {
        return { ...t, action: 'claim' };
      }
    }
  }

  // 2. Tarefas executáveis pendentes dentro dos limites de tentativas.
  for (const t of list) {
    if (!t || t.isDone || !t.title) continue;
    if (failed[t.title]) continue;

    // Cap por RODADA (título + status): sem progresso após N tentativas na
    // mesma rodada, a tarefa falha — evita insistir numa rodada travada.
    const roundsUsed = roundAttempts[roundKeyOf(t)] || 0;
    if (roundsUsed >= maxRoundAttempts) {
      failed[t.title] = failed[t.title] || `Sem progresso após ${maxRoundAttempts} tentativas na rodada`;
      continue;
    }

    const key = taskKey(t);
    const used = attempts[key] || 0;
    if (used >= maxAttempts) {
      failed[t.title] = failed[t.title] || `Limite de ${maxAttempts} tentativas atingido`;
      continue;
    }

    const kind = t.kind || 'scroll';

    // Rodadas pendentes também contam como executáveis (mesmo quando o rótulo
    // do botão não é o clássico GO/IR) — igual ao findNextPendingTask do
    // ali-coins, exceto quando o estilo indica botão desabilitado.
    const roundsPending =
      Number.isFinite(t.completedRounds) &&
      Number.isFinite(t.totalRounds) &&
      t.completedRounds < t.totalRounds &&
      !String(t.btnStyle || '').includes('opacity: 0.5');
    if (!t.isActionable && !roundsPending) continue;

    if ((kind === 'app-only' || kind === 'prize-land') && skipAppOnly) {
      return { ...t, action: 'skip_app_only' };
    }
    if (kind === 'surprise' && skipSurprise) {
      return { ...t, action: 'skip_surprise' };
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
 * v3: execução em segundo plano por padrão (a aba só aparece para captcha/2FA).
 * v4: teto de ações por execução sobe de 25 (padrão antigo) para 60.
 * v5: garante silentMode=true e keepWindowOpen=false em instalações existentes.
 * v6: remove login por credenciais (campos user/passwordEnc/passwordPlain/cryptoOk),
 *     o tempo máx. de captcha e o cooldown anti-bot (comportamentos fixos agora).
 */
export const SETTINGS_VERSION = 6;

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

  // v4: teto de ações por execução sobe de 25 (padrão antigo) para 60 — contas
  // novas podem ter mais tarefas do que o teto antigo concluiria num só run.
  if (fromVersion < 4) {
    if (settings.maxTaskActions === undefined || settings.maxTaskActions === 25) {
      settings.maxTaskActions = 60;
    }
    changed = true;
  }

  // v5: garante que execuções rodem exclusivamente em segundo plano (sem janelas
  // ou abas em primeiro plano).
  if (fromVersion < 5) {
    settings.silentMode = true;
    settings.keepWindowOpen = false;
    changed = true;
  }

  // v6: purge de campos legados — login por credenciais (nunca mais usado: o
  // login é manual), tempo máx. de captcha e cooldown anti-bot (removidos das
  // Opções: captcha/2FA/login aguardam sem limite e bloqueio anti-bot não pausa).
  const LEGACY_KEYS = [
    'user',
    'passwordEnc',
    'passwordPlain',
    'cryptoOk',
    'captchaTimeoutMin',
    'riskCooldownHours'
  ];
  for (const key of LEGACY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(settings, key)) {
      delete settings[key];
      changed = true;
    }
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
