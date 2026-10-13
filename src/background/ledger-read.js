/**
 * Leitura do extrato desktop (página mycoin) na aba do extrato — best-effort.
 * Espelha o getBalanceDesktop do ali-coins: navega SEMPRE para a página mycoin
 * e extrai saldo + extrato do dia + streak. Falhas não derrubam o run.
 */

import { CMD, MYCOIN_URL } from '../common/constants.js';
import { appendLog, sendCmd } from './context.js';
import { ensureLedgerTab, navigateTab } from './tabs.js';

/**
 * @param {object} ctx
 * @param {string} label rótulo para o log ("leitura inicial", "pós check-in"...)
 * @returns {Promise<object|null>}
 */
export async function readLedger(ctx, label) {
  try {
    const ledgerTabId = await ensureLedgerTab(ctx.windowId);
    ctx.ledgerTabId = ledgerTabId;
    await navigateTab(ledgerTabId, MYCOIN_URL, 45000);

    const res = await sendCmd(ctx, ledgerTabId, CMD.READ_MYCOIN, {}, { retries: 4 });
    if (!res || res.error || res.loginPrompt) {
      const reason = res && res.loginPrompt ? 'página pediu login' : (res && res.error) || 'sem resposta';
      await appendLog(ctx, `Extrato indisponível (${label}): ${reason}.`);
      return null;
    }

    const bits = [`saldo ${res.totalBalance ?? 'N/D'}`];
    if (Number.isFinite(res.todayMissionsCoins)) bits.push(`missões de hoje +${res.todayMissionsCoins}`);
    if (res.hasCheckinToday) bits.push('check-in de hoje creditado no extrato');
    await appendLog(ctx, `Extrato (${label}): ${bits.join(', ')}.`);
    return res;
  } catch (err) {
    await appendLog(ctx, `Falha ao ler o extrato (${label}): ${err.message}.`);
    return null;
  }
}
