/**
 * Helpers de DOM para o content script.
 * Todos os utilitários são expostos em `self.AC.dom`.
 */
(function () {
  'use strict';

  const AC = (self.AC = self.AC || {});

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Elemento visível e "acionável" (com caixa, sem display:none/visibility:hidden).
   * @param {Element | null | undefined} el
   */
  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    if (!style || style.visibility === 'hidden' || style.display === 'none') return false;
    if (Number.parseFloat(style.opacity || '1') === 0) return false;
    return true;
  }

  /**
   * Primeiro elemento visível que casa com QUALQUER um dos seletores (separados por vírgula
   * ou em lista). Nunca lança para seletores inválidos.
   * @param {string | string[]} selectors
   * @returns {Element | null}
   */
  function queryVisible(selectors) {
    const list = Array.isArray(selectors) ? selectors : String(selectors || '').split(',');
    for (const raw of list) {
      const sel = raw.trim();
      if (!sel) continue;
      let found;
      try {
        found = document.querySelectorAll(sel);
      } catch {
        continue;
      }
      for (const el of found) {
        if (isVisible(el)) return el;
      }
    }
    return null;
  }

  /**
   * Aguarda até que `fn()` retorne algo truthy.
   * @param {() => any} fn
   * @param {{timeout?: number, interval?: number}} [options]
   */
  async function waitUntil(fn, { timeout = 8000, interval = 250 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      let value = null;
      try {
        value = fn();
      } catch {
        // mantém null (falha de leitura transitória)
      }
      if (value) return value;
      if (Date.now() >= deadline) return null;
      await sleep(interval);
    }
  }

  /**
   * Clique "humano": sequência de eventos de ponteiro + click().
   * Os eventos sintéticos bastam para os handlers do AliExpress (o próprio
   * ali-coins usa el.click() via evaluate como fallback em vários pontos).
   * @param {Element} el
   */
  function clickHuman(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ block: 'center', inline: 'center' });
    } catch {
      // segue
    }
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
    const seq = [
      new PointerEvent('pointerdown', { ...base, pointerId: 1, pointerType: 'touch', isPrimary: true }),
      new MouseEvent('mousedown', base),
      new PointerEvent('pointerup', { ...base, pointerId: 1, pointerType: 'touch', isPrimary: true }),
      new MouseEvent('mouseup', base)
    ];
    for (const ev of seq) {
      try {
        el.dispatchEvent(ev);
      } catch {
        // PointerEvent indisponível: ignora o evento específico.
      }
    }
    try {
      el.click();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Define o valor de um input usando o setter nativo (React/SPA-safe) + eventos.
   * @param {HTMLInputElement} input
   * @param {string} value
   */
  function setNativeValue(input, value) {
    const proto = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) {
      setter.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * Simula Enter em um input.
   * @param {HTMLElement} el
   */
  function pressEnter(el) {
    const opts = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  /** Texto do body (limitado para não pesar em páginas grandes). */
  function bodyText(limit = 40000) {
    const text = (document.body && document.body.innerText) || '';
    return text.slice(0, limit);
  }

  /**
   * Procura um elemento clicável por texto (botões/divs/a).
   * @param {RegExp[]} patterns
   * @param {{tagNames?: string[], maxCandidates?: number}} [options]
   * @returns {Element | null}
   */
  function findByText(patterns, options = {}) {
    const tags = options.tagNames || ['button', 'a', 'div', 'span'];
    const maxCandidates = options.maxCandidates || 4000;
    let candidates;
    try {
      candidates = document.querySelectorAll(tags.join(','));
    } catch {
      return null;
    }
    let checked = 0;
    for (const el of candidates) {
      checked += 1;
      if (checked > maxCandidates) break;
      const text = (el.textContent || '').trim();
      if (!text || text.length > 60) continue;
      if (patterns.some((re) => re.test(text)) && isVisible(el)) {
        return el;
      }
    }
    return null;
  }

  /**
   * Todos os elementos visíveis que casam com os padrões de texto, priorizando
   * os MAIS INTERNOS (sem descendente que também casa) — clicar num wrapper cujo
   * handler está no filho não dispara nada; com clique por coordenadas (CDP) o
   * alvo mais preciso garante que o ponto visual seja o correto.
   * @param {RegExp[]} patterns
   * @param {{tagNames?: string[], maxCandidates?: number}} [options]
   * @returns {Element[]}
   */
  function findAllByText(patterns, options = {}) {
    const tags = options.tagNames || ['button', 'a', 'div', 'span'];
    const maxCandidates = options.maxCandidates || 6000;
    let candidates;
    try {
      candidates = document.querySelectorAll(tags.join(','));
    } catch {
      return [];
    }

    const matched = [];
    let checked = 0;
    for (const el of candidates) {
      checked += 1;
      if (checked > maxCandidates) break;
      const text = (el.textContent || '').trim();
      if (!text || text.length > 60) continue;
      if (!patterns.some((re) => re.test(text))) continue;
      if (!isVisible(el)) continue;
      matched.push(el);
    }

    const matchedSet = new Set(matched);
    const innermost = matched.filter((el) => {
      try {
        for (const child of el.querySelectorAll(tags.join(','))) {
          if (matchedSet.has(child)) return false;
        }
      } catch {
        // subárvore inacessível: mantém o elemento como candidato
      }
      return true;
    });
    return innermost.length > 0 ? innermost : matched;
  }

  /**
   * Varredura ESTRUTURAL por elementos com classe/id que indiquem sequência
   * (ex.: "streak", "sequência", "sequence"). A página pode exibir o número da
   * sequência sem a palavra "dias" ao lado (badge com chama, por exemplo), o
   * que escapa dos padrões textuais. Só valores > 7 são aceitos (o calendário
   * semanal usa 1..7; maiores são a sequência real).
   * @returns {number|null}
   */
  function readStreakFromStructure() {
    let best = null;
    const selectors = [
      '[class*="streak" i]',
      '[id*="streak" i]',
      '[class*="sequ" i]',
      '[class*="sequence" i]',
      '[class*="continuous" i]',
      '[class*="daysCount" i]'
    ];
    for (const sel of selectors) {
      let els;
      try {
        els = document.querySelectorAll(sel);
      } catch {
        continue;
      }
      let count = 0;
      for (const el of els) {
        count += 1;
        if (count > 40) break;
        if (!isVisible(el)) continue;
        const text = (el.innerText || el.textContent || '').trim();
        if (!text || text.length > 40) continue;
        for (const m of text.matchAll(/([0-9]{1,6})/g)) {
          const n = Number.parseInt(m[1], 10);
          if (Number.isFinite(n) && n > 7 && (best === null || n > best)) best = n;
        }
      }
    }
    return best;
  }

  /**
   * Prioriza a fonte da sequência (streak), na ordem que reflete o site:
   *   1. número principal do calendário (`dayNumber`, total de dias);
   *   2. modal de quebra (`brokenDays`, "{0} Streak lost");
   *   3. varredura estrutural / padrões textuais com valor > 7 (sequência real,
   *      nunca o ciclo semanal 1..7);
   *   4. padrão textual simples como último recurso.
   * Função pura (testável) — a coleta dos candidatos acontece no chamador.
   * @param {{dayNumber?: (number|null), brokenDays?: (number|null), textBest?: (number|null), structural?: (number|null), textFallback?: (number|null)}} candidates
   * @returns {number|null}
   */
  function pickStreakCandidate({
    dayNumber = null,
    brokenDays = null,
    textBest = null,
    structural = null,
    textFallback = null
  } = {}) {
    if (Number.isFinite(dayNumber) && dayNumber >= 1) return dayNumber;
    if (Number.isFinite(brokenDays) && brokenDays >= 1) return brokenDays;
    if (Number.isFinite(structural) && structural > 7) return structural;
    if (Number.isFinite(textBest) && textBest > 7) return textBest;
    return Number.isFinite(textFallback) ? textFallback : null;
  }

  /**
   * Fecha modais/toasts com segurança: apenas elementos de fechar dentro de
   * containers de diálogo/overlay (como closeModals do ali-coins).
   */
  function closeModals() {
    const S = AC.selectors;
    let closed = false;
    const containers = 'dialog, [role="dialog"], [class*="modal"], [class*="dialog"], [class*="popup"], [class*="toast"], [class*="overlay"], [class*="mask"]';

    for (const sel of S.modals.closeSelectors) {
      let els;
      try {
        els = document.querySelectorAll(sel);
      } catch {
        continue;
      }
      for (const el of els) {
        if (!isVisible(el)) continue;
        if (!el.closest(containers)) continue;
        const rect = el.getBoundingClientRect();
        // Evita fechar a página inteira/gaveta: alvos pequenos apenas.
        if (rect.width > 300 && rect.height > 300) continue;
        clickHuman(el);
        closed = true;
      }
    }

    for (const el of document.querySelectorAll('button, div[role="button"], span[role="button"]')) {
      if (!isVisible(el)) continue;
      if (!el.closest(containers)) continue;
      const text = (el.textContent || '').trim();
      if (!text || text.length > 12) continue;
      if (S.modals.closeTexts.some((re) => re.test(text))) {
        clickHuman(el);
        closed = true;
      }
    }
    return closed;
  }

  /**
   * Detecta captcha/desafio de segurança.
   * @returns {{present: boolean, kind: 'slider'|'iframe'|'risk'|null}}
   */
  function captchaInfo() {
    const S = AC.selectors.captcha;
    // Ordem: slider -> containers/iframes -> texto de risco (evita falso RGV587
    // quando o texto aparece DENTRO do próprio desafio visual).
    if (queryVisible(S.sliderHandle)) {
      return { present: true, kind: 'slider' };
    }
    const container = queryVisible(S.containers);
    if (container) {
      return { present: true, kind: 'iframe' };
    }
    if (S.riskText.test(bodyText(20000))) {
      return { present: true, kind: 'risk' };
    }
    return { present: false, kind: null };
  }

  /** Parser numérico com separadores de milhar. */
  function parseNumber(raw) {
    if (raw === null || raw === undefined) return null;
    const n = Number.parseInt(String(raw).replace(/[.,]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Localiza containers internos roláveis (ex.: feed imersivo da central de
   * moedas, onde o scroll não ocorre no document.scrollingElement).
   * @returns {Element[]}
   */
  function findInnerScrollers() {
    const out = [];
    let candidates;
    try {
      candidates = document.querySelectorAll(
        '[class*="aecoin-"], [class*="feed"], [class*="scroll"], main, section'
      );
    } catch {
      return out;
    }
    let checked = 0;
    for (const el of candidates) {
      checked += 1;
      if (checked > 200) break;
      if (el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 100) {
        out.push(el);
      }
    }
    return out;
  }

  /**
   * Rola a página por `seconds` segundos (scroll incremental), com abort flag.
   * Rola tanto a janela quanto containers internos roláveis (modo imersivo).
   * Retorna false se interrompido pela flag.
   */
  async function scrollFor(seconds, isAborted) {
    const end = Date.now() + Math.max(1, seconds) * 1000;
    const scroller = document.scrollingElement || document.documentElement;
    const innerScrollers = findInnerScrollers();
    while (Date.now() < end) {
      if (isAborted && isAborted()) return false;
      const step = 250 + Math.floor(Math.random() * 450);
      try {
        window.scrollBy(0, step);
        if (scroller && scroller !== document.scrollingElement) scroller.scrollTop += step;
        for (const inner of innerScrollers) {
          inner.scrollTop += step;
        }
      } catch {
        // segue
      }
      await sleep(900 + Math.floor(Math.random() * 500));
    }
    return true;
  }

  /**
   * Sobe na árvore até um elemento realmente clicável (button/a/[role=button]
   * ou div/span com classe de botão). Evita clicar no texto interno (span) de um
   * botão que só ouve eventos no container.
   * @param {Element} el
   * @param {number} [maxLevels=4]
   * @returns {Element}
   */
  function clickableFrom(el, maxLevels = 4) {
    let node = el;
    for (let i = 0; node && i < maxLevels; i += 1) {
      try {
        if (
          node.matches &&
          node.matches('button, a, [role="button"], input[type="button"], input[type="submit"]')
        ) {
          return node;
        }
        const cls = typeof node.className === 'string' ? node.className : '';
        if (/button|btn/i.test(cls)) return node;
      } catch {
        // segue para o pai
      }
      node = node.parentElement;
    }
    return el;
  }

  AC.dom = {
    sleep,
    isVisible,
    queryVisible,
    waitUntil,
    clickHuman,
    clickableFrom,
    setNativeValue,
    pressEnter,
    bodyText,
    findByText,
    findAllByText,
    readStreakFromStructure,
    pickStreakCandidate,
    closeModals,
    captchaInfo,
    parseNumber,
    scrollFor
  };
})();
