/**
 * Ações executadas DENTRO da página do AliExpress.
 * Cada ação é um comando curto e idempotente, chamado pelo service worker.
 * Espelha os fluxos do ali-coins (libs/ui/login.js, collect.js, libs/tasks/*).
 */
(function () {
  'use strict';

  const AC = (self.AC = self.AC || {});
  const S = AC.selectors;
  const { sleep, waitUntil, queryVisible, clickHuman, setNativeValue, pressEnter, bodyText, findByText, closeModals, captchaInfo, parseNumber, scrollFor } = AC.dom;

  AC.state = AC.state || { stopRequested: false };
  const isStopped = () => AC.state.stopRequested === true;

  // ---------------------------------------------------------------------------
  // Detecção de estado da página
  // ---------------------------------------------------------------------------

  /** Elementos-assinatura da central de moedas visível (logado). */
  function coinUiPresent() {
    const el =
      queryVisible('#signButton, [class*="today-checked"], [class*="aecoin-today"], [class*="dayNumber"], [class*="rewardItem"]') ||
      queryVisible('[class*="aecoin-"], [class*="coin-index"]');
    if (el) return true;
    const text = bodyText(8000);
    return /My coins|Minhas moedas|Earn more coins|Ganhe mais moedas/i.test(text);
  }

  function loginFormState() {
    const username = queryVisible(S.login.usernameInput);
    const password = queryVisible(S.login.passwordInput);
    const twoFA = queryVisible(S.login.twoFactorInput);
    return { username, password, twoFA };
  }

  // ---------------------------------------------------------------------------
  // LOGIN
  // ---------------------------------------------------------------------------

  function findContinueButton() {
    return findByText([/^continue$/i, /^continuar$/i, /^next$/i, /^pr[oó]ximo$/i], {
      tagNames: ['button'],
      maxCandidates: 400
    });
  }

  function findSignInButton() {
    const explicit = queryVisible('button[type="submit"], button.cosmos-btn-primary');
    if (explicit) return explicit;
    return findByText([/^sign in$/i, /^entrar$/i, /^login$/i], { tagNames: ['button'], maxCandidates: 400 });
  }

  /**
   * Executa o fluxo de login por senha (idempotente: pode ser re-chamado).
   * @param {{user: string, password: string}} params
   */
  async function doLogin({ user, password }) {
    if (captchaInfo().present) return { needsCaptcha: true };
    if (coinUiPresent() && !loginFormState().password) {
      return { ok: true, already: true };
    }

    // Campo de usuário (quando existir).
    let form = loginFormState();
    if (form.username && !form.password) {
      await sleep(300);
      setNativeValue(form.username, user);
      await sleep(250);
      if (captchaInfo().present) return { needsCaptcha: true };

      // Enter primeiro; fallback para botão "Continue" de layouts em etapas.
      pressEnter(form.username);
      await sleep(1600);
      if (captchaInfo().present) return { needsCaptcha: true };

      form = loginFormState();
      if (!form.password && !coinUiPresent()) {
        const cont = findContinueButton();
        if (cont) {
          clickHuman(cont);
          await waitUntil(() => loginFormState().password || coinUiPresent() || captchaInfo().present, {
            timeout: 4000
          });
          if (captchaInfo().present) return { needsCaptcha: true };
          await sleep(500);
        }
      }
    }

    // Campo de senha (fluxo completo ou reautenticação in-page).
    form = loginFormState();
    if (form.password) {
      if (captchaInfo().present) return { needsCaptcha: true };
      await sleep(200);
      setNativeValue(form.password, password);
      await sleep(250);
      if (captchaInfo().present) return { needsCaptcha: true };

      const btn = findSignInButton();
      if (btn) clickHuman(btn);
      else pressEnter(form.password);

      const outcome = await waitUntil(
        () => {
          if (captchaInfo().present) return { needsCaptcha: true };
          const now = loginFormState();
          if (now.twoFA) return { twoFA: true };
          if (coinUiPresent() && !now.password) return { ok: true };
          return null;
        },
        { timeout: 7000, interval: 400 }
      );
      if (outcome) return outcome;
      return { pending: true };
    }

    if (coinUiPresent()) return { ok: true, already: true };

    // Página ainda carregando (skeleton do SPA): pede nova tentativa.
    await waitUntil(() => loginFormState().password || loginFormState().username || coinUiPresent(), {
      timeout: 4000
    });
    if (coinUiPresent()) return { ok: true, already: true };
    return { pending: true };
  }

  /**
   * Aguarda a resolução do captcha pelo usuário durante `chunkMs`.
   * Fatias curtas evitam estourar limites de tempo de mensagem do Chrome.
   */
  async function waitCaptcha({ chunkMs = 60000 } = {}) {
    const deadline = Date.now() + Math.max(3000, chunkMs);
    while (Date.now() < deadline) {
      if (isStopped()) return { aborted: true };
      const info = captchaInfo();
      if (info.kind === 'risk') return { blocked: true };
      if (!info.present) {
        await sleep(800);
        if (!captchaInfo().present) return { solved: true };
      }
      await sleep(1500);
    }
    return { still: true };
  }

  /** Aguarda o usuário concluir o 2FA manualmente na janela. */
  async function wait2FA({ chunkMs = 60000 } = {}) {
    const deadline = Date.now() + Math.max(3000, chunkMs);
    while (Date.now() < deadline) {
      if (isStopped()) return { aborted: true };
      if (captchaInfo().present) return { needsCaptcha: true };
      const form = loginFormState();
      if (!form.twoFA || coinUiPresent()) return { ok: true };
      await sleep(1500);
    }
    return { still: true };
  }

  // ---------------------------------------------------------------------------
  // CHECK-IN
  // ---------------------------------------------------------------------------

  function todayChecked() {
    if (queryVisible(S.checkin.todayChecked)) return true;
    return S.checkin.todayTextPattern.test(bodyText(8000));
  }

  function readStreak() {
    const text = bodyText(12000);
    for (const re of S.coin.streakPatterns) {
      const m = text.match(re);
      if (m) {
        const n = Number.parseInt(m[1], 10);
        if (Number.isFinite(n) && n >= 1) return n;
      }
    }
    return null;
  }

  function readBalance() {
    const text = bodyText(12000);
    for (const re of S.coin.balancePatterns) {
      const m = text.match(re);
      if (m) {
        const n = parseNumber(m[1]);
        if (n !== null) return { balance: n, raw: m[0] };
      }
    }
    // Elementos de saldo por classe
    const el = queryVisible('[class*="balance"], [class*="coinNum"], [class*="coin-num"], [class*="assets"]');
    if (el) {
      const m = (el.textContent || '').match(/([0-9][0-9.,]*)/);
      if (m) {
        const n = parseNumber(m[1]);
        if (n !== null) return { balance: n, raw: el.textContent.trim().slice(0, 60) };
      }
    }
    return { balance: null, raw: null };
  }

  async function doCheckin() {
    if (captchaInfo().present) return { needsCaptcha: true };
    closeModals();
    await sleep(300);

    const already = todayChecked();
    let justCollected = false;

    if (!already) {
      for (const sel of S.checkin.collectButtonList) {
        if (isStopped()) return { aborted: true };
        const el = queryVisible(sel);
        if (!el) continue;
        // Não confundir com o botão da gaveta de tarefas.
        const text = (el.textContent || '').trim();
        if (S.tasks.openDrawerTexts.some((re) => re.test(text))) continue;

        clickHuman(el);
        const confirmed = await waitUntil(() => todayChecked(), { timeout: 3000, interval: 300 });
        await sleep(800);
        if (confirmed) {
          justCollected = true;
          break;
        }
      }
      // Fallback por texto ("Collect"/"Coletar").
      if (!justCollected) {
        const btn = findByText(S.checkin.collectButtonTexts, { tagNames: ['button', 'div'], maxCandidates: 1500 });
        if (btn) {
          clickHuman(btn);
          justCollected = Boolean(await waitUntil(() => todayChecked(), { timeout: 3000, interval: 300 }));
        }
      }
    }

    // Moedas do modal de sucesso (somente elementos visíveis).
    let coins = null;
    if (justCollected) {
      coins = await waitUntil(
        () => {
          const modalEls = Array.from(
            document.querySelectorAll('[class*="modal"], [class*="dialog"], [class*="popup"], [class*="toast"], [role="dialog"], [class*="aecoin-"]')
          ).filter(AC.dom.isVisible);
          for (const el of modalEls) {
            const m = (el.innerText || '').match(/\+([0-9]+)\s*(?:moedas?|coins?)?/i);
            if (m) {
              const val = Number.parseInt(m[1], 10);
              if (Number.isFinite(val) && val > 0) return val;
            }
          }
          return null;
        },
        { timeout: 2500, interval: 300 }
      );
    }

    const streak = readStreak();

    // Fazenda Mágica (melhor esforço, como o collect.js).
    let water = false;
    try {
      const waterBtn = queryVisible(S.checkin.waterBtn);
      if (waterBtn) {
        clickHuman(waterBtn);
        water = true;
        await sleep(800);
      }
    } catch {
      // opcional
    }

    closeModals();
    const balance = readBalance();
    return {
      already: already && !justCollected,
      justCollected,
      coins,
      streak,
      water,
      balance: balance.balance,
      balanceRaw: balance.raw
    };
  }

  // ---------------------------------------------------------------------------
  // GAVETA DE TAREFAS
  // ---------------------------------------------------------------------------

  function drawerOpen() {
    const el = document.querySelector(S.tasks.drawerContainer);
    if (!el || !AC.dom.isVisible(el)) return false;
    return el.getBoundingClientRect().height > 100;
  }

  async function openDrawer() {
    if (captchaInfo().present) return { needsCaptcha: true };
    if (drawerOpen()) return { ok: true };

    // Skeleton do SPA: aguarda sumir (o reload fica a cargo do run seguinte).
    const skeleton = await waitUntil(() => !document.querySelector(S.login.loginPendingContainer), {
      timeout: 10000,
      interval: 350
    });
    if (!skeleton && document.querySelector(S.login.loginPendingContainer)) {
      return { ok: false, skeleton: true };
    }

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      if (isStopped()) return { aborted: true };
      if (captchaInfo().present) return { needsCaptcha: true };
      closeModals();

      let btn = queryVisible(S.tasks.openDrawerBtn);
      if (!btn) {
        btn = findByText(S.tasks.openDrawerTexts, { tagNames: ['button', 'div'], maxCandidates: 2500 });
      }
      if (btn) {
        clickHuman(btn);
        const opened = await waitUntil(() => drawerOpen() || queryVisible(S.tasks.taskItem), {
          timeout: 6000,
          interval: 400
        });
        if (opened) return { ok: true };
      } else {
        window.scrollBy(0, 150);
      }
      await sleep(1400);
    }
    return { ok: false };
  }

  function extractTasks() {
    const rows = Array.from(document.querySelectorAll(S.tasks.taskItem)).filter((e) => AC.dom.isVisible(e));
    const tasks = rows.map((row, idx) => {
      const title = (row.querySelector(S.tasks.taskTitle)?.innerText || '').trim();
      const desc = (row.querySelector(S.tasks.taskSecondTitle)?.innerText || '').trim();
      const btn = row.querySelector(S.tasks.taskBtn);
      const btnText = (btn?.innerText || '').trim();
      const btnStyle = btn?.getAttribute('style') || '';
      const statusText = (row.querySelector(S.tasks.taskStatus)?.innerText || '').trim();

      let completedRounds = null;
      let totalRounds = null;
      const sm = statusText.match(/^([0-9]+)\/([0-9]+)$/);
      if (sm) {
        completedRounds = Number.parseInt(sm[1], 10);
        totalRounds = Number.parseInt(sm[2], 10);
      }

      const isActionable = /^(GO|IR)$/i.test(btnText);
      const isClaimable = /^(COLLECT|COLETAR|GET|RECEBER|CLAIM|RESGATAR|\+[0-9]+)/i.test(btnText);

      let isDone = false;
      if (completedRounds !== null && totalRounds !== null) {
        isDone = completedRounds >= totalRounds && !isClaimable;
      } else {
        const isDisabledStyle = btnStyle.includes('opacity: 0.5');
        const isDoneText = /^(DONE|CONCLU[IÍ]DO|COMPLETED)$/i.test(btnText);
        isDone = !isClaimable && (isDisabledStyle || isDoneText);
      }

      const kind = AC.classifyTask(title, desc);
      const scrollSeconds = AC.scrollSecondsForTask(title, desc, 10);

      return {
        index: idx,
        title,
        desc,
        btnText,
        statusText,
        completedRounds,
        totalRounds,
        isActionable,
        isClaimable,
        isDone,
        kind,
        scrollSeconds
      };
    });
    return { tasks };
  }

  function clickTask({ index, title }) {
    const rows = Array.from(document.querySelectorAll(S.tasks.taskItem)).filter((e) => AC.dom.isVisible(e));
    if (rows.length === 0) return { clicked: false };

    const titleOf = (row) => (row.querySelector(S.tasks.taskTitle)?.innerText || '').trim();

    // A lista pode ter re-renderizado entre a extração e o clique: valida o título
    // e realoca a linha por título quando o índice não bater (paridade com findTaskElement).
    let row = rows[index];
    if (row && title && titleOf(row) !== title) {
      row = rows.find((r) => titleOf(r) === title) || null;
    }
    if (!row) return { clicked: false };

    const btn = row.querySelector(S.tasks.taskBtn) || row.querySelector(S.tasks.taskRight);
    if (!btn) return { clicked: false };
    const btnText = (btn.innerText || '').trim();
    clickHuman(btn);
    return { clicked: true, btnText };
  }

  // ---------------------------------------------------------------------------
  // AÇÕES DAS TAREFAS (surpresa, busca, scroll)
  // ---------------------------------------------------------------------------

  const TOUCHED_KEY = 'ac:touched-cards';

  function loadTouched() {
    try {
      const raw = sessionStorage.getItem(TOUCHED_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set();
    }
  }

  function saveTouched(set) {
    try {
      sessionStorage.setItem(TOUCHED_KEY, JSON.stringify(Array.from(set).slice(-200)));
    } catch {
      // sessionStorage indisponível: segue sem persistir
    }
  }

  function cardSignature(card, idx) {
    const link = card.matches && card.matches('a') ? card : card.querySelector('a');
    const href = (link && (link.getAttribute('href') || link.href)) || '';
    const dataId =
      (card.getAttribute && (card.getAttribute('data-item-id') || card.getAttribute('data-product-id') || card.getAttribute('data-id'))) ||
      '';
    const text = (card.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const img = card.querySelector && card.querySelector('img');
    const src = img ? img.getAttribute('src') || '' : '';
    return dataId || href || text || src || `card-idx-${idx}`;
  }

  async function surpriseTaps(seconds) {
    const cardsSel = S.tasks.productCard;
    await waitUntil(() => queryVisible(cardsSel), { timeout: 12000, interval: 500 });
    const touched = loadTouched();
    const startUrl = location.href;
    let clicked = 0;

    for (let i = 0; i < 3; i += 1) {
      if (isStopped()) break;
      let cards = Array.from(document.querySelectorAll(cardsSel)).filter((e) => AC.dom.isVisible(e));
      if (cards.length === 0) {
        await sleep(1200);
        cards = Array.from(document.querySelectorAll(cardsSel)).filter((e) => AC.dom.isVisible(e));
      }
      if (cards.length === 0) break;

      let target = null;
      let sig = '';
      for (let idx = 0; idx < cards.length; idx += 1) {
        const s = cardSignature(cards[idx], idx);
        if (!touched.has(s)) {
          target = cards[idx];
          sig = s;
          break;
        }
      }
      if (!target) {
        // Todos tocados nesta página: rola para carregar novos itens.
        await scrollFor(2, isStopped);
        cards = Array.from(document.querySelectorAll(cardsSel)).filter((e) => AC.dom.isVisible(e));
        for (let idx = 0; idx < cards.length; idx += 1) {
          const s = cardSignature(cards[idx], idx);
          if (!touched.has(s)) {
            target = cards[idx];
            sig = s;
            break;
          }
        }
      }
      if (!target) break;

      // Evita novas abas: força target=_self no link interno quando existir.
      const link = target.matches && target.matches('a') ? target : target.querySelector('a');
      if (link) {
        try {
          link.target = '_self';
        } catch {
          // atributo pode ser somente leitura em casos raros
        }
      }

      clickHuman(link || target);
      touched.add(sig);
      saveTouched(touched);
      clicked += 1;
      await sleep(1600);

      if (location.href !== startUrl) {
        // Navegou para a ficha do produto: permanece, rola e volta ao feed.
        await scrollFor(Math.max(3, Math.min(6, seconds || 4)), isStopped);
        history.back();
        await waitUntil(
          () => location.href === startUrl || Boolean(queryVisible(cardsSel)),
          { timeout: 8000, interval: 400 }
        );
        await sleep(1200);
      }
    }
    return { ok: clicked > 0, clicked };
  }

  async function executeSearchTask(query, seconds) {
    let input = queryVisible(S.tasks.searchInput);
    if (!input) {
      const opener = queryVisible('[class*="searchBar"], [class*="search-bar"], [class*="searchBox"], [aria-label*="search" i], [class*="search"]');
      if (opener && /search|busca/i.test(opener.className + ' ' + (opener.getAttribute('aria-label') || ''))) {
        clickHuman(opener);
        input = await waitUntil(() => queryVisible(S.tasks.searchInput), { timeout: 4000, interval: 300 });
      }
    }
    if (input) {
      input.focus();
      setNativeValue(input, query || 'fone bluetooth');
      await sleep(250);
      pressEnter(input);
      await sleep(1500);
    }
    await scrollFor(seconds || 10, isStopped);
    return { ok: Boolean(input), foundInput: Boolean(input) };
  }

  /**
   * Executa a ação da tarefa na página atual.
   * @param {{kind: string, query?: string, seconds?: number}} params
   */
  async function runAction({ kind, query, seconds }) {
    if (captchaInfo().present) return { needsCaptcha: true };
    if (kind === 'surprise') {
      const res = await surpriseTaps(seconds || 10);
      return { ok: true, ...res };
    }
    if (kind === 'search') {
      const res = await executeSearchTask(query, seconds || 10);
      return { ok: true, ...res };
    }
    // scroll / prize-land / app-only (quando habilitado nas opções)
    await scrollFor(seconds || 10, isStopped);
    return { ok: true };
  }

  AC.actions = {
    doLogin,
    waitCaptcha,
    wait2FA,
    doCheckin,
    readBalance: () => ({ ...readBalance(), streak: readStreak(), todayChecked: todayChecked() }),
    openDrawer,
    extractTasks,
    clickTask,
    runAction,
    coinUiPresent
  };
})();
