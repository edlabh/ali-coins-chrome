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
import { pickNextTask, taskKey, buildReport, summarizeTasks } from '../src/common/state-utils.js';

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
    balanceAfter: 130
  });
  assert.equal(report.gained, 30);
  assert.equal(report.durationMs, 50000);
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
  assert.equal(typeof AC.actions.doLogin, 'function');
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
