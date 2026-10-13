/**
 * Leitura e parsing do extrato desktop de moedas (página mycoin).
 *
 * Port fiel de libs/ui/balance.js do ali-coins:
 *  - saldo total bilíngue ("My coins"/"Minhas moedas") com separador de milhar;
 *  - seção de HOJE do extrato pelo fuso America/Los_Angeles (o "dia" contábil do
 *    AliExpress vira à meia-noite do Pacífico), em pt-BR (DD/MM/AAAA PT) ou
 *    en-US (M/D/YYYY PT), com fallback que varre todas as datas do documento;
 *  - lançamentos "<rótulo>\n+<valor>": rótulos de check-in
 *    (App daily check-in|Check-in diário no app|Bônus diário|Daily bonus) somam
 *    em `bonusCoins`; todo o restante é contabilizado como missões/tarefas;
 *  - sequência (streak) pelo histórico de datas + rótulo de check-in.
 *
 * UMD: carregado como script clássico no content script e avaliado como CJS nos
 * testes (mesmos fixtures do projeto original).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    const AC = (root.AC = root.AC || {});
    Object.assign(AC, { ledger: api });
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Rótulos de CHECK-IN no extrato desktop, bilíngues. Todo o RESTANTE dos créditos
  // do dia (Coin page task, Widget coins, Missões de moedas, ...) conta como tarefas.
  const CHECKIN_LABEL_PATTERN =
    '(?:App daily check-in|Check-in di[áa]rio no app|B[ôo]nus di[áa]rio|Daily bonus)';

  /** Padrões multilíngues (pt, en, es) de sequência (streak). */
  const STREAK_PATTERNS = [
    /se[cq]u[eê]ncia(?:\s*de|:)?\s*([0-9]+)\s*d[ií]as?/i,
    /([0-9]+)\s*d[ií]as?\s*(?:de\s*se[cq]u[eê]ncia|seguidos?|consecutivos?)/i,
    /([0-9]+)\s*-?\s*(?:day|dia|dias|days|días)?\s*-?\s*streak/i,
    /streak(?:\s*de|:)?\s*([0-9]+)/i,
    /([0-9]+)\s*(?:days?|dias?|días?)\s*(?:in\s*a\s*row|consecutivos?)/i,
    /check-?in(?:\s*(?:de|por|di[aá]rio:?))?\s*([0-9]+)\s*d[ií]as?/i,
    /([0-9]+)\s*d[ií]as?\s*de\s*check-?in/i,
    /completou\s*([0-9]+)\s*d[ií]as?/i,
    /coletou\s*por\s*([0-9]+)\s*d[ií]as?/i
  ];

  /**
   * Converte "1.234"/"1,234" em 1234.
   * @param {string|number|null|undefined} raw
   * @returns {number|null}
   */
  function parseBalanceNumber(raw) {
    if (raw === null || raw === undefined) return null;
    const n = parseInt(String(raw).replace(/[.,]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Saldo total bilíngue com separador de milhar.
   * @param {string} text
   * @returns {number|null}
   */
  function parseBalance(text) {
    const t = typeof text === 'string' ? text : '';
    const m =
      t.match(/(?:My coins|Minhas moedas)\s*\n\s*([0-9][0-9.,]*)/i) ||
      t.match(/([0-9][0-9.,]*)\s*\n\s*saves/i);
    return m ? parseBalanceNumber(m[1]) : null;
  }

  /**
   * Extrai o número de dias de sequência de um texto qualquer (multilíngue).
   * O calendário semanal do AliExpress exibe valores do ciclo (1..7); valores
   * maiores que 7 são a sequência REAL e têm prioridade sobre eles (o valor do
   * ciclo só é usado quando não há nenhum > 7 no texto).
   * @param {string} text
   * @returns {number|null}
   */
  function streakFromText(text) {
    if (!text || typeof text !== 'string') return null;
    let fallback = null;
    let best = null;
    for (const regex of STREAK_PATTERNS) {
      const global = new RegExp(
        regex.source,
        regex.flags.includes('g') ? regex.flags : `${regex.flags}g`
      );
      for (const m of text.matchAll(global)) {
        const val = parseInt(m[1], 10);
        if (!Number.isFinite(val) || val < 1) continue;
        if (fallback === null) fallback = val;
        if (val > 7 && (best === null || val > best)) best = val;
      }
    }
    return best !== null ? best : fallback;
  }

  /**
   * Seção de HOJE do extrato, no fuso do Pacífico. Suporta pt-BR ("DD/MM/AAAA PT")
   * e en-US ("M/D/YYYY PT"); fallback varre todas as datas e compara com hoje.
   * @param {string} text
   * @param {Date} [now]
   * @returns {string} trecho do extrato do dia (vazio quando não encontrado)
   */
  function todaySection(text, now = new Date()) {
    const t = typeof text === 'string' ? text : '';
    const ptDateBr = now.toLocaleDateString('pt-BR', { timeZone: 'America/Los_Angeles' }) + ' PT';
    const ptDateUs = now.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' }) + ' PT';

    let todaySec = '';
    if (t.includes(ptDateBr)) {
      todaySec = t.split(ptDateBr)[1]?.split(/[0-9]+\/[0-9]+\/[0-9]+ PT/)[0] || '';
    } else if (t.includes(ptDateUs)) {
      todaySec = t.split(ptDateUs)[1]?.split(/[0-9]+\/[0-9]+\/[0-9]+ PT/)[0] || '';
    } else {
      // Fallback: a PRIMEIRA data do documento NÃO é necessariamente hoje — compara
      // cada data encontrada com hoje (nas duas grafias, tolerando zero à esquerda).
      const allDates = [...t.matchAll(/([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4})\s*PT/gi)];
      const normalizeDate = (raw) => {
        const [d, mo, y] = String(raw).replace(/\s*PT$/i, '').trim().split('/');
        return `${String(parseInt(d, 10)).padStart(2, '0')}/${String(parseInt(mo, 10)).padStart(2, '0')}/${y}`;
      };
      const todayNormalized = normalizeDate(ptDateBr);
      const todayEntry = allDates.find((entry) => normalizeDate(entry[1]) === todayNormalized);
      if (todayEntry) {
        todaySec = t.split(todayEntry[0])[1]?.split(/[0-9]+\/[0-9]+\/[0-9]+ PT/)[0] || '';
      }
    }
    return todaySec;
  }

  /**
   * Soma o extrato do dia: check-in ("Bônus diário") vs missões/tarefas.
   * Cada lançamento é "<rótulo>\n+<valor>"; aceita separador de milhar.
   * @param {string} todaySec
   * @returns {{bonusCoins: number|null, missionsCoins: number, bonusCount: number, missionsCount: number}}
   */
  function extractTodayLedger(todaySec) {
    const text = typeof todaySec === 'string' ? todaySec : '';
    let bonusCoins = null;
    let bonusCount = 0;
    let missionsCoins = 0;
    let missionsCount = 0;

    const entryRe = /([^\n+][^\n]*)\n\s*\+([0-9][0-9.,]*)/g;
    for (const m of text.matchAll(entryRe)) {
      const label = (m[1] || '').trim();
      const value = parseInt(String(m[2]).replace(/[.,]/g, ''), 10);
      if (!label || Number.isNaN(value)) continue;

      if (new RegExp(CHECKIN_LABEL_PATTERN, 'i').test(label)) {
        bonusCount += 1;
        bonusCoins = (bonusCoins || 0) + value;
      } else {
        missionsCount += 1;
        missionsCoins += value;
      }
    }
    return { bonusCoins, missionsCoins, bonusCount, missionsCount };
  }

  /**
   * Indica se a seção do dia contém algum rótulo de check-in (novo ou legado).
   * @param {string} todaySec
   */
  function hasCheckinLabel(todaySec) {
    return new RegExp(CHECKIN_LABEL_PATTERN, 'i').test(typeof todaySec === 'string' ? todaySec : '');
  }

  /**
   * Sequência atual a partir do histórico do extrato: processa por BLOCO de data
   * (o segmento entre a data e o rótulo nunca cruza outra data), exige registro
   * mais recente hoje/ontem (fuso PT) e conta dias consecutivos.
   * @param {string} text
   * @param {Date} [now]
   * @returns {number|null}
   */
  function streakFromHistory(text, now = new Date()) {
    if (!text || typeof text !== 'string') return null;

    const blockRe = /([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{4})\s*PT/g;
    const blocks = [];
    let m;
    while ((m = blockRe.exec(text)) !== null) {
      blocks.push({ day: m[1], month: m[2], year: m[3], start: blockRe.lastIndex });
    }

    const rawMatches = [];
    for (let i = 0; i < blocks.length; i += 1) {
      const b = blocks[i];
      const end = i + 1 < blocks.length ? blocks[i + 1].start : text.length;
      const section = text.slice(b.start, end);
      const labelRe = new RegExp(`${CHECKIN_LABEL_PATTERN}\\s*\\n\\s*\\+([0-9]+)`, 'i');
      const lm = section.match(labelRe);
      if (lm) rawMatches.push([null, b.day, b.month, b.year, lm[1]]);
    }
    if (rawMatches.length === 0) return null;

    // Detecção do formato de data: >12 em alguma posição decide; senão, sinais de locale.
    let hasP1GreaterThan12 = false;
    let hasP2GreaterThan12 = false;
    for (const match of rawMatches) {
      const p1 = parseInt(match[1], 10);
      const p2 = parseInt(match[2], 10);
      if (p1 > 12) hasP1GreaterThan12 = true;
      if (p2 > 12) hasP2GreaterThan12 = true;
    }

    let isUsFormat;
    if (hasP2GreaterThan12) {
      isUsFormat = true;
    } else if (hasP1GreaterThan12) {
      isUsFormat = false;
    } else {
      const ptDateUs = now.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' }) + ' PT';
      const hasPtHeader = /Minhas moedas|B[ôo]nus di[áa]rio|Miss[õo]es de moedas/i.test(text);
      const hasEnHeader = /My coins/i.test(text);
      if (hasPtHeader && !hasEnHeader) {
        isUsFormat = false;
      } else if (hasEnHeader && !hasPtHeader) {
        isUsFormat = true;
      } else {
        isUsFormat = text.includes(ptDateUs);
      }
    }

    const entries = [];
    for (const match of rawMatches) {
      const p1 = parseInt(match[1], 10);
      const p2 = parseInt(match[2], 10);
      const year = parseInt(match[3], 10);
      const coins = parseInt(match[4], 10);
      const day = isUsFormat ? p2 : p1;
      const month = isUsFormat ? p1 : p2;
      entries.push({ dateUtc: Date.UTC(year, month - 1, day), coins });
    }

    const uniqueDays = [];
    const seen = new Set();
    for (const entry of entries) {
      const dayKey = Math.round(entry.dateUtc / 86400000);
      if (!seen.has(dayKey)) {
        seen.add(dayKey);
        uniqueDays.push({ dayKey, coins: entry.coins });
      }
    }
    uniqueDays.sort((a, b) => b.dayKey - a.dayKey);

    // O registro mais recente precisa ser de hoje ou ontem (fuso do histórico),
    // senão uma sequência antiga seria reportada como streak atual.
    const todayParts = now
      .toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
      .split('-')
      .map(Number);
    const todayKey = Math.round(Date.UTC(todayParts[0], todayParts[1] - 1, todayParts[2]) / 86400000);
    if (uniqueDays[0].dayKey < todayKey - 1) return null;

    let streak = 1;
    for (let i = 1; i < uniqueDays.length; i += 1) {
      if (uniqueDays[i].dayKey === uniqueDays[i - 1].dayKey - 1) {
        streak += 1;
      } else {
        break;
      }
    }
    return streak;
  }

  /**
   * Composição usada pelo content script na página mycoin.
   * @param {string} text texto do body da página
   * @param {Date} [now]
   * @param {number|null} [domStreak] sequência lida por varredura estrutural
   *   (elementos com classe de "streak"), quando disponível
   */
  function readMycoinPage(text, now = new Date(), domStreak = null) {
    const t = typeof text === 'string' ? text : '';
    const today = todaySection(t, now);
    const ledger = extractTodayLedger(today);
    const hasBonusToday = ledger.bonusCoins !== null;

    return {
      totalBalance: parseBalance(t),
      hasCheckinToday: hasBonusToday || hasCheckinLabel(today),
      todayBonusCoins: ledger.bonusCoins,
      todayMissionsCoins: ledger.missionsCoins,
      todayMissionsCount: ledger.missionsCount,
      textStreak: streakFromText(t),
      historyStreak: streakFromHistory(t, now),
      domStreak: Number.isFinite(domStreak) && domStreak > 7 ? domStreak : null,
      textLength: t.length
    };
  }

  return {
    CHECKIN_LABEL_PATTERN,
    parseBalanceNumber,
    parseBalance,
    streakFromText,
    todaySection,
    extractTodayLedger,
    hasCheckinLabel,
    streakFromHistory,
    readMycoinPage
  };
});
