/**
 * Seletores do AliExpress — espelho do libs/selectors.js do ali-coins,
 * com fallbacks adicionais para variações de layout (msite e páginas de tarefa).
 * Exposto em `self.AC.selectors`.
 */
(function () {
  'use strict';

  const AC = (self.AC = self.AC || {});

  AC.selectors = {
    login: {
      usernameInput:
        '#fm-login-id, input[name="loginId"], input.cosmos-input[type="email"], input.cosmos-input[type="text"], input[type="email"][name*="login" i], input[placeholder*="email" i], input[placeholder*="phone" i], input[placeholder*="e-mail" i]',
      passwordInput: 'input[type="password"], #fm-login-password',
      twoFactorInput:
        '#fm-login-code, input[name="checkCode"], input[autocomplete="one-time-code"], input[placeholder*="verification code" i], input[placeholder*="código" i][maxlength="6"], input.check-code-input[type="tel"][maxlength="6"]',
      loginPendingContainer: '.login-pending-container'
    },

    captcha: {
      sliderHandle: '#nc_1_n1z, .btn_slide, span[class*="btn_slide"], #nc_1__scale_text .btn_slide, div[id*="nocaptcha"] .btn_slide',
      containers:
        '#baxia-dialog-content, div[id*="nocaptcha"], .nc-container, #nc_1__scale_text, iframe[src*="punish"], iframe[src*="captcha"]',
      riskText:
        /RGV587|FAIL_SYS_USER_VALIDATE|FAIL_SYS_TRAFFIC_LIMIT|FAIL_SYS_ILLEGAL_ACCESS|traffic limit|atividade suspeita|suspicious activity|访问过于频繁/i
    },

    checkin: {
      collectButtonList: [
        'button#signButton',
        '#signButton',
        '[class*="aecoin-today"]',
        '[class*="rewardItem"]',
        '[class*="aecoin-rewardItem"]',
        '.signButton',
        'div[class*="aecoin-signButton"]',
        'div[class*="aecoin-button"]'
      ],
      collectButtonTexts: [/^Collect$/i, /^Coletar$/i, /^Get$/i, /^Receber$/i, /^Check\s?in$/i, /^Fazer check-?in$/i],
      todayChecked: '[class*="today-checked"], [class*="aecoin-today-checked"]',
      todayTextPattern: /Today[\s\S]{0,15}✓/i,
      waterBtn: '[class*="waterCollected"], button[class*="water"], [aria-label*="water" i], [aria-label*="regar" i]'
    },

    coin: {
      balancePatterns: [
        /(?:My coins|Minhas moedas)\s*[:：]?\s*([0-9][0-9.,]*)/i,
        /([0-9][0-9.,]*)\s*(?:coins|moedas)\b/i
      ],
      streakPatterns: [
        /sequ[eê]ncia(?:\s*de|:)?\s*([0-9]+)\s*dias?/i,
        /([0-9]+)\s*dias?\s*(?:de\s*sequ[eê]ncia|seguidos?|consecutivos?)/i,
        /([0-9]+)\s*-?\s*(?:day|dia|dias|days)?\s*-?\s*streak/i,
        /streak(?:\s*de|:)?\s*([0-9]+)/i,
        /([0-9]+)\s*(?:days?|dias?)\s*(?:in\s*a\s*row|consecutivos?)/i
      ]
    },

    tasks: {
      drawerContainer: '.e2e_task',
      taskItem: '.e2e_normal_task',
      taskTitle: '.e2e_normal_task_content_title',
      taskSecondTitle: '.e2e_normal_task_content_secondTitle',
      taskBtn: '.e2e_normal_task_right_btn',
      taskStatus: '.statusText',
      taskRight: '.e2e_normal_task_right',
      openDrawerBtn:
        'button[class*="aecoin-taskButton"], [class*="taskButton"], [class*="signButtonWrapper"] button, div[class*="aecoin-signButton"], [class*="aecoin-signButton"]',
      openDrawerTexts: [/earn more coins/i, /ganhe mais moedas/i, /mais moedas/i],
      productCard:
        '[class*="aecoin-feedlist-card"], [class*="feedlist-card"], .feeds-discount-card, [id^="coin-feeds-product"]',
      searchInput:
        'input[type="search"], input[name*="SearchText" i], input[placeholder*="search" i], input[aria-label*="search" i], input[name*="search" i]'
    },

    modals: {
      closeSelectors: [
        '[class*="close"]',
        '[class*="dialog-close"]',
        '[class*="aecoin-close"]',
        '.ui-dialog-close'
      ],
      closeTexts: [/^OK$/i, /^Confirm$/i, /^Confirmar$/i, /^Fechar$/i, /^Close$/i, /^×$/, /^✕$/]
    }
  };
})();
