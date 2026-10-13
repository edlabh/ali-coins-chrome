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

import { computeNextRunAt, parseTimeOfDay, formatDuration, randInt } from '../src/common/schedule.js';
import { statusLabel, coinsSourceLabel, fmtNumber } from '../src/common/format.js';
import {
  pickNextTask,
  taskKey,
  buildReport,
  summarizeTasks,
  migrateSettings,
  SETTINGS_VERSION
} from '../src/common/state-utils.js';
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
  // eslint-disable-next-line no-new-func
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

test('pickNextTask não repete resgates já clicados', () => {
  const t = task({ title: 'Resgatar', isActionable: false, isClaimable: true });
  const picked = pickNextTask([t], {}, { claimed: new Set([taskKey(t)]) });
  assert.equal(picked, null);
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
  const legacy = migrateSettings({ keepWindowOpen: true, user: 'a@b.com' });
  assert.equal(legacy.changed, true);
  assert.equal(legacy.settings.keepWindowOpen, false);
  assert.equal(legacy.settings.silentMode, true, 'v3: segundo plano por padrão');
  assert.equal(legacy.settings.settingsVersion, SETTINGS_VERSION);
  assert.equal(legacy.settings.user, 'a@b.com');

  // Config já na versão atual: preferências do usuário são preservadas.
  const current = migrateSettings({ keepWindowOpen: true, settingsVersion: SETTINGS_VERSION });
  assert.equal(current.changed, false);
  assert.equal(current.settings.keepWindowOpen, true);

  const optedOut = migrateSettings({ silentMode: false, settingsVersion: SETTINGS_VERSION });
  assert.equal(optedOut.changed, false);
  assert.equal(optedOut.settings.silentMode, false, 'opt-out explícito não é revertido');

  // Sem config salva: defaults migrados, sem quebra.
  const fresh = migrateSettings(undefined);
  assert.equal(fresh.changed, true);
  assert.equal(fresh.settings.keepWindowOpen, false);
  assert.equal(fresh.settings.silentMode, true);
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
  assert.equal(classifyTask('Prize Land', 'Water your tree'), 'prize-land');
  assert.equal(classifyTask('Merge Boss game', ''), 'app-only');
  assert.equal(classifyTask('Avaliar pedido', 'Review'), 'app-only');
  assert.equal(classifyTask('Assistir ofertas', 'Navegue por 15s'), 'scroll');
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
  assert.equal(typeof AC.actions.doLogin, 'function');
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
});

// ---------------------------------------------------------------------------
// Contabilidade — parser do extrato (ledger UMD) e funções puras (accounting)
// Fixtures idênticos aos do projeto original (ali-coins tests/balance.test.js).
// ---------------------------------------------------------------------------

/** Avalia o arquivo UMD ledger.js como CommonJS para obter as funções. */
function loadLedger() {
  const code = readFileSync(path.join(root, 'src/content/ledger.js'), 'utf8');
  const moduleObj = { exports: {} };
  // eslint-disable-next-line no-new-func
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
    missionsCount: 0
  });
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
