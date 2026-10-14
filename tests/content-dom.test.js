/**
 * Testes de DOM (jsdom) do content script.
 *
 * Carregam os MESMOS arquivos injetados no navegador (selectors, task-classify,
 * ledger, dom, actions) dentro de um jsdom, com três adaptações de ambiente:
 *  - `innerText` → `textContent` (jsdom não implementa innerText);
 *  - `getBoundingClientRect` padrão com caixa visível (`data-invisible` zera) —
 *    o jsdom retorna zeros e deixaria todo elemento "invisível";
 *  - `chrome.runtime.sendMessage` mockado (captura as mensagens e permite
 *    simular o clique confiável CDP do background).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const CONTENT_FILES = [
  'src/content/selectors.js',
  'src/content/task-classify.js',
  'src/content/ledger.js',
  'src/content/dom.js',
  'src/content/actions.js'
];

const EMPTY_RECT = {
  width: 0,
  height: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  x: 0,
  y: 0,
  toJSON() {}
};
const VISIBLE_RECT = {
  width: 80,
  height: 32,
  top: 5,
  left: 5,
  right: 85,
  bottom: 37,
  x: 5,
  y: 5,
  toJSON() {}
};

/**
 * Cria um ambiente jsdom + vm com os content scripts reais carregados.
 * @param {string} html conteúdo do body
 * @param {{url?: string}} [options]
 */
function createContentEnv(html, options = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`, {
    url: options.url || 'https://m.aliexpress.com/p/coin-index/index.html'
  });
  const { window } = dom;

  // jsdom não implementa innerText: mapeia para textContent.
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    get() {
      return this.textContent;
    },
    set(value) {
      this.textContent = value;
    },
    configurable: true
  });

  // Caixa padrão visível; `data-invisible` marca elementos ocultos.
  window.Element.prototype.getBoundingClientRect = function () {
    if (this.getAttribute && this.getAttribute('data-invisible') !== null) return EMPTY_RECT;
    return VISIBLE_RECT;
  };
  window.Element.prototype.scrollIntoView = function () {};

  const messages = [];
  let sendMessageHandler = async () => ({ ok: false });

  const sandbox = {
    console,
    document: window.document,
    window,
    location: window.location,
    history: window.history,
    sessionStorage: window.sessionStorage,
    navigator: window.navigator,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    Event: window.Event,
    // jsdom não expõe PointerEvent; MouseEvent cobre o dispatch.
    PointerEvent: window.MouseEvent,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    chrome: {
      runtime: {
        sendMessage: async (msg) => {
          messages.push(msg);
          return sendMessageHandler(msg);
        }
      }
    }
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);

  for (const file of CONTENT_FILES) {
    const code = readFileSync(path.join(root, file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  }

  return {
    dom,
    window,
    AC: sandbox.AC,
    messages,
    setSendMessageHandler(fn) {
      sendMessageHandler = fn;
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers de DOM
// ---------------------------------------------------------------------------

test('DOM: visibilidade, queryVisible e data-invisible', () => {
  const env = createContentEnv(`
    <button id="ok">Ganhe</button>
    <button id="hidden" data-invisible>Oculto</button>
  `);
  const { AC, window } = env;

  assert.equal(AC.dom.isVisible(window.document.getElementById('ok')), true);
  assert.equal(AC.dom.isVisible(window.document.getElementById('hidden')), false);
  assert.equal(AC.dom.queryVisible('#hidden, #ok')?.id, 'ok');
  assert.equal(AC.dom.queryVisible('#nao-existe'), null);
});

test('DOM: findAllByText prioriza o elemento mais interno e clickableFrom sobe ao botão', () => {
  const env = createContentEnv(`
    <div class="aecoin-signButtonWrapper">
      <button id="drawer-btn"><span id="label">Ganhe mais moedas</span></button>
    </div>
  `);
  const { AC } = env;

  const els = AC.dom.findAllByText([/ganhe mais moedas/i], {
    tagNames: ['button', 'div', 'span']
  });
  assert.equal(els.length, 1, 'apenas o elemento mais interno deve sobrar');
  assert.equal(els[0].id, 'label');
  assert.equal(AC.dom.clickableFrom(els[0]).id, 'drawer-btn');
});

test('DOM: findByText e captchaInfo (slider, iframe, risco e limpo)', () => {
  const slider = createContentEnv(`<div id="nc_1_n1z">slider</div>`);
  assert.deepEqual({ ...slider.AC.dom.captchaInfo() }, { present: true, kind: 'slider' });

  const iframe = createContentEnv(`<iframe src="https://x/punish/captcha.html"></iframe>`);
  assert.deepEqual({ ...iframe.AC.dom.captchaInfo() }, { present: true, kind: 'iframe' });

  const risk = createContentEnv(`<p>FAIL_SYS_USER_VALIDATE detected</p>`);
  assert.deepEqual({ ...risk.AC.dom.captchaInfo() }, { present: true, kind: 'risk' });

  const clean = createContentEnv(`<button>Coletar</button>`);
  assert.deepEqual({ ...clean.AC.dom.captchaInfo() }, { present: false, kind: null });
  assert.ok(clean.AC.dom.findByText([/^coletar$/i], { tagNames: ['button'] }));
});

test('DOM: closeModals clica em botões de fechar dentro de diálogos', () => {
  const env = createContentEnv(`<div class="modal"><button class="x-btn">Fechar</button></div>`);
  const { AC, window } = env;

  let clicked = 0;
  window.document.querySelector('.x-btn').addEventListener('click', () => {
    clicked += 1;
  });
  assert.equal(AC.dom.closeModals(), true);
  assert.equal(clicked, 1);

  const outside = createContentEnv(`<button class="x-btn">Fechar</button>`);
  assert.equal(outside.AC.dom.closeModals(), false, 'fora de diálogo não deve clicar');
});

test('DOM: readStreakFromStructure aceita apenas valores > 7', () => {
  const env = createContentEnv(`
    <div class="streak-badge">240</div>
    <div class="sequence-info">7</div>
  `);
  assert.equal(env.AC.dom.readStreakFromStructure(), 240);
});

// ---------------------------------------------------------------------------
// Leitura de estado da página (actions.js)
// ---------------------------------------------------------------------------

test('AÇÕES: readStreak prioriza o dayNumber do site (240) sobre o ciclo semanal (7)', () => {
  const env = createContentEnv(`
    <div class="calendar">
      <span class="aecoin-dayNumber-30glg aecoin-checkedDay-2HFlE">240</span>
      <div class="aecoin-calendarText-3ONX-">day(s) streak</div>
    </div>
    <p>Sequência de 7 dias</p>
  `);
  // readStreak é exposto de forma composta por readBalance (usado pelo relatório).
  assert.equal(env.AC.actions.readBalance().streak, 240);
});

test('AÇÕES: readStreak usa modal de quebra e padrões textuais como fallback', () => {
  const broken = createContentEnv(`
    <div class="aecoin-brokenDays-1lFTg"><div class="aecoin-number-2QVPm">212</div> days</div>
  `);
  assert.equal(broken.AC.actions.readBalance().streak, 212);

  const text = createContentEnv(`<p>Você completou 21 dias seguidos!</p>`);
  assert.equal(text.AC.actions.readBalance().streak, 21);

  const cycle = createContentEnv(`<p>Sequência de 7 dias</p>`);
  assert.equal(cycle.AC.actions.readBalance().streak, 7);
});

test('AÇÕES: checkAuth distingue logado, login, 2FA, captcha e pendente', () => {
  const logged = createContentEnv(`<button id="signButton">Collect</button><p>My coins</p>`);
  assert.equal(logged.AC.actions.checkAuth().state, 'logged_in');

  const login = createContentEnv(`<input id="fm-login-id" name="loginId" type="text" />`);
  assert.equal(login.AC.actions.checkAuth().state, 'needs_login');

  const twofa = createContentEnv(`<input id="fm-login-code" maxlength="6" type="tel" />`);
  assert.equal(twofa.AC.actions.checkAuth().state, 'two_fa');

  const captcha = createContentEnv(`<div id="nc_1_n1z">slider</div>`);
  assert.equal(captcha.AC.actions.checkAuth().state, 'captcha');

  const pending = createContentEnv(`<div class="login-pending-container"></div>`);
  assert.equal(pending.AC.actions.checkAuth().state, 'pending');
});

test('AÇÕES: todayChecked e readBalance leem o estado do check-in', () => {
  const env = createContentEnv(`
    <div class="aecoin-today-checked-1AuMm"></div>
    <p>Minhas moedas</p><p>2.917</p>
  `);
  const res = env.AC.actions.readBalance();
  assert.equal(res.todayChecked, true);
  assert.equal(res.balance, 2917);

  const unchecked = createContentEnv(`<p>Minhas moedas</p><p>521</p>`);
  assert.equal(unchecked.AC.actions.readBalance().todayChecked, false);
  assert.equal(unchecked.AC.actions.readBalance().balance, 521);
});

test('AÇÕES: readMycoin lê o extrato composto da página mycoin', async () => {
  const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Los_Angeles' });
  // Quebras de linha entre os blocos: o innerText real do navegador insere \n
  // entre elementos de bloco (o parser do extrato depende disso).
  const env = createContentEnv(
    `
      <p>Minhas moedas</p>
      <p>2.917</p>
      <p>${hoje} PT</p>
      <p>Bônus diário</p>
      <p>+40</p>
      <p>Missões de moedas</p>
      <p>+56</p>
    `,
    { url: 'https://www.aliexpress.com/p/coin-pc-index/mycoin.html' }
  );

  const res = await env.AC.actions.readMycoin();
  assert.equal(res.totalBalance, 2917);
  assert.equal(res.hasCheckinToday, true);
  assert.equal(res.todayBonusCoins, 40);
  assert.equal(res.todayMissionsCoins, 56);

  const page = createContentEnv(`<p>nada</p>`);
  assert.deepEqual({ ...(await page.AC.actions.readMycoin()) }, { error: 'not-mycoin-page' });
});

test('AÇÕES: listFeedCards encontra os cards reais do feed (exclui subpartes e wrappers)', () => {
  const env = createContentEnv(`
    <div class="aecoin-feedlist-card-wrapper">
      <div class="aecoin-feedlist-card-sSnlv" data-item-id="card-a">
        <div class="aecoin-feedlist-card-img-x"></div>
        <div class="aecoin-feedlist-card-bubble"><span class="feedlist-card-bubble-num">+5</span></div>
      </div>
      <div class="aecoin-feedlist-card-sSnlv" data-item-id="card-b"><a href="/item/2">x</a></div>
    </div>
    <div class="feeds-discount-card" data-item-id="card-c"></div>
  `);
  const sigs = env.AC.actions.listFeedCards();
  assert.deepEqual([...sigs], ['card-a', 'card-b', 'card-c']);
});

test('AÇÕES: surpriseTapNext toca 1 item por vez e nunca repete (sessionStorage)', async () => {
  const env = createContentEnv(`
    <div class="aecoin-feedlist-card-sSnlv" data-item-id="card-a"></div>
    <div class="aecoin-feedlist-card-sSnlv" data-item-id="card-b"></div>
    <div class="aecoin-feedlist-card-sSnlv" data-item-id="card-c"></div>
  `);
  const first = await env.AC.actions.surpriseTapNext();
  const second = await env.AC.actions.surpriseTapNext();
  const third = await env.AC.actions.surpriseTapNext();

  assert.equal(first.clicked, true);
  assert.equal(first.signature, 'card-a');
  assert.equal(first.debug.raw, 3);
  assert.equal(second.signature, 'card-b');
  assert.equal(third.signature, 'card-c');

  // Sem itens novos: rola e devolve clicked=false — itens nunca se repetem.
  const fourth = await env.AC.actions.surpriseTapNext();
  assert.equal(fourth.clicked, false);
});

// ---------------------------------------------------------------------------
// Painel de tarefas (actions.js)
// ---------------------------------------------------------------------------

const TASKS_HTML = `
  <div class="e2e_normal_task">
    <div class="e2e_normal_task_content_title">Surprise products</div>
    <div class="e2e_normal_task_content_secondTitle">Tap 3 items</div>
    <div class="statusText">1/3</div>
    <div class="e2e_normal_task_right"><button class="e2e_normal_task_right_btn">GO</button></div>
  </div>
  <div class="e2e_normal_task">
    <div class="e2e_normal_task_content_title">Search and win</div>
    <div class="e2e_normal_task_content_secondTitle">Use keywords</div>
    <div class="e2e_normal_task_right"><button class="e2e_normal_task_right_btn">+40</button></div>
  </div>
  <div class="e2e_normal_task">
    <div class="e2e_normal_task_content_title">Merge Boss game</div>
    <div class="e2e_normal_task_content_secondTitle"></div>
    <div class="e2e_normal_task_right">
      <button class="e2e_normal_task_right_btn" style="opacity: 0.5">GO</button>
    </div>
  </div>
  <div class="e2e_normal_task">
    <div class="e2e_normal_task_content_title">Pesquise produtos</div>
    <div class="e2e_normal_task_content_secondTitle"></div>
    <div class="e2e_normal_task_right"><button class="e2e_normal_task_right_btn">Iniciar agora</button></div>
  </div>
`;

test('AÇÕES: extractTasks classifica cards do painel (GO/COLLECT/rodadas/kind)', async () => {
  const env = createContentEnv(TASKS_HTML);
  const { tasks, debug } = await env.AC.actions.extractTasks();

  assert.equal(tasks.length, 4);
  assert.deepEqual(
    { ...debug, sampleButtons: [...debug.sampleButtons] },
    { rawCards: 4, visibleCards: 4, sampleButtons: ['GO', '+40', 'GO', 'Iniciar agora'] }
  );

  assert.equal(tasks[0].kind, 'surprise');
  assert.equal(tasks[0].isActionable, true);
  assert.equal(tasks[0].completedRounds, 1);
  assert.equal(tasks[0].totalRounds, 3);
  assert.equal(tasks[0].isDone, false);

  assert.equal(tasks[1].kind, 'search');
  assert.equal(tasks[1].isClaimable, true);
  assert.equal(tasks[1].isDone, false);

  assert.equal(tasks[2].kind, 'app-only');
  assert.equal(tasks[2].isDone, true, 'opacidade 0.5 + não resgatável = concluída');
  assert.equal(tasks[2].isActionable, false);

  // Regressão do painel em contas novas: rótulos fora de GO/IR ("Iniciar
  // agora") precisam ser tratados como executáveis — antes ficavam pendentes
  // para sempre e o run encerrava sem executar nada.
  assert.equal(tasks[3].kind, 'search');
  assert.equal(tasks[3].isActionable, true, 'rótulo alternativo deve ser executável');
  assert.equal(tasks[3].isDone, false);
});

test('AÇÕES: clickTask envia clique confiável (TRUSTED_CLICK) com coordenadas', async () => {
  const env = createContentEnv(TASKS_HTML);
  env.setSendMessageHandler(async () => ({ ok: true }));

  const res = await env.AC.actions.clickTask({ index: 0, title: 'Surprise products' });
  assert.equal(res.clicked, true);

  const trusted = env.messages.find((m) => m.type === 'TRUSTED_CLICK');
  assert.ok(trusted, 'mensagem TRUSTED_CLICK deve ter sido enviada');
  assert.equal(trusted.payload.x, 45);
  assert.equal(trusted.payload.y, 21);
});

test('AÇÕES: clickTask realoca a linha pelo título quando o índice mudou', async () => {
  const env = createContentEnv(`
    <div class="e2e_normal_task">
      <div class="e2e_normal_task_content_title">Resgatar moedas</div>
      <div class="e2e_normal_task_right"><button class="e2e_normal_task_right_btn">+5</button></div>
    </div>
    <div class="e2e_normal_task">
      <div class="e2e_normal_task_content_title">Navegar e ganhar</div>
      <div class="e2e_normal_task_right"><button id="nav-btn" class="e2e_normal_task_right_btn">GO</button></div>
    </div>
  `);
  // Sem clique confiável: cai no fallback sintético (clickHuman).
  env.setSendMessageHandler(async () => ({ ok: false }));

  let navClicks = 0;
  env.window.document.getElementById('nav-btn').addEventListener('click', () => {
    navClicks += 1;
  });

  const res = await env.AC.actions.clickTask({ index: 0, title: 'Navegar e ganhar' });
  assert.equal(res.clicked, true);
  assert.equal(navClicks, 1, 'o clique deve ir para a linha com o título correto');
});
