/**
 * Constantes compartilhadas entre background, popup e options.
 * Mantém em um só lugar as URLs do AliExpress, presets de aparelho e o
 * protocolo de mensagens entre os contextos da extensão.
 */

export const COIN_URL = 'https://m.aliexpress.com/p/coin-index/index.html';
export const COIN_URL_TASKS = `${COIN_URL}?_immersiveMode=true&from=pc302`;
/** Extrato desktop de moedas (página mycoin) — fonte de verdade da contabilidade. */
export const MYCOIN_URL = 'https://www.aliexpress.com/p/coin-pc-index/mycoin.html';

/** Presets de emulação. width/height = viewport CSS (sem decoração da janela). */
export const DEVICE_PRESETS = {
  pixel8: {
    label: 'Google Pixel 8 (Android 14)',
    width: 412,
    height: 915,
    scaleFactor: 2.625,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
  },
  pixel7: {
    label: 'Google Pixel 7 (Android 13)',
    width: 412,
    height: 915,
    scaleFactor: 2.625,
    userAgent:
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
  },
  custom: {
    label: 'Personalizado',
    width: 412,
    height: 915,
    scaleFactor: 2.625,
    userAgent: ''
  }
};

/** Tipos de mensagem: background -> content script (comando). */
export const CMD = Object.freeze({
  CHECK_AUTH: 'CHECK_AUTH',
  DO_LOGIN: 'DO_LOGIN',
  WAIT_CAPTCHA: 'WAIT_CAPTCHA',
  WAIT_2FA: 'WAIT_2FA',
  DO_CHECKIN: 'DO_CHECKIN',
  READ_BALANCE: 'READ_BALANCE',
  READ_MYCOIN: 'READ_MYCOIN',
  OPEN_DRAWER: 'OPEN_DRAWER',
  EXTRACT_TASKS: 'EXTRACT_TASKS',
  CLICK_TASK: 'CLICK_TASK',
  RUN_ACTION: 'RUN_ACTION',
  ABORT: 'ABORT'
});

/** Tipos de mensagem: content script -> background e popup <-> background. */
export const MSG = Object.freeze({
  CONTENT_READY: 'CONTENT_READY',
  CONTENT_PROGRESS: 'CONTENT_PROGRESS',
  TRUSTED_CLICK: 'TRUSTED_CLICK',
  GET_OVERVIEW: 'GET_OVERVIEW',
  RUN_NOW: 'RUN_NOW',
  STOP_RUN: 'STOP_RUN',
  OPEN_WINDOW: 'OPEN_WINDOW',
  SETTINGS_CHANGED: 'SETTINGS_CHANGED'
});

/** Fases visíveis do run (exibidas no popup/badge). */
export const PHASE = Object.freeze({
  IDLE: 'idle',
  STARTING: 'starting',
  WAITING_DELAY: 'waiting_delay',
  AUTH: 'auth',
  CAPTCHA: 'captcha',
  TWO_FA: 'two_fa',
  CHECKIN: 'checkin',
  TASKS: 'tasks',
  FINALIZING: 'finalizing',
  DONE: 'done',
  ERROR: 'error',
  STOPPED: 'stopped',
  BLOCKED: 'blocked'
});

/** Status possíveis de um relatório de execução. */
export const RUN_STATUS = Object.freeze({
  SUCCESS: 'success',
  PARTIAL: 'partial',
  ERROR: 'error',
  STOPPED: 'stopped',
  BLOCKED: 'blocked'
});

/** Configurações padrão (espelham os defaults seguros do ali-coins). */
export const DEFAULT_SETTINGS = Object.freeze({
  user: '',
  passwordEnc: null, // { v, iv, ct } — nunca armazenamos senha em texto puro quando o WebCrypto está disponível
  passwordPlain: '', // fallback apenas se a criptografia falhar (sinalizado na UI)
  cryptoOk: null,

  // Agendamento
  scheduleEnabled: false,
  scheduleTime: '09:30', // HH:MM local do navegador
  runOnStartup: false,

  // Ritmo / anti-detecção
  startDelayMaxMin: 15,
  pauseBetweenTasksMinMs: 5000,
  pauseBetweenTasksMaxMs: 20000,

  // Comportamento de tarefas
  skipAppOnlyTasks: true,
  maxTaskActions: 25,
  maxAttemptsPerTask: 3,
  searchQuery: 'fone bluetooth',
  scrollSeconds: 10,

  // Captcha
  captchaTimeoutMin: 5,
  riskCooldownHours: 48,

  // Janela / aparelho
  device: 'pixel8',
  customUA: '',
  customWidth: 412,
  customHeight: 915,
  keepWindowOpen: false, // por padrão a janela mobile é FECHADA ao concluir (configurável)
  // PADRÃO: execução em segundo plano (aba de fundo, nada abre na tela). A aba
  // só é trazida para frente quando um captcha/2FA precisar do usuário.
  // Desmarque nas Opções para acompanhar a execução numa janela visível.
  silentMode: true,
  notifications: true
});

export const RUN_HISTORY_LIMIT = 20;
export const RUN_LOG_LIMIT = 80;

/** Mensagem padrão exibida ao usuário quando um captcha aparece. */
export const CAPTCHA_NOTIFICATION = {
  title: 'Ali Coins: captcha detectado',
  message:
    'Resolva a verificação de segurança na janela aberta. A automação continua automaticamente após a resolução.'
};

export function pickDevice(settings) {
  const preset = DEVICE_PRESETS[settings.device] || DEVICE_PRESETS.pixel8;
  if (settings.device === 'custom') {
    return {
      label: preset.label,
      width: clampInt(settings.customWidth, 320, 1400, 412),
      height: clampInt(settings.customHeight, 480, 2000, 915),
      scaleFactor: preset.scaleFactor,
      userAgent: settings.customUA || DEVICE_PRESETS.pixel8.userAgent
    };
  }
  return preset;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
