# Ali Coins Chrome

Extensão Chrome (Manifest V3) que replica o projeto
[edlabh/ali-coins](https://github.com/edlabh/ali-coins) no navegador:

- abre uma **janela mobile emulando um Google Pixel 8**;
- faz **login no AliExpress** com usuário e senha;
- realiza o **check-in diário de moedas**;
- executa as tarefas do painel **"Ganhe mais moedas"** (produtos surpresa, busca,
  scroll/permanência, resgates);
- em caso de **captcha**, pausa, notifica e **aguarda você resolver** — depois prossegue;
- permite **agendar um horário diário** ou **executar ao abrir o Chrome**;
- gera um **relatório** (saldo antes/depois, moedas do check-in, tarefas, erros).

> ⚠️ Automação de conta própria no AliExpress pode contrariar os Termos de Uso do site e
> envolve risco de bloqueio anti-bot (RGV587). Use por sua conta e risco, preferencialmente
> em um **perfil dedicado do Chrome**. Este projeto não envia dados para nenhum servidor:
> tudo roda localmente no seu navegador.

---

## Instalação (carregar sem empacotamento)

1. Abra `chrome://extensions`.
2. Ative o **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem empacotamento** e selecione esta pasta (`ali-coins-chrome`).
4. Fixe a extensão na barra de ferramentas.

Requisitos: Chrome 116+ (usa `declarativeNetRequest` com session rules e WebCrypto no
service worker). Nenhuma dependência externa em runtime — os scripts de
desenvolvimento (testes/ícones) usam apenas Node.js ≥ 20 e Python 3.

## Uso

1. Clique no ícone da extensão → **Opções**.
2. Preencha **usuário** (e-mail ou telefone) e **senha** do AliExpress e salve.
   A senha é cifrada (AES-256-GCM, chave não exportável) antes de ser gravada.
3. Configure, se quiser:
   - **Agendamento**: todos os dias no horário `HH:MM` (fuso do seu computador);
   - **Executar ao abrir o Chrome**;
   - atraso inicial aleatório, pausas entre tarefas, máximo de ações, etc.
4. Use **▶ Executar agora** no popup para validar o fluxo manualmente.
5. Quando um captcha aparecer, a janela mobile é trazida para frente e uma notificação
   é exibida. Resolva o desafio na janela — a automação continua sozinha (ou aborta após
   o tempo máximo configurado, padrão 5 min).

> 💡 **Fuso horário:** o "dia contábil" do AliExpress vira à meia-noite do Pacífico
> (America/Los_Angeles, UTC-7/-8). Para garantir que o check-in caia sempre no dia novo,
> agende para depois das ~04:00 no horário de Brasília (ou equivalente na sua região).

### Fluxo executado

```
janela Pixel 8 → m.aliexpress.com/coin-index
   → login (usuário → senha → [captcha: aguarda você] → [2FA: aguarda você])
   → check-in diário (#signButton) + confirmação do marcador "today-checked"
   → tarefas "Ganhe mais moedas":
        surpresa (3 cards tocados) • busca (fone bluetooth) • scroll ≥16s (descontos)
        • resgates (COLLECT) • tarefas de app ignoradas (opção)
   → saldo final + relatório no popup e notificação
```

## Paridade com o ali-coins (Playwright) e diferenças

| Capacidade | ali-coins (Node/Playwright) | Esta extensão (MV3) |
| --- | --- | --- |
| Emulação mobile | Pixel 7 (Playwright `devices`) | Pixel 8 via janela 412×915 + UA/Client Hints (DNR) |
| Login | usuário/senha + slide captcha | usuário/senha → captcha manual assistido |
| Check-in | `#signButton` + confirmação + streak | idêntico (mesmos seletores/fallbacks) |
| Tarefas | surpresa/busca/scroll/resgate, gaveta `.e2e_task` | idêntico (mesma classificação e limites) |
| Captcha | tenta deslizar automaticamente | pausa e aguarda o usuário resolver (por design) |
| Risco RGV587 | cooldown 48h + fail-fast | cooldown configurável (padrão 48h) |
| Agendamento | cron/Task Scheduler externo | `chrome.alarms` interno + execução ao abrir o Chrome |
| Sessão | storageState criptografado (AES-GCM v3) | cookies do próprio perfil do Chrome (persistente) |
| Senha em repouso | `credentials.env` (0600) | AES-256-GCM com chave não exportável (IndexedDB) |
| Notificações | Telegram/webhook/heartbeat | notificações do Chrome + badge |
| Multi-conta | até 20 contas | uma conta (simplificação intencional) |

## Como funciona (arquitetura)

```
src/background/
  service-worker.js  Roteador de mensagens
  runner.js          Máquina de estados (auth → checkin → tasks → finalize) + keepalive
  scheduler.js       chrome.alarms diário + chrome.runtime.onStartup
  tabs.js            Janela popup Pixel 8 + session rules de UA (DNR) + abas órfãs
  storage.js         chrome.storage.local/session + cifragem da senha
  notify.js          Badge + notificações do sistema
src/content/
  selectors.js       Seletores do AliExpress (espelho do ali-coins + fallbacks)
  task-classify.js   Classificação das tarefas (surpresa/busca/app/scroll)
  dom.js             Helpers de DOM (clique humano, esperas, captcha, modal)
  actions.js         Login, check-in, saldo, gaveta e ações por tarefa
  bridge.js          Ponte de comandos do service worker
src/popup/           Status ao vivo, agenda e botões
src/options/         Credenciais, agendamento e ajustes
```

Decisões de projeto relevantes:

- **Orquestração no background**: a cada navegação completa (busca, ficha de produto), o
  service worker reenvia o próximo comando ao content script da página nova. O estado
  vive em `chrome.storage.session`, então o run sobrevive a reinícios do service worker.
- **Keepalive**: durante um run o SW faz um ping de API a cada 20s para não ser encerrado
  pelo limite de inatividade do MV3.
- **Emulação Pixel 8 em duas camadas**: o `declarativeNetRequest` reescreve o header
  `User-Agent` (regra com `resourceTypes` explícito — incluindo `main_frame` — e
  domínios do AliExpress + controle de risco) e um content script no **MAIN world**
  spoofa `navigator.userAgent`/`userAgentData`/`maxTouchPoints` apenas na aba de
  execução. A janela é criada em `about:blank` e só navega **depois** das regras
  ativas, garantindo que o primeiro carregamento já renderize a variante mobile.
- **Captcha**: a resolução é sempre manual (a extensão não tenta deslizar o desafio).
  Detecção por `#nc_1_n1z`, `.btn_slide`, containers `nocaptcha`/`baxia` e iframes.
- **Tarefas de app** (Prize Land, minigames, quizzes, avaliações) são ignoradas por padrão,
  como no ali-coins (`SKIP_APP_ONLY_TASKS=true`).

## Segurança e privacidade

- Credenciais ficam **apenas** em `chrome.storage.local` do seu perfil; a senha é cifrada
  com AES-256-GCM usando uma chave gerada localmente e **não exportável** (IndexedDB da
  extensão). Fallback em texto puro só ocorre se o navegador não oferecer WebCrypto —
  nesse caso a UI avisa.
- Nenhuma telemetria, nenhum servidor remoto. O único tráfego é para o AliExpress.
- Recomendações: perfil dedicado do Chrome para automação; não sincronizar esse perfil;
  revisar as permissões antes de instalar.

## Desenvolvimento

```bash
npm test        # testes unitários (node --test) da lógica pura
npm run check   # checagem de sintaxe de todos os scripts
npm run icons   # regera os ícones (tools/make-icons.py)
```

## Limitações conhecidas

- **Captcha é manual** — exigência do projeto: aguardar o usuário resolver e prosseguir.
- **RGV587** (controle de risco do AliExpress) pode exigir espera longa; a extensão pausa
  por `riskCooldownHours` (padrão 48h) para não escalar o risco.
- Layouts A/B do AliExpress podem quebrar seletores pontuais; os fallbacks por texto e
  por classe cobrem as variações conhecidas, mas ajustes podem ser necessários com o tempo.
- Tarefas que exigem o app nativo nunca concluem via web (por isso são ignoradas).
- Se o Chrome for fechado no meio de um run, o run é interrompido (o relatório fica como
  erro no histórico).

## Estrutura de arquivos

```
manifest.json
icons/                    ícones gerados
docs/PROMPT.md            prompt de implementação gerado (skill prompt-engineer)
src/background/           service worker, runner, scheduler, tabs, storage, notify
src/common/               constantes, agendamento, fila de tarefas, criptografia
src/content/              seletores, classificação, DOM, ações, bridge
src/popup/                popup de status
src/options/              página de opções
tests/unit.test.js        testes da lógica pura + sanidade do manifest
tools/make-icons.py       gerador de ícones (sem dependências)
```
