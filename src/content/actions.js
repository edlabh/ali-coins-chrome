/**
 * Ações executadas DENTRO da página do AliExpress.
 * Cada ação é um comando curto e idempotente, chamado pelo service worker.
 * Espelha os fluxos do ali-coins (libs/ui/login.js, collect.js, libs/tasks/*).
 */
(function () {
  'use strict';

  const AC = (self.AC = self.AC || {});
  const S = AC.selectors;
  const { sleep, waitUntil, queryVisible, clickHuman, setNativeValue, pressEnter, bodyText, findByText, findAllByText, closeModals, captchaInfo, parseNumber, scrollFor } = AC.dom;

  AC.state = AC.state || { stopRequested: false };
  const isStopped = () => AC.state.stopRequested === true;

  /**
   * Clique "de verdade" via CDP (background) quando disponível; o evento
   * sintético fica como fallback. O clique vai por COORDENADAS (centro do
   * elemento), como um tap real: atinge o que está visualmente no ponto e
   * produz eventos isTrusted=true (SPAs podem ignorar eventos sintéticos).
   * @param {Element} el
   * @returns {Promise<boolean>} true quando o clique confiável foi aplicado
   */
  async function smartClick(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ block: 'center', inline: 'center' });
    } catch {
      // segue com a posição atual
    }
    await sleep(120);
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      if (x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight) {
        const res = await chrome.runtime
          .sendMessage({ type: 'TRUSTED_CLICK', payload: { x, y } })
          .catch(() => null);
        if (res && res.ok) return true;
      }
    }
    clickHuman(el);
    return false;
  }

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

  /**
   * Consulta o estado de autenticação da página para decidir se um login é
   * necessário. Nunca preenche campos — é somente leitura (espelha o
   * shouldAttemptLogin do ali-coins: senha visível manda; sem formulário e com
   * a central de moedas carregada, a sessão é considerada válida).
   * @returns {{state: 'logged_in'|'needs_login'|'pending'|'captcha'|'two_fa'}}
   */
  function checkAuth() {
    const form = loginFormState();
    const captcha = captchaInfo();
    const skeleton = Boolean(document.querySelector(S.login.loginPendingContainer));
    const loginUrl = /login|sign-?in|passport/i.test(location.href);
    const coin = coinUiPresent();

    if (form.twoFA) return { state: 'two_fa' };
    if (captcha.present && !coin) return { state: 'captcha', captchaKind: captcha.kind };
    // Campo de usuário/senha visível = prompt de login (fluxo completo ou
    // reautenticação in-page que pede só a senha na mesma URL do coin-index).
    if (form.password || form.username) return { state: 'needs_login' };
    if (coin) return { state: 'logged_in' };
    if (loginUrl) return { state: skeleton ? 'pending' : 'needs_login' };
    return { state: 'pending' };
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
          await smartClick(cont);
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
      if (btn) await smartClick(btn);
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

  /**
   * Lê a sequência (streak) DIRETO da página, com as fontes que o próprio site usa:
   *   1. `[class*="dayNumber"]` — número principal do calendário (o bundle do site
   *      usa essa classe para o TOTAL de dias, com fonte especial >100 e classe
   *      `a4` >999; ex.: "240  day(s) streak"). O rótulo "day(s) streak" tem
   *      parênteses e não casa com padrões de texto — por isso o elemento manda;
   *   2. `[class*="brokenDays"]` — modal "{0} Streak lost" (também traz o total);
   *   3. padrões textuais (preferem valores > 7 sobre o ciclo semanal 1..7);
   *   4. varredura estrutural (badges com classe/id de streak).
   */
  function readStreak() {
    let dayNumber = null;
    for (const el of document.querySelectorAll('[class*="dayNumber"]')) {
      if (!AC.dom.isVisible(el)) continue;
      const m = (el.innerText || el.textContent || '').trim().match(/^([0-9]{1,6})$/);
      if (m) {
        const n = Number.parseInt(m[1], 10);
        if (dayNumber === null || n > dayNumber) dayNumber = n;
      }
    }

    let brokenDays = null;
    for (const el of document.querySelectorAll('[class*="brokenDays"]')) {
      if (!AC.dom.isVisible(el)) continue;
      const m = (el.innerText || el.textContent || '').match(/([0-9]{1,6})/);
      if (m) {
        brokenDays = Number.parseInt(m[1], 10);
        break;
      }
    }

    const text = bodyText(12000);
    let textFallback = null;
    let textBest = null;
    for (const re of S.coin.streakPatterns) {
      const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
      for (const m of text.matchAll(global)) {
        const n = Number.parseInt(m[1], 10);
        if (!Number.isFinite(n) || n < 1) continue;
        if (textFallback === null) textFallback = n;
        if (n > 7 && (textBest === null || n > textBest)) textBest = n;
      }
    }

    const structural = AC.dom.readStreakFromStructure();
    return AC.dom.pickStreakCandidate({
      dayNumber,
      brokenDays,
      textBest,
      structural,
      textFallback
    });
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

  async function doCheckin(options = {}) {
    if (captchaInfo().present) return { needsCaptcha: true };

    // Salvaguarda: se a sessão expirou entre a verificação de auth e o check-in,
    // devolve o controle ao runner para autenticar antes de tentar coletar.
    const loginNow = loginFormState();
    if ((loginNow.username || loginNow.password) && !coinUiPresent()) {
      return { needsLogin: true };
    }

    closeModals();
    await sleep(300);

    // `assumeCollected`: o extrato desktop já indicava o check-in de hoje — não
    // clica de novo (paridade com o wasAlreadyCollectedToday do ali-coins).
    const assumeCollected = options.assumeCollected === true;
    const alreadyUi = todayChecked();
    const already = assumeCollected || alreadyUi;
    let justCollected = false;

    if (!already) {
      for (const sel of S.checkin.collectButtonList) {
        if (isStopped()) return { aborted: true };
        const el = queryVisible(sel);
        if (!el) continue;
        // Não confundir com o botão da gaveta de tarefas.
        const text = (el.textContent || '').trim();
        if (S.tasks.openDrawerTexts.some((re) => re.test(text))) continue;

        await smartClick(el);
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
          await smartClick(btn);
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
        await smartClick(waterBtn);
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
      assumed: assumeCollected,
      alreadyUi,
      justCollected,
      coins,
      streak,
      water,
      balance: balance.balance,
      balanceRaw: balance.raw
    };
  }

  /**
   * Lê o extrato desktop (página mycoin) — fonte de verdade da contabilidade.
   * Aguarda a hidratação e delega o parsing para AC.ledger (puro e testável).
   * Executa na ABA DO EXTRATO (UA desktop), não na aba mobile.
   * @returns {Promise<object>}
   */
  async function readMycoin() {
    if (!/mycoin|coin-pc-index/i.test(location.href)) {
      return { error: 'not-mycoin-page' };
    }

    // Página pedindo login (sessão inválida): não há extrato para ler.
    if (loginFormState().password && !/My coins|Minhas moedas/i.test(bodyText(4000))) {
      return { loginPrompt: true };
    }

    // Aguarda o SPA desktop hidratar (saldo ou rótulo de check-in visível no texto).
    await waitUntil(
      () => /My coins|Minhas moedas|App daily check-in|B[ôo]nus di[áa]rio/i.test(bodyText(20000)),
      { timeout: 15000, interval: 500 }
    );
    await sleep(600);

    // Varredura estrutural (badge de sequência) complementa os padrões textuais.
    const domStreak = AC.dom.readStreakFromStructure();
    return AC.ledger.readMycoinPage(bodyText(150000), new Date(), domStreak);
  }

  // ---------------------------------------------------------------------------
  // GAVETA DE TAREFAS
  // ---------------------------------------------------------------------------

  function drawerOpen() {
    const el = document.querySelector(S.tasks.drawerContainer);
    if (!el || !AC.dom.isVisible(el)) return false;
    return el.getBoundingClientRect().height > 100;
  }

  /**
   * Skeleton do SPA — conta apenas quando VISÍVEL. O nó `.login-pending-container`
   * pode permanecer oculto no DOM após o load; checar por mera presença bailava
   * a abertura do painel e as tarefas nunca eram tentadas.
   */
  function skeletonVisible() {
    const el = document.querySelector(S.login.loginPendingContainer);
    return Boolean(el && AC.dom.isVisible(el));
  }

  /** Diagnóstico curto anexado ao relatório quando a gaveta não abre. */
  function drawerDebug() {
    const buttons = Array.from(
      document.querySelectorAll('button, [role="button"], div[class*="button"], div[class*="Button"]')
    )
      .filter((el) => AC.dom.isVisible(el))
      .map((el) => (el.textContent || '').trim().replace(/\s+/g, ' '))
      .filter((t) => t && t.length <= 40)
      .slice(0, 8);
    return {
      url: location.href.slice(0, 110),
      cards: document.querySelectorAll(S.tasks.taskItem).length,
      drawerNode: Boolean(document.querySelector(S.tasks.drawerContainer)),
      buttons
    };
  }

  /** Candidatos que na verdade são o botão de check-in/coleta (não a gaveta). */
  function isCheckinCandidate(el) {
    const text = (el.textContent || '').trim();
    if (!text) return false;
    if (S.tasks.openDrawerTexts.some((re) => re.test(text))) return false;
    return S.checkin.collectButtonTexts.some((re) => re.test(text)) || /checked|coletado/i.test(text);
  }

  async function openDrawer() {
    if (captchaInfo().present) return { needsCaptcha: true };
    if (drawerOpen()) return { ok: true };

    // Aguarda o SPA estabilizar, mas sem bloquear quando a página já está
    // utilizável: a prioridade é encontrar o botão (como o verifier do ali-coins,
    // que sai do laço assim que o botão aparece, mesmo com skeleton no DOM).
    for (let wait = 0; wait < 20; wait += 1) {
      if (isStopped()) return { aborted: true };
      if (queryVisible(S.tasks.taskItem) || drawerOpen()) break;
      if (!skeletonVisible() && wait > 2) break;
      await sleep(350);
    }

    const clickedTargets = [];
    const failedTargets = new Set();

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      if (isStopped()) return { aborted: true };
      if (captchaInfo().present) return { needsCaptcha: true };
      closeModals();

      // Candidatos: TODOS os textos "Ganhe mais moedas" (mais internos primeiro)
      // — o clique anterior mirava um único alvo e o handler podia estar no
      // elemento irmão/filho. Também usa o candidato por classe como reserva.
      const candidates = findAllByText(S.tasks.openDrawerTexts, {
        tagNames: ['button', 'a', 'div', 'span'],
        maxCandidates: 6000
      }).filter((el) => !failedTargets.has(el));

      if (candidates.length === 0) {
        const classCandidate = queryVisible(S.tasks.openDrawerBtn);
        if (classCandidate && !isCheckinCandidate(classCandidate)) {
          const el = AC.dom.clickableFrom(classCandidate);
          if (!failedTargets.has(el)) candidates.push(el);
        }
      }

      if (candidates.length === 0) {
        window.scrollBy(0, 220);
        await sleep(1200);
        continue;
      }

      // Cicla pelos candidatos, mais interno primeiro. smartClick usa o clique
      // REAL por coordenadas (CDP quando disponível), como um tap do usuário.
      const target = candidates[0];
      clickedTargets.push((target.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40));
      await smartClick(target);

      const opened = await waitUntil(() => drawerOpen() || queryVisible(S.tasks.taskItem), {
        timeout: 4000,
        interval: 300
      });
      if (opened) return { ok: true };

      // Este alvo não abriu o painel: não repete o mesmo na sequência.
      failedTargets.add(target);
      await sleep(900);
    }
    return { ok: false, debug: { ...drawerDebug(), clickedTargets } };
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

  async function clickTask({ index, title }) {
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
    await smartClick(btn);
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

      await smartClick(link || target);
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
        await smartClick(opener);
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
    checkAuth,
    doLogin,
    waitCaptcha,
    wait2FA,
    doCheckin,
    readMycoin,
    readBalance: () => ({ ...readBalance(), streak: readStreak(), todayChecked: todayChecked() }),
    openDrawer,
    extractTasks,
    clickTask,
    runAction,
    coinUiPresent
  };
})();
