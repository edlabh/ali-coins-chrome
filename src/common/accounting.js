/**
 * Contabilidade de moedas — port fiel do ali-coins:
 *  - libs/ui/balance.js: tiers do check-in (dia 1=+10 ... dia 7+=+40);
 *  - libs/report.js: computeCheckinCoinsGained, computeTasksCoinsGained,
 *    isStreakBreak, resolveStreakDays;
 *  - collect.js: prioridade do valor real do extrato sobre o modal/estimativa e
 *    sincronização do saldo quando o crédito do check-in ainda não apareceu.
 *
 * Funções puras e testáveis (node --test).
 */

/**
 * Moedas esperadas do check-in para um dia da sequência (getCheckinCoinsFromStreak).
 * @param {string|number|null|undefined} streak
 * @returns {number}
 */
export function coinsFromStreak(streak) {
  if (streak === null || streak === undefined || streak === 'N/D') return 10;
  const num =
    typeof streak === 'number' ? streak : parseInt(String(streak).replace(/[^0-9]/g, ''), 10);
  if (Number.isNaN(num) || num <= 1) return 10;
  switch (num) {
    case 2:
      return 15;
    case 3:
      return 20;
    case 4:
      return 25;
    case 5:
      return 30;
    case 6:
      return 35;
    default:
      return 40;
  }
}

/**
 * Dia da sequência correspondente a um valor de check-in (getStreakFromCheckinCoins).
 * @param {string|number|null|undefined} coins
 * @returns {number|null}
 */
export function streakFromCoins(coins) {
  if (coins === null || coins === undefined) return null;
  const num =
    typeof coins === 'number' ? coins : parseInt(String(coins).replace(/[^0-9]/g, ''), 10);
  if (Number.isNaN(num)) return null;
  switch (num) {
    case 10:
      return 1;
    case 15:
      return 2;
    case 20:
      return 3;
    case 25:
      return 4;
    case 30:
      return 5;
    case 35:
      return 6;
    case 40:
      return 7;
    default:
      return null;
  }
}

/**
 * Prioridade do valor do check-in (espelha collect.js):
 * extrato desktop (valor REAL) > modal mobile > estimativa pela sequência.
 * A estimativa só é usada quando o check-in foi coletado nesta execução ou confirmado.
 * @param {{mobileCoins?: (number|null), ledgerBonus?: (number|null), streak?: (number|string|null), collected?: boolean}} params
 * @returns {{coins: number|null, source: 'desktop-bonus'|'mobile-modal'|'streak-estimate'|null}}
 */
export function resolveCheckinCoins({
  mobileCoins = null,
  ledgerBonus = null,
  streak = null,
  collected = false
} = {}) {
  const asPositive = (v) => {
    if (v === null || v === undefined) return null;
    const n = typeof v === 'number' ? v : parseInt(String(v).replace(/[^0-9]/g, ''), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const fromLedger = asPositive(ledgerBonus);
  if (fromLedger !== null) return { coins: fromLedger, source: 'desktop-bonus' };

  const fromMobile = asPositive(mobileCoins);
  if (fromMobile !== null) return { coins: fromMobile, source: 'mobile-modal' };

  if (collected && streak !== null && streak !== undefined && streak !== 'N/D') {
    const estimate = coinsFromStreak(streak);
    if (Number.isFinite(estimate) && estimate > 0) {
      return { coins: estimate, source: 'streak-estimate' };
    }
  }
  return { coins: null, source: null };
}

/**
 * Moedas do check-in para o relatório (computeCheckinCoinsGained do ali-coins).
 * O crédito do extrato conta MESMO quando o check-in já constava coletado (ex.:
 * feito pelo usuário no app). Valor explícito ("0") não cai no fallback por streak.
 * @param {object|null} checkin espera campos já consolidados do check-in
 * @returns {number}
 */
export function computeCheckinCoinsGained(checkin) {
  if (!checkin) return 0;

  if (checkin.checkinCoinsFromLedger === true) {
    const fromLedger = parseInt(String(checkin.coinsGainedToday ?? '').replace(/[^0-9]/g, ''), 10);
    if (!Number.isNaN(fromLedger) && fromLedger > 0) return fromLedger;
  }

  if (checkin.alreadyCollected !== false) {
    return 0;
  }

  const rawGained = checkin.coinsGainedToday;
  const hasExplicitGained =
    rawGained !== undefined &&
    rawGained !== null &&
    String(rawGained).trim() !== '' &&
    rawGained !== 'N/D';
  if (hasExplicitGained) {
    const parsed = parseInt(String(rawGained).replace(/[^0-9]/g, ''), 10);
    return !Number.isNaN(parsed) && parsed > 0 ? parsed : 0;
  }

  if (checkin.streakDays && checkin.streakDays !== 'N/D') {
    const fromStreak = coinsFromStreak(checkin.streakDays);
    if (Number.isFinite(fromStreak) && fromStreak > 0) return fromStreak;
  }
  return 0;
}

/**
 * Moedas ganhas nas tarefas (computeTasksCoinsGained do ali-coins).
 * `coinsFromLedger` (soma das "Missões de moedas") já vem isolada do check-in.
 * Compatibilidade legada: quando o saldo inicial foi capturado ANTES do crédito
 * do check-in (initBal === checkinBal - checkinCoins), desconta o check-in.
 * @param {{coinsGained?: number|null, initialBalance?: (number|string|null), coinsFromLedger?: boolean}} tasks
 * @param {object|null} checkin
 * @returns {number}
 */
export function computeTasksCoinsGained(tasks, checkin = null) {
  if (!tasks || typeof tasks.coinsGained !== 'number' || !Number.isFinite(tasks.coinsGained)) {
    return 0;
  }
  const rawCoins = tasks.coinsGained;

  if (tasks.coinsFromLedger === true) return rawCoins;
  if (!checkin) return rawCoins;

  const checkinCoins = computeCheckinCoinsGained(checkin);
  if (checkinCoins <= 0) return rawCoins;

  const initBal = parseInt(String(tasks.initialBalance ?? '').replace(/\D/g, ''), 10);
  const checkinBal = parseInt(String(checkin.totalBalance ?? '').replace(/\D/g, ''), 10);

  if (!Number.isNaN(initBal) && !Number.isNaN(checkinBal) && initBal === checkinBal - checkinCoins) {
    return Math.max(0, rawCoins - checkinCoins);
  }
  if (checkin.balanceBeforeCheckin === true) {
    return Math.max(0, rawCoins - checkinCoins);
  }
  return rawCoins;
}

/**
 * Detecção de sequência quebrada (isStreakBreak do ali-coins).
 * Leituras intermediárias (ex.: 7 quando antes era 212) são do ciclo semanal do
 * AliExpress e nunca contam como quebra real.
 * @param {number|null} currentStreak
 * @param {number|null} previousStreak
 * @param {boolean} [alreadyCollected]
 * @returns {boolean}
 */
export function isStreakBreak(currentStreak, previousStreak, alreadyCollected = false) {
  if (typeof currentStreak !== 'number' || Number.isNaN(currentStreak)) return false;
  if (typeof previousStreak !== 'number' || Number.isNaN(previousStreak)) return false;
  if (previousStreak <= 1) return false;
  if (alreadyCollected) return false;
  if (currentStreak > 1 && currentStreak < previousStreak) return false;
  if (currentStreak === 1 && previousStreak > 1) return true;
  return false;
}

/**
 * Resolve o streak final do check-in (resolveStreakDays do ali-coins):
 * incremento determinístico quando coletado hoje, preservação em re-execução,
 * proteção contra ciclo semanal e confirmação pelo extrato.
 * @param {object} params
 * @returns {{streakDays: (number|string), baseStreak: (number|null)}}
 */
export function resolveStreakDays({
  detectedStreak,
  previousStreakDays,
  earlyDesktopStreak = null,
  justCollected = false,
  alreadyCollected = false,
  confirmedByLedger = false,
  statementStreak = null
}) {
  const numericCandidates = [previousStreakDays, earlyDesktopStreak].filter(
    (v) => typeof v === 'number' && v > 0
  );
  const baseStreak = numericCandidates.length > 0 ? Math.max(...numericCandidates) : null;

  const parsedDetected =
    typeof detectedStreak === 'number'
      ? detectedStreak
      : parseInt(String(detectedStreak).replace(/[^0-9]/g, ''), 10);
  const parsedStatement =
    typeof statementStreak === 'number'
      ? statementStreak
      : parseInt(String(statementStreak).replace(/[^0-9]/g, ''), 10);

  let streakDays =
    detectedStreak !== null && detectedStreak !== undefined ? detectedStreak : 'N/D';

  if (typeof baseStreak === 'number' && baseStreak > 0) {
    const isSpuriousWeeklyCycle =
      !Number.isNaN(parsedDetected) && baseStreak > 7 && parsedDetected <= 7 && parsedDetected > 1;

    if (justCollected || confirmedByLedger) {
      if (
        detectedStreak === null ||
        detectedStreak === undefined ||
        Number.isNaN(parsedDetected) ||
        isSpuriousWeeklyCycle ||
        parsedDetected <= baseStreak
      ) {
        streakDays = baseStreak + 1;
      } else {
        streakDays = parsedDetected;
      }
    } else if (alreadyCollected) {
      if (
        detectedStreak === null ||
        detectedStreak === undefined ||
        Number.isNaN(parsedDetected) ||
        isSpuriousWeeklyCycle ||
        parsedDetected < baseStreak
      ) {
        streakDays = baseStreak;
      } else {
        streakDays = parsedDetected;
      }
    } else if (
      parsedDetected === 1 &&
      baseStreak > 1 &&
      !Number.isNaN(parsedStatement) &&
      parsedStatement > 1
    ) {
      streakDays = parsedStatement;
    } else {
      streakDays = !Number.isNaN(parsedDetected) ? parsedDetected : baseStreak;
    }
  } else if (justCollected || confirmedByLedger) {
    streakDays = !Number.isNaN(parsedDetected) && parsedDetected >= 1 ? parsedDetected : 1;
  }

  return { streakDays, baseStreak };
}

/**
 * Deriva o streak "desktop" de uma leitura do extrato:
 * leitura textual explícita > histórico de datas > tier das moedas do dia.
 * @param {object|null} ledger
 * @returns {number|null}
 */
export function desktopStreakOf(ledger) {
  if (!ledger) return null;
  if (Number.isFinite(ledger.textStreak)) return ledger.textStreak;
  const history = Number.isFinite(ledger.historyStreak) ? ledger.historyStreak : 0;
  const tier = streakFromCoins(ledger.todayBonusCoins) || 0;
  const max = Math.max(history, tier);
  return max > 0 ? max : null;
}

/**
 * Sincroniza o saldo com o crédito do check-in quando o extrato está defasado
 * (collect.js: "Saldo pós-checkin sincronizado com as moedas recebidas").
 * @param {{balance: (number|null), earlyBalance?: (number|null), checkinCoins: (number|null), justCollected?: boolean}} params
 * @returns {{balance: (number|null), adjusted: boolean}}
 */
export function syncBalanceWithCheckin({
  balance,
  earlyBalance = null,
  checkinCoins,
  justCollected = false
}) {
  if (!justCollected) return { balance, adjusted: false };
  if (!Number.isFinite(checkinCoins) || checkinCoins <= 0) return { balance, adjusted: false };
  if (!Number.isFinite(balance)) return { balance, adjusted: false };

  const earlyNum = Number.isFinite(earlyBalance) ? earlyBalance : null;
  const alreadyCredited = earlyNum !== null && balance >= earlyNum + checkinCoins;
  if (alreadyCredited) return { balance, adjusted: false };

  const base = earlyNum !== null ? earlyNum : balance;
  return { balance: base + checkinCoins, adjusted: true };
}

/**
 * Consolida a contabilidade do check-in a partir das leituras mobile + extrato,
 * espelhando a ordem e as proteções do collect.js.
 *
 * @param {object} params
 * @param {{already?: boolean, justCollected?: boolean, coins?: (number|null), streak?: (number|null), balance?: (number|null)}} params.mobileCheckin
 * @param {object|null} params.earlyLedger leitura do extrato ANTES do check-in
 * @param {object|null} params.postLedger leitura do extrato APÓS o check-in
 * @param {number|null} params.previousStreakDays streak consolidado do run anterior
 * @param {boolean} params.assumeCollected extrato já indicava check-in de hoje
 * @returns {object}
 */
export function accountCheckin({
  mobileCheckin = {},
  earlyLedger = null,
  postLedger = null,
  previousStreakDays = null,
  assumeCollected = false
} = {}) {
  const justCollected = Boolean(mobileCheckin.justCollected);
  const uiAlready = Boolean(mobileCheckin.already) || assumeCollected;
  const alreadyCollected = uiAlready && !justCollected;
  const confirmedByLedger =
    !uiAlready && !justCollected && postLedger?.hasCheckinToday === true;

  const ledgerBonus = postLedger?.todayBonusCoins ?? earlyLedger?.todayBonusCoins ?? null;
  const hasBonusFromLedger = Number.isFinite(ledgerBonus) && ledgerBonus > 0;
  const earlyStreak = desktopStreakOf(earlyLedger);
  const postStreak = desktopStreakOf(postLedger);

  const resolved = resolveCheckinCoins({
    mobileCoins: mobileCheckin.coins ?? null,
    ledgerBonus: hasBonusFromLedger ? ledgerBonus : null,
    streak: mobileCheckin.streak ?? postStreak ?? earlyStreak ?? previousStreakDays,
    collected: justCollected || alreadyCollected || confirmedByLedger
  });

  // coinsGainedToday (espelha collect.js): crédito do extrato > 0 quando já coletado.
  let coinsGainedToday = 0;
  if (hasBonusFromLedger) {
    coinsGainedToday = ledgerBonus;
  } else if (alreadyCollected) {
    coinsGainedToday = 0;
  } else if (resolved.coins !== null) {
    coinsGainedToday = resolved.coins;
  } else if (justCollected || confirmedByLedger) {
    coinsGainedToday = coinsFromStreak(mobileCheckin.streak ?? previousStreakDays ?? null);
  }

  const { streakDays } = resolveStreakDays({
    detectedStreak: mobileCheckin.streak ?? null,
    previousStreakDays,
    earlyDesktopStreak: earlyStreak,
    justCollected,
    alreadyCollected,
    confirmedByLedger,
    statementStreak: postStreak
  });

  const rawBalance = postLedger?.totalBalance ?? mobileCheckin.balance ?? null;
  const synced = syncBalanceWithCheckin({
    balance: rawBalance,
    earlyBalance: earlyLedger?.totalBalance ?? null,
    checkinCoins: resolved.coins ?? (justCollected ? coinsGainedToday : null),
    justCollected
  });

  const numericStreak = typeof streakDays === 'number' ? streakDays : null;
  const streakBroken = isStreakBreak(numericStreak, previousStreakDays, alreadyCollected);

  return {
    alreadyCollected,
    justCollected,
    confirmedByLedger,
    coins: resolved.coins,
    coinsSource: resolved.source,
    coinsGainedToday,
    checkinCoinsFromLedger: hasBonusFromLedger,
    streakDays,
    streakBroken,
    statementStreak: postStreak ?? earlyStreak,
    balanceAfterCheckin: synced.balance,
    balanceAdjusted: synced.adjusted,
    missionsCoins: postLedger?.todayMissionsCoins ?? earlyLedger?.todayMissionsCoins ?? null,
    missionsCount: postLedger?.todayMissionsCount ?? earlyLedger?.todayMissionsCount ?? null
  };
}
