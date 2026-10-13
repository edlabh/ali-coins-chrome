/**
 * Classificação de tarefas do painel "Ganhe mais moedas".
 * UMD: carregado como script clássico no content script e avaliado como CJS nos testes.
 * Espelha a ordem de decisão do libs/tasks/dispatcher.js do ali-coins.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    const AC = (root.AC = root.AC || {});
    Object.assign(AC, api);
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Classifica uma tarefa pelo título/descrição.
   * @returns {'surprise'|'search'|'prize-land'|'app-only'|'scroll'}
   */
  function classifyTask(title, desc) {
    const t = String(title || '').toLowerCase();
    const d = String(desc || '').toLowerCase();

    if (
      t.includes('surprise') ||
      t.includes('surpresa') ||
      t.includes('tap 3') ||
      t.includes('toque em 3') ||
      t.includes('toque 3') ||
      d.includes('tap 3') ||
      d.includes('toque em 3') ||
      d.includes('toque 3')
    ) {
      return 'surprise';
    }

    if (
      t.includes('search') ||
      t.includes('pesquisa') ||
      t.includes('pesquisar') ||
      t.includes('buscar') ||
      t.includes('busca') ||
      d.includes('keywords') ||
      d.includes('palavra')
    ) {
      return 'search';
    }

    if (
      t.includes('prize land') ||
      d.includes('prize land') ||
      d.includes('water') ||
      d.includes('regar') ||
      t.includes('0.1')
    ) {
      return 'prize-land';
    }

    if (
      t.includes('merge boss') ||
      t.includes('game') ||
      t.includes('jogo') ||
      t.includes('quiz')
    ) {
      return 'app-only';
    }

    if (t.includes('review') || t.includes('avalia') || d.includes('review') || d.includes('avalia')) {
      return 'app-only';
    }

    return 'scroll';
  }

  /**
   * Tempo de permanência/scroll por tipo de tarefa.
   * Super descontos exigem >= 16s (como o dispatcher do ali-coins).
   */
  function scrollSecondsForTask(title, desc, baseSeconds) {
    const base = Number.isFinite(baseSeconds) && baseSeconds > 0 ? baseSeconds : 10;
    const t = String(title || '').toLowerCase();
    const d = String(desc || '').toLowerCase();
    const isDiscount =
      t.includes('desconto') ||
      t.includes('discount') ||
      t.includes('superdeal') ||
      t.includes('super deal') ||
      t.includes('15s') ||
      d.includes('15s') ||
      d.includes('15 s');
    return isDiscount ? Math.max(16, base) : base;
  }

  return { classifyTask, scrollSecondsForTask };
});
