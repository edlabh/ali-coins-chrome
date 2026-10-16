/**
 * Testes unitários (node --test) da lógica pura: agendamento, fila de tarefas,
 * classificação de tarefas e sanidade do manifest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import path from 'node:path';

import { computeNextRunAt, parseTimeOfDay, formatDuration, randInt, shouldCatchUp } from '../src/common/schedule.js';
import { statusLabel, coinsSourceLabel, fmtNumber } from '../src/common/format.js';
import {
  applyTaskProgress,
  claimKey,
  pickNextTask,
  roundKeyOf,
  selectLateProgressCandidates,
  taskKey,
  buildReport,
  summarizeTasks,
  migrateSettings,
  SETTINGS_VERSION,
  shouldScheduleRetry
} from '../src/common/state-utils.js';
import { sendCmd, isNoContentScriptError, appendLog } from '../src/background/context.js';
import { getRunState, patchRunState, saveSettings as saveSettingsStorage } from '../src/background/storage.js';
import {
  accountingDateKey,
  getSurpriseTapped,
  saveSurpriseTapped
} from '../src/background/storage.js';
import { ensureCoinPage, isCoinUrl } from '../src/background/tabs.js';
import { clearDeviceRules, prepareRunTab, registerAuxTab, unregisterAuxTab } from '../src/background/tabs.js';
import { ensureAuthenticated } from '../src/background/auth.js';
import { applyWindowPolicy, describeReport } from '../src/background/finalize.js';
import {
  coinsFromStreak,
  streakFromCoins,
  resolveCheckinCoins,
  computeCheckinCoinsGained,
  computeTasksCoinsGained,
  isStreakBreak,
  resolveStreakDays,
  syncBalanceWithCheckin,
  accountCheckin,
  desktopStreakOf,
  protectConsolidatedStreak
} from '../src/common/accounting.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

/** Avalia o arquivo UMD task-classify.js como CommonJS para obter as funções. */
function loadTaskClassify() {
  const code = readFileSync(path.join(root, 'src/content/task-classify.js'), 'utf8');
  const moduleObj = { exports: {} };
   
  const fn = new Function('module', 'exports', 'self', `${code}\nreturn module.exports;`);
  return fn(moduleObj, moduleObj.exports, undefined);
}

// ---------------------------------------------------------------------------
// Agendamento
// ---------------------------------------------------------------------------

test('parseTimeOfDay aceita HH:MM válido e rejeita inválidos', () => {
  assert.deepEqual(parseTimeOfDay('09:30'), { hours: 9, minutes: 30 });
  assert.deepEqual(parseTimeOfDay('23:59'), { hours: 23, minutes: 59 });
  assert.equal(parseTimeOfDay('24:00'), null);
  assert.equal(parseTimeOfDay('9:5'), null);
  assert.equal(parseTimeOfDay('abc'), null);
});

test('computeNextRunAt usa hoje quando o horário ainda não passou', () => {
  const now = new Date(2026, 0, 10, 8, 0, 0);
  const next = computeNextRunAt('09:30', now);
  assert.equal(new Date(next).getDate(), 10);
  assert.equal(new Date(next).getHours(), 9);
  assert.equal(new Date(next).getMinutes(), 30);
});

test('computeNextRunAt usa amanhã quando o horário já passou', () => {
  const now = new Date(2026, 0, 10, 10, 0, 0);
  const next = computeNextRunAt('09:30', now);
  assert.equal(new Date(next).getDate(), 11);
});

test('formatDuration e randInt funcionam como esperado', () => {
  assert.equal(formatDuration(65000), '1m 5s');
  assert.equal(formatDuration(8000), '8s');
  assert.equal(formatDuration(-1), '—');
  for (let i = 0; i < 50; i += 1) {
    const v = randInt(5, 10);
    assert.ok(v >= 5 && v <= 10);
  }
});

test('shouldCatchUp: recupera a agenda perdida com o Chrome fechado', () => {
  const now = Date.now();
  assert.equal(shouldCatchUp({ scheduleEnabled: true, missedAt: now - 60000, now }), true);
  assert.equal(shouldCatchUp({ scheduleEnabled: true, missedAt: now + 60000, now }), false);
  assert.equal(shouldCatchUp({ scheduleEnabled: false, missedAt: now - 60000, now }), false);
  assert.equal(
    shouldCatchUp({ scheduleEnabled: true, catchUpMissed: false, missedAt: now - 60000, now }),
    false
  );
  assert.equal(shouldCatchUp({ scheduleEnabled: true, missedAt: null, now }), false);
});

test('format: rótulos compartilhados (status, fonte do check-in, número)', () => {
  assert.equal(statusLabel('success'), 'sucesso');
  assert.equal(statusLabel('partial'), 'parcial');
  assert.equal(statusLabel('blocked'), 'bloqueado');
  assert.equal(statusLabel('desconhecido-status'), 'desconhecido-status');
  assert.equal(statusLabel(null), 'desconhecido');

  assert.equal(coinsSourceLabel('desktop-bonus'), 'extrato');
  assert.equal(coinsSourceLabel('mobile-modal'), 'modal mobile');
  assert.equal(coinsSourceLabel('streak-estimate'), 'estimativa pela sequência');
  assert.equal(coinsSourceLabel(null), '');

  assert.equal(fmtNumber(42), '42');
  assert.equal(fmtNumber(0), '0');
  assert.equal(fmtNumber(null), '—');
  assert.equal(fmtNumber(NaN), '—');
});

// ---------------------------------------------------------------------------
// Fila de tarefas
// ---------------------------------------------------------------------------

const task = (over = {}) => ({
  index: 0,
  title: 'Tarefa',
  desc: '',
  btnText: 'GO',
  isActionable: true,
  isClaimable: false,
  isDone: false,
  kind: 'scroll',
  scrollSeconds: 10,
  ...over
});

test('pickNextTask prioriza resgates antes de tarefas executáveis', () => {
  const tasks = [
    task({ index: 0, title: 'Navegar', isActionable: true }),
    task({ index: 1, title: 'Resgatar', isActionable: false, isClaimable: true })
  ];
  const picked = pickNextTask(tasks, {}, {});
  assert.equal(picked.action, 'claim');
  assert.equal(picked.title, 'Resgatar');
});

test('pickNextTask respeita o limite de tentativas por tarefa', () => {
  const t = task({ title: 'Navegar' });
  const key = taskKey(t);
  const picked = pickNextTask([t], { [key]: 3 }, { maxAttemptsPerTask: 3 });
  assert.equal(picked, null);
});

test('pickNextTask pula tarefas exclusivas do app quando configurado', () => {
  const tasks = [
    task({ title: 'Merge Boss', kind: 'app-only', isActionable: true }),
    task({ index: 1, title: 'Navegar', kind: 'scroll' })
  ];
  const picked = pickNextTask(tasks, {}, { skipAppOnlyTasks: true });
  assert.equal(picked.action, 'skip_app_only');
  assert.equal(picked.title, 'Merge Boss');
});

test('pickNextTask executa "Explore itens surpresa" por padrão; pula quando configurado', () => {
  const t = task({ title: 'Explore itens surpresa', kind: 'surprise' });

  const picked = pickNextTask([t], {}, {});
  assert.equal(picked.action, 'run', 'por padrão a tarefa é executada');
  assert.equal(picked.kind, 'surprise');

  const skipped = pickNextTask([t], {}, { skipSurpriseTask: true });
  assert.equal(skipped.action, 'skip_surprise');
  assert.equal(skipped.title, 'Explore itens surpresa');
});

test('pickNextTask não repete resgates já clicados', () => {
  const t = task({ title: 'Resgatar', isActionable: false, isClaimable: true });
  const picked = pickNextTask([t], {}, { claimed: new Set([claimKey(t)]) });
  assert.equal(picked, null);
});

test('progresso observado (rodada nova) reseta tentativas e reabre a tarefa', () => {
  const t1 = task({ title: 'Super descontos', statusText: '1/3', completedRounds: 1, totalRounds: 3 });
  const state = {
    attempts: { [taskKey(t1)]: 3 },
    roundAttempts: { [roundKeyOf(t1)]: 3 },
    progressMap: { 'Super descontos': 1 },
    statusMap: { 'Super descontos': '1/3' },
    failed: { 'Super descontos': 'Sem progresso após 3 tentativas na rodada' }
  };
  const t2 = task({ title: 'Super descontos', statusText: '2/3', completedRounds: 2, totalRounds: 3 });
  const advanced = applyTaskProgress([t2], state);
  assert.deepEqual(advanced, ['Super descontos'], 'avanço de rodada é detectado');
  assert.equal(state.attempts[taskKey(t2)], 0, 'tentativas por título zeradas');
  assert.equal(state.roundAttempts[roundKeyOf(t2)] || 0, 0, 'tentativas por rodada zeradas');
  assert.equal(state.failed['Super descontos'], undefined, 'falha residual limpa (reaberta)');

  // Com o estado limpo, a tarefa volta a ser elegível no mesmo run.
  const picked = pickNextTask([t2], state.attempts, {
    roundAttempts: state.roundAttempts,
    failed: state.failed
  });
  assert.equal(picked.action, 'run');
  assert.equal(picked.title, 'Super descontos');
});

test('pickNextTask registra falha quando a rodada esgota sem progresso', () => {
  const t = task({ title: 'Veja super descontos', statusText: '0/3' });
  const roundAttempts = { [roundKeyOf(t)]: 3 };
  const failed = {};
  const picked = pickNextTask([t], {}, { roundAttempts, maxRoundAttempts: 3, failed });
  assert.equal(picked, null);
  assert.match(failed['Veja super descontos'], /rodada/);
});

test('pickNextTask permite novo resgate quando o estado da tarefa muda', () => {
  const t1 = task({
    title: 'Resgatar',
    isActionable: false,
    isClaimable: true,
    statusText: '0/2',
    btnText: 'COLLECT'
  });
  const claimed = new Set([claimKey(t1)]);
  assert.equal(pickNextTask([t1], {}, { claimed }), null, 'mesmo resgate não repete');

  const t2 = task({
    title: 'Resgatar',
    isActionable: false,
    isClaimable: true,
    statusText: '1/2',
    btnText: 'COLLECT'
  });
  const picked = pickNextTask([t2], {}, { claimed });
  assert.equal(picked.action, 'claim', 'novo estado (outra rodada) permite resgatar de novo');
});

test('selectLateProgressCandidates lista rodadas esgotadas sem falha e ignora puladas', () => {
  const travada = task({ title: 'Rodada travada', statusText: '1/3' });
  const pulada = task({ index: 1, title: 'Merge Boss', kind: 'app-only', statusText: '0/2' });
  const feita = task({ index: 2, title: 'Concluída', statusText: '3/3', isDone: true });
  const roundAttempts = { [roundKeyOf(travada)]: 3, [roundKeyOf(pulada)]: 3 };
  const out = selectLateProgressCandidates([travada, pulada, feita], {
    roundAttempts,
    maxRoundAttempts: 3
  });
  assert.deepEqual(
    out.map((c) => c.title),
    ['Rodada travada'],
    'somente a rodada esgotada elegível (sem falha registrada)'
  );

  const failed = { 'Rodada travada': 'falhou' };
  const out2 = selectLateProgressCandidates([travada], { roundAttempts, failed });
  assert.deepEqual(out2, [], 'tarefa já marcada como falha não entra de novo');
});

test('summarizeTasks conta estados corretamente', () => {
  const s = summarizeTasks([
    task({ isDone: true }),
    task({ isActionable: true }),
    task({ isActionable: false, isClaimable: true })
  ]);
  assert.deepEqual(s, { total: 3, done: 1, actionable: 1, claimable: 1 });
});

test('buildReport calcula ganho de saldo e duração', () => {
  const report = buildReport({
    runId: 'r1',
    startedAt: 1000,
    endedAt: 51000,
    status: 'success',
    balanceBefore: 100,
    balanceAfter: 130,
    log: [{ t: 2000, msg: 'início' }]
  });
  assert.equal(report.gained, 30);
  assert.equal(report.durationMs, 50000);
  assert.equal(report.log.length, 1);
  assert.equal(report.log[0].msg, 'início');
});

test('migrateSettings desliga keepWindowOpen legado e carimba a versão', () => {
  // Config antiga (padrões antigos: janela aberta, execução visível) → migra.
  // v6: campos de credenciais/cooldown legados são removidos para sempre.
  const legacy = migrateSettings({
    keepWindowOpen: true,
    user: 'a@b.com',
    passwordEnc: { v: 1, iv: 'x', ct: 'y' },
    passwordPlain: 'texto-puro',
    cryptoOk: true,
    captchaTimeoutMin: 5,
    riskCooldownHours: 48
  });
  assert.equal(legacy.changed, true);
  assert.equal(legacy.settings.keepWindowOpen, false);
  assert.equal(legacy.settings.silentMode, true, 'v3: segundo plano por padrão');
  assert.equal(legacy.settings.maxTaskActions, 60, 'v4: teto antigo de 25 sobe para 60');
  assert.equal(legacy.settings.settingsVersion, SETTINGS_VERSION);
  assert.equal(legacy.settings.user, undefined, 'v6: login por credenciais removido');
  assert.equal(legacy.settings.passwordEnc, undefined);
  assert.equal(legacy.settings.passwordPlain, undefined);
  assert.equal(legacy.settings.cryptoOk, undefined);
  assert.equal(legacy.settings.captchaTimeoutMin, undefined, 'v6: sem tempo máx. de captcha');
  assert.equal(legacy.settings.riskCooldownHours, undefined, 'v6: sem cooldown anti-bot');
  assert.equal(legacy.settings.skipSurpriseTask, false, 'v7: surpresa executada por padrão');

  // Config já na versão atual: preferências do usuário são preservadas.
  const current = migrateSettings({ keepWindowOpen: true, settingsVersion: SETTINGS_VERSION });
  assert.equal(current.changed, false);
  assert.equal(current.settings.keepWindowOpen, true);

  const optedOut = migrateSettings({ silentMode: false, settingsVersion: SETTINGS_VERSION });
  assert.equal(optedOut.changed, false);
  assert.equal(optedOut.settings.silentMode, false, 'opt-out explícito não é revertido');

  const customActions = migrateSettings({ maxTaskActions: 30, settingsVersion: SETTINGS_VERSION });
  assert.equal(customActions.changed, false);
  assert.equal(customActions.settings.maxTaskActions, 30, 'valor explícito != 25 é preservado');

  // Sem config salva: defaults migrados, sem quebra.
  const fresh = migrateSettings(undefined);
  assert.equal(fresh.changed, true);
  assert.equal(fresh.settings.keepWindowOpen, false);
  assert.equal(fresh.settings.silentMode, true);
  assert.equal(fresh.settings.maxTaskActions, 60);
  assert.equal(fresh.settings.skipSurpriseTask, false, 'v7: surpresa executada por padrão');
});

test('shouldScheduleRetry: 1 retentativa apenas para erros, sem loop', () => {
  assert.equal(shouldScheduleRetry({ status: 'error', reason: 'manual' }), true);
  assert.equal(shouldScheduleRetry({ status: 'error', reason: 'schedule' }), true);
  assert.equal(shouldScheduleRetry({ status: 'error', reason: 'catchup' }), true);
  assert.equal(shouldScheduleRetry({ status: 'error', reason: 'retry' }), false);
  assert.equal(shouldScheduleRetry({ status: 'error', retryOnFailure: false }), false);
  assert.equal(shouldScheduleRetry({ status: 'blocked', reason: 'schedule' }), false);
  assert.equal(shouldScheduleRetry({ status: 'stopped', reason: 'manual' }), false);
  assert.equal(shouldScheduleRetry({ status: 'success', reason: 'manual' }), false);
});

test('contexto: sem content script o erro é marcado para recuperação (noContentScript)', async () => {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = {
    tabs: {
      sendMessage: async () => {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      }
    }
  };
  try {
    assert.equal(isNoContentScriptError(new Error('x')), false);
    assert.equal(isNoContentScriptError({ noContentScript: true }), true);
    await assert.rejects(
      sendCmd({ runId: 'r1' }, 1, 'PING', {}, { retries: 1 }),
      (err) => err.noContentScript === true && /PING/.test(err.message)
    );
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});

// ---------------------------------------------------------------------------
// Classificação de tarefas (arquivo UMD usado pelo content script)
// ---------------------------------------------------------------------------

test('classifyTask identifica surpresa, busca, prize-land e app-only', () => {
  const { classifyTask } = loadTaskClassify();
  assert.equal(classifyTask('Surprise products', 'Tap 3 items'), 'surprise');
  assert.equal(classifyTask('Toque em 3 itens', ''), 'surprise');
  assert.equal(classifyTask('Search products', 'Use keywords'), 'search');
  assert.equal(classifyTask('Pesquisar produtos', ''), 'search');
  assert.equal(classifyTask('Pesquise produtos', ''), 'search');
  assert.equal(classifyTask('Busque ofertas', ''), 'search');
  assert.equal(classifyTask('Prize Land', 'Water your tree'), 'prize-land');
  assert.equal(classifyTask('Merge Boss game', ''), 'app-only');
  assert.equal(classifyTask('Avaliar pedido', 'Review'), 'app-only');
  assert.equal(classifyTask('Assistir ofertas', 'Navegue por 15s'), 'scroll');

  // Exemplos reais reportados (contas novas): tarefas exclusivas do app e a de
  // US$0,10 com VÍRGULA decimal precisam ser barradas.
  assert.equal(classifyTask('Desafio diário do quiz', ''), 'app-only');
  assert.equal(classifyTask('Conclua 1 pedido do jogo Merge Boss', ''), 'app-only');
  assert.equal(classifyTask('Ganhe Itens de US$0,10', ''), 'prize-land');
  assert.equal(classifyTask('', 'Complete o desafio no app'), 'app-only');
});

test('scrollSecondsForTask garante 16s em super descontos', () => {
  const { scrollSecondsForTask } = loadTaskClassify();
  assert.equal(scrollSecondsForTask('SuperDeal', '', 10), 16);
  assert.equal(scrollSecondsForTask('Navegar', '15s de permanência', 10), 16);
  assert.equal(scrollSecondsForTask('Navegar', '', 10), 10);
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

test('manifest.json é MV3, tem content script, alarmes e DNR', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.background.service_worker.endsWith('service-worker.js'));
  assert.equal(manifest.background.type, 'module');
  assert.ok(manifest.permissions.includes('alarms'));
  assert.ok(manifest.permissions.includes('storage'));
  assert.ok(manifest.permissions.includes('declarativeNetRequest'));
  assert.ok(manifest.host_permissions.some((h) => h.includes('aliexpress.com')));
  assert.ok(manifest.content_scripts[0].js.includes('src/content/bridge.js'));
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
  assert.ok(manifest.icons['128']);
});

test('manifest declara o spoof de navigator no MAIN world em document_start', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const mainWorld = manifest.content_scripts.find((cs) => cs.world === 'MAIN');
  assert.ok(mainWorld, 'entrada MAIN world ausente no manifest');
  assert.ok(mainWorld.js.includes('src/content/main-world.js'));
  assert.equal(mainWorld.run_at, 'document_start');
});

test('arquivos referenciados no manifest existem', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const files = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_page,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap((cs) => cs.js)
  ];
  for (const f of files) {
    assert.doesNotThrow(() => readFileSync(path.join(root, f)), `arquivo ausente: ${f}`);
  }
});

// ---------------------------------------------------------------------------
// Smoke test dos content scripts (ordem de carga e namespace AC)
// ---------------------------------------------------------------------------

test('content scripts carregam em ordem sem erros e expõem AC.actions', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const scripts = manifest.content_scripts[0].js.filter((f) => !f.endsWith('bridge.js'));

  const sandbox = { self: {} };
  vm.createContext(sandbox);
  for (const f of scripts) {
    const code = readFileSync(path.join(root, f), 'utf8');
    assert.doesNotThrow(() => vm.runInContext(code, sandbox, { filename: f }), `falha ao carregar ${f}`);
  }

  const AC = sandbox.self.AC;
  assert.ok(AC.selectors.login.usernameInput);
  assert.ok(AC.selectors.tasks.taskItem);
  assert.equal(typeof AC.classifyTask, 'function');
  assert.equal(typeof AC.dom.clickHuman, 'function');
  assert.equal(typeof AC.ledger.extractTodayLedger, 'function');
  assert.equal(typeof AC.actions.waitCaptcha, 'function');
  assert.equal(typeof AC.actions.checkAuth, 'function');
  assert.equal(typeof AC.actions.doCheckin, 'function');
  assert.equal(typeof AC.actions.extractTasks, 'function');
  assert.equal(typeof AC.actions.runAction, 'function');
});

test('main-world spoofa navigator apenas na aba de execução', () => {
  const code = readFileSync(path.join(root, 'src/content/main-world.js'), 'utf8');
  const sandbox = { console };
  sandbox.self = sandbox;
  sandbox.location = { hash: '' };
  sandbox.sessionStorage = {
    _v: null,
    getItem() {
      return this._v;
    },
    setItem(key, value) {
      if (key === 'ac_run') this._v = value;
    }
  };
  vm.createContext(sandbox);

  // Simula o Navigator.prototype do navegador (getter original de userAgent).
  vm.runInContext(
    "Object.defineProperty(Object.prototype, 'userAgent', { get: function () { return 'desktop-UA'; }, configurable: true }); var navigator = {};",
    sandbox
  );

  vm.runInContext(code, sandbox, { filename: 'main-world.js' });

  // Sem a marca, permanece desktop (abas normais do usuário não são afetadas).
  assert.equal(sandbox.navigator.userAgent, 'desktop-UA');

  // Com a marca, o spoof mobile entra em ação.
  sandbox.sessionStorage.setItem('ac_run', '1');
  assert.match(sandbox.navigator.userAgent, /Pixel 8/);
  assert.equal(sandbox.navigator.maxTouchPoints, 5);
  assert.equal(sandbox.navigator.userAgentData.mobile, true);
  assert.equal(sandbox.navigator.userAgentData.platform, 'Android');

  // Com User-Agent customizado (ex.: Pixel 7 configurado nas Opções), o spoof
  // acompanha o header HTTP em userAgent, appVersion e userAgentData.
  sandbox.sessionStorage._ua =
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
  sandbox.sessionStorage.getItem = function (key) {
    if (key === 'ac_run') return this._v;
    if (key === 'ac_ua') return this._ua;
    return null;
  };
  assert.match(sandbox.navigator.userAgent, /Pixel 7/);
  assert.match(sandbox.navigator.appVersion, /^5\.0 \(Linux; Android 13; Pixel 7\)/);
  return sandbox.navigator.userAgentData.getHighEntropyValues().then((he) => {
    assert.equal(he.model, 'Pixel 7');
    assert.equal(he.platformVersion, '13.0.0');
  });
});

test('main-world registra window.open ({url, blocked}) no sessionStorage da aba de execução', () => {
  const code = readFileSync(path.join(root, 'src/content/main-world.js'), 'utf8');
  const store = new Map();
  const sandbox = {
    console,
    open(url) {
      return url && url.includes('blocked') ? null : { window: true };
    },
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v)
    }
  };
  sandbox.self = sandbox;
  sandbox.location = { hash: '' };
  vm.createContext(sandbox);
  vm.runInContext('var navigator = {};', sandbox);
  vm.runInContext(code, sandbox, { filename: 'main-world.js' });

  // Fora da aba de execução: NADA é registrado (usuário não é afetado).
  sandbox.self.open('https://example.com/x');
  assert.equal(store.has('ac_win_opens'), false);

  // Na aba de execução: registra {url, blocked} de cada open.
  sandbox.sessionStorage.setItem('ac_run', '1');
  sandbox.self.open('https://m.aliexpress.com/p/coin-index/feeds.html?from=mission&idem_id=1');
  sandbox.self.open('https://blocked.example/');
  const list = JSON.parse(store.get('ac_win_opens'));
  assert.equal(list.length, 2);
  assert.equal(list[0].blocked, false);
  assert.match(list[0].url, /from=mission/);
  assert.match(list[1].url, /blocked\.example/);
  assert.equal(list[1].blocked, true, 'open bloqueado (retorno nulo) é marcado');
});

test('storage: saveSettings descarta campos legados (credenciais/cooldown) e mantém o resto', async () => {
  const originalChrome = globalThis.chrome;
  let localData = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => ({ [key]: localData[key] }),
        set: async (obj) => {
          localData = { ...localData, ...obj };
        }
      }
    }
  };
  try {
    const next = await saveSettingsStorage({
      user: 'a@b.com',
      password: 'segredo',
      passwordEnc: { v: 1, iv: 'x', ct: 'y' },
      passwordPlain: 'segredo',
      cryptoOk: true,
      captchaTimeoutMin: 5,
      riskCooldownHours: 48,
      scrollSeconds: 12
    });
    assert.equal(next.user, undefined, 'credencial legada não pode voltar');
    assert.equal(next.password, undefined);
    assert.equal(next.passwordEnc, undefined);
    assert.equal(next.passwordPlain, undefined);
    assert.equal(next.cryptoOk, undefined);
    assert.equal(next.captchaTimeoutMin, undefined);
    assert.equal(next.riskCooldownHours, undefined);
    assert.equal(next.scrollSeconds, 12, 'preferências válidas são preservadas');
    // O que foi gravado no storage também está limpo (inclusive de backups antigos).
    assert.equal(localData.settings.user, undefined);
    assert.equal(localData.settings.passwordEnc, undefined);
    assert.equal(localData.settings.riskCooldownHours, undefined);
    assert.equal(localData.settings.settingsVersion, SETTINGS_VERSION);
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});

test('describeReport (sucesso): valores ATUALIZADOS PELO EXTRATO (bônus, missões e recuperado)', () => {
  // Com extrato: Bônus diário, Missões de moedas e Recuperado vêm da página
  // mycoin — mesmo com check-in já coletado antes do run.
  const report = buildReport({
    runId: 'r',
    reason: 'manual',
    startedAt: 0,
    endedAt: 60000,
    status: 'success',
    checkin: { already: true, coinsGainedToday: 1 },
    balanceBefore: 100,
    balanceAfter: 112,
    tasks: [
      { title: 'A', kind: 'scroll', result: 'attempt' },
      { title: 'B', kind: 'scroll', result: 'attempt' }
    ],
    skipped: [],
    errors: [],
    captchaEvents: 0,
    log: []
  });
  report.tasksGained = 11;
  report.ledger = { bonusCoins: 40, missionsCoins: 46, refundCoins: 12 };
  const msg = describeReport(report);
  assert.match(msg, /Check-in: \+40 moedas/, 'bônus diário do extrato tem prioridade');
  assert.match(msg, /Tarefas: \+46 moedas/, 'missões de moedas do extrato têm prioridade');
  assert.match(msg, /Recuperado: \+12 moedas/, 'recuperado por cancelamento aparece quando existe');
  assert.doesNotMatch(msg, /ação\(ões\)/, 'não mostra a contagem de tarefas');

  // Sem extrato (leitura indisponível): cai nos valores do run e NÃO mostra
  // a linha de recuperado.
  const fresh = buildReport({
    runId: 'r2',
    reason: 'manual',
    startedAt: 0,
    endedAt: 30000,
    status: 'success',
    checkin: { justCollected: true, coins: 40 },
    balanceBefore: 10,
    balanceAfter: 55,
    tasks: [{ title: 'A', kind: 'scroll', result: 'attempt' }],
    skipped: [],
    errors: [],
    captchaEvents: 0,
    log: []
  });
  fresh.tasksGained = 5;
  const msg2 = describeReport(fresh);
  assert.match(msg2, /Check-in: \+40 moedas/);
  assert.match(msg2, /Tarefas: \+5 moedas/);
  assert.doesNotMatch(msg2, /Recuperado/);
  assert.doesNotMatch(msg2, /ação\(ões\)/);
});

test('context: appendLog resume por padrão e só mostra diagnósticos com "Log detalhado"', async () => {
  const originalChrome = globalThis.chrome;
  let sessionData = {};
  globalThis.chrome = {
    storage: {
      session: {
        get: async (key) => ({ [key]: sessionData[key] }),
        set: async (obj) => {
          sessionData = { ...sessionData, ...obj };
        },
        remove: async (key) => {
          delete sessionData[key];
        }
      }
    }
  };
  try {
    // Padrão (resumido): linhas de diagnóstico não entram no extrato.
    const resumido = { runId: 'r1', settings: {}, log: [] };
    await appendLog(resumido, 'linha importante');
    await appendLog(resumido, 'linha de diagnóstico', { detail: true });
    assert.equal(resumido.log.length, 1, 'detalhes são omitidos por padrão');
    assert.equal(resumido.log[0].msg, 'linha importante');

    // Com o Log detalhado ativo: tudo entra.
    const detalhado = { runId: 'r2', settings: { verboseLog: true }, log: [] };
    await appendLog(detalhado, 'linha de diagnóstico', { detail: true });
    assert.equal(detalhado.log.length, 1, 'com Log detalhado, os diagnósticos aparecem');
    assert.equal(detalhado.log[0].msg, 'linha de diagnóstico');
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});

test('storage: memória diária da surpresa (por dia contábil LA, sem vazar entre dias)', async () => {
  const originalChrome = globalThis.chrome;
  let localData = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => ({ [key]: localData[key] }),
        set: async (obj) => {
          localData = { ...localData, ...obj };
        }
      }
    }
  };
  try {
    // Dia contábil = America/Los_Angeles (UTC-8 no inverno).
    assert.equal(accountingDateKey(new Date('2026-01-05T10:00:00Z')), '2026-01-05');
    assert.equal(
      accountingDateKey(new Date('2026-01-06T07:00:00Z')),
      '2026-01-05',
      '23:00 em Los Angeles ainda é o dia 5'
    );

    await saveSurpriseTapped(['sig-a', 'sig-b'], '2026-01-05');
    const sameDay = await getSurpriseTapped('2026-01-05');
    assert.deepEqual([...sameDay].sort(), ['sig-a', 'sig-b']);
    assert.equal(
      (await getSurpriseTapped('2026-01-06')).size,
      0,
      'a memória de outro dia não vaza'
    );
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});

test('tabs: prepareRunTab no modo silencioso cria JANELA DEDICADA sem foco (não usa a do usuário)', async () => {
  const originalChrome = globalThis.chrome;
  const created = [];
  const sessionData = {};
  globalThis.chrome = {
    storage: {
      session: {
        get: async (key) => ({ [key]: sessionData[key] }),
        set: async (obj) => {
          Object.assign(sessionData, obj);
        },
        remove: async (key) => {
          delete sessionData[key];
        }
      },
      local: { get: async () => ({}), set: async () => {} }
    },
    windows: {
      getLastFocused: async () => ({ id: 1, type: 'normal' }),
      create: async (opts) => {
        created.push(opts);
        return { id: 77, tabs: [{ id: 700 }] };
      },
      update: async () => ({}),
      get: async () => ({ id: 77, type: 'normal' })
    },
    tabs: {
      // Aba do USUÁRIO (capturada antes de criar a janela dedicada).
      query: async () => [{ id: 42, active: true }],
      get: async (id) => ({ id, status: 'complete', url: 'about:blank', windowId: 77 }),
      update: async () => ({}),
      create: async () => ({ id: 700 })
    },
    declarativeNetRequest: { updateSessionRules: async () => {} }
  };
  try {
    const win = await prepareRunTab({ silentMode: true }, {});
    assert.equal(created.length, 1, 'cria UMA janela de execução');
    assert.equal(created[0].type, 'normal', 'janela dedicada (normal), não a do usuário');
    assert.equal(created[0].focused, false, 'nasce SEM foco (não interfere no usuário)');
    assert.equal(win.dedicated, true);
    assert.equal(win.userTabId, 42, 'captura a aba do usuário antes de criar a janela');
    assert.equal(sessionData.runTabRef.dedicated, true, 'ref da janela marcada como dedicada');
    assert.equal(sessionData.runTabRef.userTabId, 42);
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});

test('storage: patchRunState serializa escritas concorrentes sem perder campos', async () => {
  const originalChrome = globalThis.chrome;
  let sessionData = {};
  globalThis.chrome = {
    storage: {
      session: {
        get: async (key) => {
          await new Promise((r) => setTimeout(r, 5));
          return { [key]: sessionData[key] };
        },
        set: async (obj) => {
          await new Promise((r) => setTimeout(r, 5));
          sessionData = { ...sessionData, ...obj };
        },
        remove: async (key) => {
          delete sessionData[key];
        }
      }
    }
  };
  try {
    await patchRunState(null);
    await Promise.all([
      patchRunState({ active: true, phase: 'tasks' }),
      patchRunState({ tabId: 42 }),
      patchRunState({ windowId: 7, message: 'Rodando' })
    ]);
    const finalState = await getRunState();
    assert.equal(finalState.active, true);
    assert.equal(finalState.phase, 'tasks');
    assert.equal(finalState.tabId, 42);
    assert.equal(finalState.windowId, 7);
    assert.equal(finalState.message, 'Rodando');
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});

test('tabs: ensureCoinPage volta à central a partir de subpáginas coin-index (recommends.html)', async () => {
  const originalChrome = globalThis.chrome;
  const updates = [];
  const RECOMMENDS_URL =
    'https://m.aliexpress.com/p/coin-index/recommends.html?_immersiveMode=true&from=mission&idem_id=1792060116079';
  globalThis.chrome = {
    tabs: {
      get: async () => ({ id: 9, status: 'complete', url: RECOMMENDS_URL }),
      update: async (tabId, props) => {
        updates.push({ tabId, props });
        return {};
      }
    },
    declarativeNetRequest: {
      updateSessionRules: async () => {}
    }
  };
  try {
    // Só a central (`/p/coin-index/index.html`) é reconhecida: o feed de itens
    // patrocinados (recommends.html) NÃO pode passar por "já na central" — era
    // a causa do "Painel Ganhe mais moedas inacessível" (cards: 0) que abortava
    // as tarefas restantes do run.
    assert.equal(
      isCoinUrl('https://m.aliexpress.com/p/coin-index/index.html?_immersiveMode=true&from=pc302#ac_run=1'),
      true
    );
    assert.equal(isCoinUrl('https://m.aliexpress.com/p/coin-index/index.html'), true);
    assert.equal(isCoinUrl('https://m.aliexpress.com/p/coin-index/'), true);
    assert.equal(isCoinUrl(RECOMMENDS_URL), false);
    assert.equal(isCoinUrl('https://www.aliexpress.com/p/coin-pc-index/mycoin.html'), false);
    assert.equal(isCoinUrl('https://m.aliexpress.com/item/100500.html'), false);

    await ensureCoinPage({ tabId: 9, settings: {} }, false);
    assert.equal(updates.length, 1, 'deve navegar de volta à central');
    assert.equal(updates[0].tabId, 9);
    assert.match(updates[0].props.url, /\/p\/coin-index\/index\.html\?/);
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});

test('tabs: registerAuxTab acumula as abas auxiliares nas regras mobile; unregister/clear limpam', async () => {
  const originalChrome = globalThis.chrome;
  const calls = [];
  globalThis.chrome = {
    tabs: {
      get: async (id) => ({ id })
    },
    declarativeNetRequest: {
      updateSessionRules: async (arg) => {
        calls.push(arg);
      }
    }
  };
  try {
    await clearDeviceRules();
    calls.length = 0;

    await registerAuxTab(11, {});
    await registerAuxTab(22, {});
    const add1 = calls.filter((c) => c.addRules).pop();
    assert.deepEqual(
      add1.addRules[0].condition.tabIds,
      [11, 22],
      'acumula as abas auxiliares (contexto mobile desde o primeiro byte)'
    );
    assert.equal(add1.addRules[0].action.type, 'modifyHeaders');
    assert.equal(
      add1.addRules[0].action.requestHeaders.some((h) => h.header === 'user-agent'),
      true,
      'reescreve o user-agent'
    );

    await unregisterAuxTab(11);
    const add2 = calls.filter((c) => c.addRules).pop();
    assert.deepEqual(add2.addRules[0].condition.tabIds, [22], 'remove a aba fechada');

    await clearDeviceRules();
    const remove = calls.filter((c) => c.removeRuleIds).pop();
    assert.ok(
      remove.removeRuleIds.includes(9003),
      'clearDeviceRules remove a regra das abas auxiliares'
    );
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});

test('auth: sessão expirada encerra com erro acionável e traz a tela de login (sem aguardar)', async () => {
  const originalChrome = globalThis.chrome;
  let sessionData = {};
  const focusCalls = { windows: [], tabs: [] };
  const notifications = [];
  globalThis.chrome = {
    storage: {
      session: {
        get: async (key) => ({ [key]: sessionData[key] }),
        set: async (obj) => {
          sessionData = { ...sessionData, ...obj };
        },
        remove: async (key) => {
          delete sessionData[key];
        }
      }
    },
    tabs: {
      sendMessage: async () => ({ state: 'needs_login' }),
      update: async (tabId, props) => {
        focusCalls.tabs.push({ tabId, props });
        return {};
      }
    },
    windows: {
      get: async () => ({ id: 5, state: 'normal' }),
      update: async (windowId, props) => {
        focusCalls.windows.push({ windowId, props });
        return {};
      }
    },
    runtime: { getURL: (p) => `chrome-extension://fake/${p}` },
    notifications: {
      create: async (id, opts) => {
        notifications.push({ id, opts });
        return id;
      }
    }
  };
  try {
    const ctx = {
      runId: 'run-manual-login',
      tabId: 9,
      windowId: 5,
      settings: { silentMode: true },
      stats: { captchaEvents: 0 },
      log: []
    };
    const res = await ensureAuthenticated(ctx);
    assert.equal(res.ok, false, 'login manual NÃO aguarda: encerra com erro');
    assert.equal(res.manualLogin, true);
    assert.match(res.error, /versão desktop/);
    assert.match(res.error, /execute a extensão novamente/);
    assert.equal(
      ctx.manualLoginRequired,
      true,
      'a política de janela deve converter/preservar a tela de login'
    );
    assert.ok(
      focusCalls.tabs.some((c) => c.tabId === 9 && c.props.active === true),
      'a aba da tela de login deve ser ativada'
    );
    assert.ok(
      focusCalls.windows.some((c) => c.windowId === 5 && c.props.focused === true),
      'a janela deve ser trazida para frente'
    );
    assert.ok(
      notifications.some(
        (n) =>
          n.id === 'ali-coins-manual-login' &&
          n.opts.requireInteraction === true &&
          /versão desktop/.test(n.opts.message)
      ),
      'notificação "login manual necessário" (versão desktop) com requireInteraction'
    );
    assert.ok(
      ctx.log.some((l) => /Login manual necessário/.test(l.msg)),
      'o erro acionável deve constar no extrato do run'
    );
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});

test('finalize: applyWindowPolicy converte e preserva a tela de login da versão desktop', async () => {
  const originalChrome = globalThis.chrome;
  let sessionData = {};
  const removedTabs = [];
  const removedWindows = [];
  const tabUpdates = [];
  const windowUpdates = [];
  const dnrCalls = [];
  const detachCalls = [];
  globalThis.chrome = {
    storage: {
      session: {
        get: async (key) => ({ [key]: sessionData[key] }),
        set: async (obj) => {
          sessionData = { ...sessionData, ...obj };
        },
        remove: async (key) => {
          delete sessionData[key];
        }
      }
    },
    tabs: {
      get: async () => ({ id: 9, windowId: 5, status: 'complete' }),
      update: async (tabId, props) => {
        tabUpdates.push({ tabId, props });
        return {};
      },
      remove: async (tabId) => {
        removedTabs.push(tabId);
      }
    },
    windows: {
      get: async () => ({ id: 5, type: 'normal', state: 'normal' }),
      update: async (windowId, props) => {
        windowUpdates.push({ windowId, props });
        return {};
      },
      remove: async (windowId) => {
        removedWindows.push(windowId);
      }
    },
    declarativeNetRequest: {
      updateSessionRules: async (arg) => {
        dnrCalls.push(arg);
      }
    },
    debugger: {
      detach: async (target) => {
        detachCalls.push(target);
      }
    }
  };
  try {
    // Modo silencioso + keepWindowOpen desligado: o padrão FECHARIA a aba — com
    // login manual exigido, a aba vira a tela de login DESKTOP e sobrevive.
    const ctx = { tabId: 9, windowId: 5, manualLoginRequired: true, log: [] };
    await applyWindowPolicy(ctx, { silentMode: true, keepWindowOpen: false });

    assert.equal(removedTabs.length, 0, 'a aba da tela de login NÃO pode ser fechada');
    assert.equal(removedWindows.length, 0, 'a janela do usuário NÃO pode ser fechada');
    assert.ok(
      dnrCalls.some((c) => Array.isArray(c.removeRuleIds) && c.removeRuleIds.includes(9001)),
      'as regras mobile (UA/Client Hints) devem sair para o login desktop'
    );
    assert.ok(
      detachCalls.some((c) => c.tabId === 9),
      'o CDP deve ser desanexado (sem viewport/UA emulados no login desktop)'
    );
    assert.ok(
      tabUpdates.some((c) => c.tabId === 9 && c.props.url === 'https://login.aliexpress.com/'),
      'a aba deve navegar para a tela de login da versão desktop'
    );
    assert.ok(
      windowUpdates.some((c) => c.windowId === 5 && c.props.focused === true),
      'a janela deve ser trazida para frente'
    );
    assert.ok(
      ctx.log.some((l) => /versão desktop/.test(l.msg)),
      'o relatório deve explicar a tela de login desktop'
    );
    assert.ok(
      ctx.log.some((l) => /Tela de login mantida aberta/.test(l.msg)),
      'o relatório deve indicar que a tela ficou aberta'
    );
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});

// ---------------------------------------------------------------------------
// Contabilidade — parser do extrato (ledger UMD) e funções puras (accounting)
// Fixtures idênticos aos do projeto original (ali-coins tests/balance.test.js).
// ---------------------------------------------------------------------------

/** Avalia o arquivo UMD ledger.js como CommonJS para obter as funções. */
function loadLedger() {
  const code = readFileSync(path.join(root, 'src/content/ledger.js'), 'utf8');
  const moduleObj = { exports: {} };
   
  const fn = new Function('module', 'exports', 'self', `${code}\nreturn module.exports;`);
  return fn(moduleObj, moduleObj.exports, undefined);
}

test('ledger: extractTodayLedger soma Bônus diário e Missões de moedas (pt/en)', () => {
  const { extractTodayLedger } = loadLedger();

  const pt = `
    20/09/2026 PT
    Bônus diário
    +1
    Missões de moedas
    +5
    Missões de moedas
    +5
    Bônus diário
    +40
  `;
  const ptRes = extractTodayLedger(pt);
  assert.equal(ptRes.bonusCoins, 41);
  assert.equal(ptRes.bonusCount, 2);
  assert.equal(ptRes.missionsCoins, 10);
  assert.equal(ptRes.missionsCount, 2);

  const en = `
    9/20/2026 PT
    Daily bonus
    +1
    Coin missions
    +15
    Coin page task
    +5
  `;
  const enRes = extractTodayLedger(en);
  assert.equal(enRes.bonusCoins, 1);
  assert.equal(enRes.missionsCoins, 20);

  assert.deepEqual(extractTodayLedger(''), {
    bonusCoins: null,
    missionsCoins: 0,
    bonusCount: 0,
    missionsCount: 0,
    refundCoins: 0,
    refundCount: 0
  });
});

test('ledger: "Recuperado pelo cancelamento do pedido" é classificado à parte (não é missão)', () => {
  const { extractTodayLedger, readMycoinPage } = loadLedger();

  const pt = `
    20/09/2026 PT
    Bônus diário
    +40
    Missões de moedas
    +5
    Recuperado pelo cancelamento do pedido
    +12
    Missões de moedas
    +3
  `;
  const res = extractTodayLedger(pt);
  assert.equal(res.bonusCoins, 40);
  assert.equal(res.missionsCoins, 8, 'recuperações ficam FORA das missões de moedas');
  assert.equal(res.missionsCount, 2);
  assert.equal(res.refundCoins, 12);
  assert.equal(res.refundCount, 1);

  const en = `
    9/20/2026 PT
    Daily bonus
    +1
    Coin missions
    +5
    Recovered from order cancellation
    +7
  `;
  const enRes = extractTodayLedger(en);
  assert.equal(enRes.bonusCoins, 1);
  assert.equal(enRes.missionsCoins, 5);
  assert.equal(enRes.refundCoins, 7);
  assert.equal(enRes.refundCount, 1);

  // readMycoinPage expõe os TRÊS valores (bônus, missões e recuperado).
  const today =
    new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Los_Angeles' }) + ' PT';
  const text = `Minhas moedas\n1000\n${today}\nBônus diário\n+40\nMissões de moedas\n+5\nRecuperado pelo cancelamento do pedido\n+9\n`;
  const read = readMycoinPage(text);
  assert.equal(read.todayBonusCoins, 40);
  assert.equal(read.todayMissionsCoins, 5);
  assert.equal(read.todayRefundCoins, 9);
  assert.equal(read.todayRefundCount, 1);
});

test('ledger: extrato real em inglês e Widget coins contam como tarefa', () => {
  const { extractTodayLedger } = loadLedger();

  const realEn =
    'Coin page task\n+5\nCoin page task\n+5\nCoin page task\n+5\nCoin page task\n+5\nCoin page task\n+1\nApp daily check-in\n+40\n';
  const res = extractTodayLedger(realEn);
  assert.equal(res.bonusCoins, 40);
  assert.equal(res.missionsCoins, 21);
  assert.equal(res.missionsCount, 5);

  let widget = '';
  for (let i = 0; i < 13; i += 1) widget += 'Coin page task\n+5\n';
  widget += 'Coin page task\n+1\n';
  widget += 'Widget coins\n+5\n';
  widget += 'App daily check-in\n+40\n';
  const r = extractTodayLedger(widget);
  assert.equal(r.bonusCoins, 40);
  assert.equal(r.missionsCoins, 71);
  assert.equal(r.missionsCount, 15);
});

test('ledger: streakFromHistory conta dias consecutivos (pt-BR e en-US)', () => {
  const { streakFromHistory } = loadLedger();

  const ptDateParts = (daysAgo) => {
    const [y, m, d] = new Date()
      .toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
      .split('-')
      .map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d - daysAgo));
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  };
  const ptBr = (daysAgo) => {
    const { y, m, d } = ptDateParts(daysAgo);
    return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
  };
  const enUs = (daysAgo) => {
    const { y, m, d } = ptDateParts(daysAgo);
    return `${m}/${d}/${y}`;
  };

  const historyPtBr = `
    Minhas moedas: 521
    ${ptBr(0)} PT
    Check-in diário no app
    +40
    ${ptBr(1)} PT
    Check-in diário no app
    +40
    ${ptBr(2)} PT
    Check-in diário no app
    +40
  `;
  assert.equal(streakFromHistory(historyPtBr), 3);

  const historyEnUs = `
    My coins: 521
    ${enUs(0)} PT
    App daily check-in
    +40
    ${enUs(1)} PT
    App daily check-in
    +40
    ${enUs(2)} PT
    App daily check-in
    +40
    ${enUs(3)} PT
    App daily check-in
    +40
  `;
  assert.equal(streakFromHistory(historyEnUs), 4);

  const historyWithGap = `
    ${ptBr(0)} PT
    Check-in diário no app
    +40
    ${ptBr(2)} PT
    Check-in diário no app
    +40
  `;
  assert.equal(streakFromHistory(historyWithGap), 1);

  const staleHistory = `
    ${ptBr(5)} PT
    Check-in diário no app
    +40
    ${ptBr(6)} PT
    Check-in diário no app
    +40
  `;
  assert.equal(streakFromHistory(staleHistory), null);

  assert.equal(streakFromHistory('Nenhum dado encontrado'), null);
  assert.equal(streakFromHistory(''), null);
  assert.equal(streakFromHistory(null), null);
});

test('ledger: parseBalance, todaySection e readMycoinPage compostos', () => {
  const { parseBalance, todaySection, readMycoinPage } = loadLedger();

  assert.equal(parseBalance('Minhas moedas\n2.917'), 2917);
  assert.equal(parseBalance('My coins\n1,234'), 1234);
  assert.equal(parseBalance('Minhas moedas\n521'), 521);
  assert.equal(parseBalance('nada aqui'), null);

  const hojeBr = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Los_Angeles' });
  const hojeUs = new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' });
  const text = `
    Minhas moedas
    2917
    ${hojeBr} PT
    Bônus diário
    +40
    Missões de moedas
    +56
    01/01/2020 PT
    Bônus diário
    +1
  `;

  const section = todaySection(text);
  assert.ok(section.includes('Bônus diário'));
  assert.ok(section.includes('Missões de moedas'));
  assert.ok(!section.includes('+1'), 'seção de hoje não deve vazar outro dia');

  const read = readMycoinPage(text);
  assert.equal(read.totalBalance, 2917);
  assert.equal(read.hasCheckinToday, true);
  assert.equal(read.todayBonusCoins, 40);
  assert.equal(read.todayMissionsCoins, 56);
  assert.equal(read.todayMissionsCount, 1);

  // Varredura estrutural (badge sem a palavra "dias"): só aceita > 7.
  assert.equal(readMycoinPage(text, new Date(), 240).domStreak, 240);
  assert.equal(readMycoinPage(text, new Date(), 7).domStreak, null);

  // Formato en-US de hoje também resolve a seção.
  const enText = `My coins\n100\n${hojeUs} PT\nApp daily check-in\n+40\n`;
  assert.equal(readMycoinPage(enText).todayBonusCoins, 40);
});

test('ledger: streakFromText prefere valores > 7 (ciclo semanal vs sequência real)', () => {
  const { streakFromText } = loadLedger();
  assert.equal(streakFromText('Sequência de 7 dias'), 7);
  assert.equal(streakFromText('Sequência de 7 dias • 240 dias de sequência'), 240);
  assert.equal(streakFromText('7-day streak and 212-day streak'), 212);
  assert.equal(streakFromText('Você completou 21 dias seguidos!'), 21);
  assert.equal(streakFromText('Dia 4 de 7'), null);
  assert.equal(streakFromText('+40 moedas'), null);
});

test('dom: pickStreakCandidate prioriza o número do site (dayNumber)', () => {
  const sandbox = { self: {} };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(root, 'src/content/dom.js'), 'utf8'), sandbox, {
    filename: 'dom.js'
  });
  const pick = sandbox.self.AC.dom.pickStreakCandidate;

  // Fonte primária: número do calendário do próprio site (240), mesmo com o
  // valor do ciclo semanal (7) presente no texto.
  assert.equal(pick({ dayNumber: 240, textFallback: 7 }), 240);
  assert.equal(pick({ brokenDays: 240, textFallback: 7 }), 240);
  assert.equal(pick({ structural: 240, textFallback: 7 }), 240);
  assert.equal(pick({ textBest: 240, textFallback: 7 }), 240);
  // Sem nenhuma fonte > 7, vale o valor textual simples (contas novas).
  assert.equal(pick({ textFallback: 7 }), 7);
  assert.equal(pick({}), null);
});

test('accounting: tiers de moedas por dia de sequência', () => {
  assert.equal(coinsFromStreak(1), 10);
  assert.equal(coinsFromStreak(2), 15);
  assert.equal(coinsFromStreak(7), 40);
  assert.equal(coinsFromStreak(212), 40);
  assert.equal(coinsFromStreak(null), 10);
  assert.equal(streakFromCoins(10), 1);
  assert.equal(streakFromCoins(40), 7);
  assert.equal(streakFromCoins(22), null);
});

test('accounting: prioridade do valor do check-in (extrato > modal > estimativa)', () => {
  assert.deepEqual(resolveCheckinCoins({ mobileCoins: 5, ledgerBonus: 40 }), {
    coins: 40,
    source: 'desktop-bonus'
  });
  assert.deepEqual(resolveCheckinCoins({ mobileCoins: 5 }), {
    coins: 5,
    source: 'mobile-modal'
  });
  assert.deepEqual(resolveCheckinCoins({ streak: 3, collected: true }), {
    coins: 20,
    source: 'streak-estimate'
  });
  assert.deepEqual(resolveCheckinCoins({ streak: 3, collected: false }), {
    coins: null,
    source: null
  });
});

test('accounting: computeCheckinCoinsGained (port do relatório original)', () => {
  assert.equal(
    computeCheckinCoinsGained({ alreadyCollected: true, coinsGainedToday: '40', checkinCoinsFromLedger: true }),
    40
  );
  assert.equal(computeCheckinCoinsGained({ alreadyCollected: true, coinsGainedToday: '0' }), 0);
  assert.equal(computeCheckinCoinsGained({ alreadyCollected: false, coinsGainedToday: '0' }), 0);
  assert.equal(
    computeCheckinCoinsGained({ alreadyCollected: false, coinsGainedToday: 'N/D', streakDays: 7 }),
    40
  );
  assert.equal(computeCheckinCoinsGained({ alreadyCollected: false, coinsGainedToday: '40' }), 40);
});

test('accounting: computeTasksCoinsGained desconta check-in pré-crédito (legado)', () => {
  assert.equal(
    computeTasksCoinsGained({ coinsGained: 56, initialBalance: 1000, coinsFromLedger: true }, null),
    56
  );
  assert.equal(
    computeTasksCoinsGained(
      { coinsGained: 96, initialBalance: 1000 },
      { alreadyCollected: false, coinsGainedToday: '40', totalBalance: 1040 }
    ),
    56
  );
  assert.equal(
    computeTasksCoinsGained(
      { coinsGained: 96, initialBalance: 1040 },
      { alreadyCollected: false, coinsGainedToday: '40', totalBalance: 1040 }
    ),
    96
  );
});

test('accounting: isStreakBreak detecta quebra e ignora leituras do ciclo semanal', () => {
  assert.equal(isStreakBreak(1, 212, false), true);
  assert.equal(isStreakBreak(7, 212, false), false);
  assert.equal(isStreakBreak(1, 212, true), false);
  assert.equal(isStreakBreak(50, 49, false), false);
  assert.equal(isStreakBreak(1, 1, false), false);
});

test('accounting: resolveStreakDays (incremento, preservação e extrato)', () => {
  assert.equal(resolveStreakDays({ detectedStreak: null, previousStreakDays: 5, justCollected: true }).streakDays, 6);
  assert.equal(resolveStreakDays({ detectedStreak: 9, previousStreakDays: 5, justCollected: true }).streakDays, 9);
  assert.equal(resolveStreakDays({ detectedStreak: 3, previousStreakDays: 5, alreadyCollected: true }).streakDays, 5);
  assert.equal(resolveStreakDays({ detectedStreak: 3, previousStreakDays: 212, justCollected: true }).streakDays, 213);
  assert.equal(resolveStreakDays({ detectedStreak: 1, previousStreakDays: 50, statementStreak: 10 }).streakDays, 10);
  assert.equal(resolveStreakDays({ detectedStreak: null, previousStreakDays: null, justCollected: true }).streakDays, 1);
});

test('accounting: syncBalanceWithCheckin compensa extrato defasado', () => {
  assert.deepEqual(
    syncBalanceWithCheckin({ balance: 1000, earlyBalance: 1000, checkinCoins: 40, justCollected: true }),
    { balance: 1040, adjusted: true }
  );
  assert.deepEqual(
    syncBalanceWithCheckin({ balance: 1040, earlyBalance: 1000, checkinCoins: 40, justCollected: true }),
    { balance: 1040, adjusted: false }
  );
  assert.deepEqual(
    syncBalanceWithCheckin({ balance: 1000, checkinCoins: 40, justCollected: false }),
    { balance: 1000, adjusted: false }
  );
});

test('accounting: desktopStreakOf (texto > estrutural > histórico > tier)', () => {
  assert.equal(desktopStreakOf({ textStreak: 5, historyStreak: 3, todayBonusCoins: 15 }), 5);
  assert.equal(desktopStreakOf({ textStreak: null, historyStreak: 12, todayBonusCoins: 40 }), 12);
  assert.equal(desktopStreakOf({ textStreak: null, historyStreak: null, todayBonusCoins: 15 }), 2);
  assert.equal(desktopStreakOf({ textStreak: 240, historyStreak: 12, todayBonusCoins: 40 }), 240);
  assert.equal(desktopStreakOf({ textStreak: null, domStreak: 240, historyStreak: 12, todayBonusCoins: 40 }), 240);
  assert.equal(desktopStreakOf({ textStreak: null, domStreak: null, historyStreak: null, todayBonusCoins: 40 }), 7);
  assert.equal(desktopStreakOf(null), null);
});

test('accounting: protectConsolidatedStreak não rebaixa o consolidado sem quebra confirmada', () => {
  assert.equal(protectConsolidatedStreak({ next: 7, previous: 240 }), 240);
  assert.equal(protectConsolidatedStreak({ next: 241, previous: 240 }), 241);
  assert.equal(protectConsolidatedStreak({ next: 1, previous: 240, streakBroken: true }), 1);
  assert.equal(protectConsolidatedStreak({ next: 5, previous: 5 }), 5);
  assert.equal(protectConsolidatedStreak({ next: 7, previous: null }), 7);
  assert.equal(protectConsolidatedStreak({ next: null, previous: 240 }), null);
});

test('accounting: ciclo semanal (7) não vence consolidado de 240 dias', () => {
  // Leitura da tela (7) com consolidado de 240 e check-in já coletado → mantém 240.
  assert.equal(
    resolveStreakDays({ detectedStreak: 7, previousStreakDays: 240, alreadyCollected: true }).streakDays,
    240
  );
  // Tela mostra a sequência real (240) e o consolidado era o ciclo (7) → adota 240.
  assert.equal(
    resolveStreakDays({ detectedStreak: 240, previousStreakDays: 7, justCollected: true }).streakDays,
    240
  );
});

test('accounting: accountCheckin consolida extrato + mobile (já coletado e coleta nova)', () => {
  // Cenário A: check-in já coletado (crédito de +40 no extrato do dia).
  const a = accountCheckin({
    mobileCheckin: { already: true, justCollected: false, coins: null, streak: null, balance: null },
    earlyLedger: {
      totalBalance: 1000,
      hasCheckinToday: true,
      todayBonusCoins: 40,
      todayMissionsCoins: 56,
      textStreak: null,
      historyStreak: 12
    },
    postLedger: {
      totalBalance: 1000,
      hasCheckinToday: true,
      todayBonusCoins: 40,
      todayMissionsCoins: 56,
      textStreak: null,
      historyStreak: 12
    },
    previousStreakDays: 12
  });
  assert.equal(a.alreadyCollected, true);
  assert.equal(a.coinsGainedToday, 40, 'crédito do extrato conta mesmo já coletado');
  assert.equal(a.coinsSource, 'desktop-bonus');
  assert.equal(a.streakDays, 12);
  assert.equal(a.streakBroken, false);
  assert.equal(a.missionsCoins, 56);

  // Cenário B: coleta nova — modal mobile +15 e extrato defasado (saldo sincronizado).
  const b = accountCheckin({
    mobileCheckin: { already: false, justCollected: true, coins: 15, streak: 2, balance: 1000 },
    earlyLedger: {
      totalBalance: 1000,
      hasCheckinToday: false,
      todayBonusCoins: null,
      todayMissionsCoins: 0
    },
    postLedger: {
      totalBalance: 1000,
      hasCheckinToday: false,
      todayBonusCoins: null,
      todayMissionsCoins: 0
    },
    previousStreakDays: 1
  });
  assert.equal(b.justCollected, true);
  assert.equal(b.coins, 15);
  assert.equal(b.coinsSource, 'mobile-modal');
  assert.equal(b.streakDays, 2);
  assert.equal(b.balanceAfterCheckin, 1015);
  assert.equal(b.balanceAdjusted, true);
});
