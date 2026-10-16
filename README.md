# Ali Coins Chrome

Extensão Chrome (Manifest V3) que replica o projeto
[edlabh/ali-coins](https://github.com/edlabh/ali-coins) no navegador:

- abre uma **janela mobile emulando um Google Pixel 8**;
- reutiliza a **sessão do seu perfil** no AliExpress (login é **100% manual** —
  a extensão nunca pede nem guarda credenciais; se a sessão expirar, avisa e
  traz o login da versão desktop para frente);
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
2. **Login manual**: entre no AliExpress normalmente pelo navegador. A extensão reutiliza
   a **sessão do perfil** — nenhuma credencial é pedida ou guardada. Se a sessão expirar
   durante uma execução, ela **termina com o erro "login manual necessário"**: a aba é
   convertida na **tela de login da versão desktop** (sem a emulação mobile) e trazida
   para frente, uma notificação avisa e a tela **fica aberta** (não é fechada junto com o
   run) — faça o login nela e execute a extensão novamente.
3. Configure, se quiser:
   - **Agendamento**: todos os dias no horário `HH:MM` (fuso do seu computador);
   - **Executar ao abrir o Chrome**;
   - **Catch-up de agenda** (padrão): se o Chrome estava fechado no horário agendado,
     a execução acontece na próxima abertura;
   - **Retentativa automática** (padrão): uma falha agenda **1 nova tentativa** em ~45 min;
   - **Tarefa "Explore itens surpresa"** (executada por padrão): marque a opção para
     ignorá-la — qualquer página que o site abrir (feed, ficha do item) recebe o
     **contexto mobile já na criação da aba** (sem reload), os cliques têm **hit-test**
     contra overlays, há fallback de detalhe e memória diária de cards (itens repetidos
     não contam progresso); o extrato mostra o **diagnóstico de beacons/visibilidade** da ficha;
   - **Modo silencioso** (**padrão**): executa em uma **JANELA DEDICADA de fundo**
     (criada sem foco) — todas as abas do run (central, tarefas, fichas que o site
     abre) vivem nela e **suas janelas/abas não são tocadas**; a janela **nunca é
     trazida para o primeiro plano** durante a execução (o foco é devolvido a você
     mesmo após abas/attach do depurador) — ela só vem para frente se um
     captcha/2FA precisar de você (ou para abrir o login da versão desktop quando a
     sessão expirar); desmarque para acompanhar numa janela visível;
   - **Notificação condicional** (opcional): avisar apenas quando houver novidade
     (check-in novo, crédito do dia ou tarefas executadas) — erros sempre avisam;
   - **Log detalhado** (opcional): o extrato de cada execução é **resumido por padrão**
     (início, check-in, tarefas, captcha, erros); ative para registrar também as linhas
     de diagnóstico (navegação/adoção de abas, beacons das fichas, leitura do extrato);
   - atraso inicial aleatório, pausas entre tarefas, máximo de ações, etc.
4. Use **▶ Executar agora** no popup para validar o fluxo manualmente. Para inspecionar
   a janela mobile a qualquer momento, use **Abrir janela mobile** nas Opções (a tela
   principal da extensão fica enxuta, só com as ações do dia a dia).
5. Quando um captcha aparecer, a janela mobile é trazida para frente e uma notificação
   é exibida. Resolva o desafio na janela — a automação continua sozinha, **sem tempo
   máximo de espera** (use **Parar** no popup para cancelar).
6. Ao concluir, a **janela mobile é fechada automaticamente** (dá para manter aberta nas
   Opções). O **extrato da execução** aparece no popup (check-in, tarefas, saldo) e o
   histórico completo fica em **Opções → Extrato de execuções**, com o log passo a passo
   e o aviso quando o check-in do dia **já havia sido coletado**. O resumo do extrato
   (página mycoin) mostra **sempre**: **Bônus diário** (check-in), **Missões de moedas**
   (soma das tarefas) e, quando existir, o **recuperado pelo cancelamento de pedidos**.

> 💡 **Fuso horário:** o "dia contábil" do AliExpress vira à meia-noite do Pacífico
> (America/Los_Angeles, UTC-7/-8). Para garantir que o check-in caia sempre no dia novo,
> agende para depois das ~04:00 no horário de Brasília (ou equivalente na sua região).

### Fluxo executado

```
janela Pixel 8 → m.aliexpress.com/coin-index
   → sessão já ativa? login é dispensado; senão:
     LOGIN MANUAL: execução termina com erro acionável — a aba vira a tela de
     login DESKTOP (sem emulação mobile), trazida para frente e mantida aberta
     + notificação "faça login e execute a extensão novamente"
   → check-in diário (#signButton) + confirmação do marcador "today-checked"
   → tarefas "Ganhe mais moedas":
        busca (fone bluetooth) • scroll ≥16s (descontos) • resgates (COLLECT)
        • tarefas de app e "Explore itens surpresa" ignoradas (configurável nas Opções)
   → saldo final + extrato no popup/opções + notificação + janela mobile fechada
```

## Paridade com o ali-coins (Playwright) e diferenças

| Capacidade | ali-coins (Node/Playwright) | Esta extensão (MV3) |
| --- | --- | --- |
| Emulação mobile | Pixel 7 (Playwright `devices`) | Pixel 8 via janela 412×915 + UA/Client Hints (DNR) |
| Login | usuário/senha + slide captcha | sessão do perfil; se expirar, **erro acionável + login da versão desktop** (sem credenciais) |
| Check-in | `#signButton` + confirmação + streak | idêntico (mesmos seletores/fallbacks) |
| Tarefas | surpresa/busca/scroll/resgate, gaveta `.e2e_task` | idêntico (Explore itens surpresa executada por padrão — configurável) |
| Captcha | tenta deslizar automaticamente | pausa e aguarda o usuário resolver, sem tempo máximo (por design) |
| Contabilidade | extrato desktop (mycoin): saldo, Bônus diário, Missões de moedas | idêntica — aba desktop dedicada, mesmo parser e prioridades |
| Risco RGV587 | cooldown 48h + fail-fast | fail-fast: encerra o run por precaução, sem pausa fixa |
| Agendamento | cron/Task Scheduler externo | `chrome.alarms` interno + execução ao abrir o Chrome |
| Sessão | storageState criptografado (AES-GCM v3) | cookies do próprio perfil do Chrome (persistente) |
| Notificações | Telegram/webhook/heartbeat | notificações do Chrome + badge |
| Multi-conta | até 20 contas | uma conta (simplificação intencional) |

## Como funciona (arquitetura)

```
src/background/
  service-worker.js  Roteador de mensagens, foco ao clicar em notificação e guarda de abas
  runner.js          Orquestrador principal (auth → checkin → tasks → finalize) + keepalive
  context.js         Primitivas do run (comandos com retry, logs, esperas abortáveis)
  gates.js           Gates de intervenção do usuário (captcha, 2FA e login manual)
  auth.js            Verificação de sessão (somente leitura) + espera pelo login manual
  checkin-phase.js   Fase de check-in + consolidação da contabilidade e sequência
  tasks-phase.js     Loop de tarefas "Ganhe mais moedas", adoção de aba e surpresas
  item-tab.js        Detecção e fechamento de abas de produto abertas pelo feed
  ledger-read.js     Leitura do extrato desktop (página mycoin) em aba dedicada
  finalize.js        Contabilidade final, relatório, notificação e política de janela
  cdp.js             Cliques confiáveis (isTrusted via chrome.debugger) + viewport silenciosa
  scheduler.js       chrome.alarms diário + catch-up + chrome.runtime.onStartup
  retry.js           Retentativa única (~45 min) após falha de execução
  tabs.js            Janela Pixel 8, session rules de UA/Client Hints (DNR) e abas órfãs
  storage.js         chrome.storage.local/session (fila serializada, sem credenciais)
  notify.js          Badge + notificações do sistema
src/common/
  constants.js       URLs, presets de aparelho, comandos e configurações padrão
  accounting.js      Funções puras de contabilidade (check-in, tarefas, saldo, streak)
  state-utils.js     Fila de tarefas (pickNextTask), migrações de schema e relatório
  schedule.js        Cálculo de horários, catch-up e formatação de tempo
  format.js          Formatadores compartilhados (pt-BR)
src/content/
  main-world.js      Spoof dinâmico de navigator (UA/userAgentData) no MAIN world
  selectors.js       Seletores do AliExpress (espelho do ali-coins + fallbacks)
  task-classify.js   Classificação UMD das tarefas (surpresa/busca/app/scroll)
  ledger.js          Parser UMD do extrato desktop (mycoin) no fuso America/Los_Angeles
  dom.js             Helpers de DOM (clique humano, esperas, scroll interno, captcha, modal)
  actions.js         Check-in, saldo, gaveta e ações por tarefa (login não é automatizado)
  bridge.js          Ponte de comandos do service worker e sincronização do spoof
src/popup/           Status ao vivo, chips de saldo/sequência, agenda e ações rápidas
src/options/         Agendamento, tarefas, aparelho, backup JSON e extrato de execuções
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
- **Contabilidade fiel ao ali-coins**: o saldo e o extrato do dia vêm da página
  desktop `mycoin` (aberta em uma **aba desktop dedicada**, sem as regras de UA mobile).
  O parser usa o fuso **America/Los_Angeles** (o "dia" contábil do AliExpress), separa
  **Bônus diário** (check-in) de **Missões de moedas** (tarefas), prioriza o valor real
  do extrato > modal mobile > estimativa pela sequência, compensa o saldo quando o
  crédito do check-in ainda não apareceu e calcula o ganho das tarefas pelo **delta de
  saldo**. Sequência quebrada gera alerta (log + notificação + extrato).
  A sequência é lida **direto do site**: o número principal do calendário da central
  de moedas (classe `dayNumber`, que o próprio AliExpress usa para o total — ex.:
  "240 day(s) streak") e o modal de quebra (`brokenDays`), com fallbacks textuais e
  estruturais; valores > 7 têm prioridade sobre o ciclo semanal 1–7 e o consolidado
  nunca é rebaixado sem quebra confirmada — sem valores manuais/hardcoded.
- **Cliques confiáveis (CDP)**: botões que ignoram eventos sintéticos (o painel
  "Ganhe mais moedas" é um caso real) recebem cliques REAIS via `chrome.debugger`
  (`Input.dispatchMouseEvent` — o mesmo mecanismo do Playwright no ali-coins),
  aplicados por coordenadas (o alvo é o elemento visualmente no ponto). O Chrome
  exibe um **aviso de depuração** na janela de execução enquanto ela estiver aberta
  — não cancele, é o mecanismo que aplica os cliques. Se o aviso for cancelado, a
  extensão cai sozinha no fallback com eventos sintéticos.
- **Painel "Ganhe mais moedas" resiliente**: a volta à central é **confirmada**
  (o site pode re-redirecionar a aba para o feed patrocinado `recommends.html`
  logo após o load); abas/janelas abertas pelo site são **fechadas antes** da
  volta (um feed ainda vivo pode puxar a aba de origem de volta) e, se o painel
  falhar, a extensão faz recuperações (leve + pesadas, com teto) **em vez de
  abandonar as tarefas restantes** do run.
- **Modo silencioso (segundo plano, padrão)**: a execução ocorre numa **JANELA
  DEDICADA** (normal, criada **sem foco**) — todas as abas do run (central,
  tarefas, fichas que o site abre) vivem nela e **suas janelas/abas não são
  tocadas nem perdem o foco**. Como a aba não tem o tamanho físico do aparelho, a
  viewport do Pixel 8 é emulada via CDP (`Emulation.setDeviceMetricsOverride`
  412×915 + toque + foco), e o próprio depurador impede o congelamento da aba em
  segundo plano. As páginas de tarefa abrem **no fluxo nativo do site** (aba
  nova, como na v0.3.3 e no projeto de origem) — dentro da janela dedicada — e
  são **fechadas ao fim de cada tarefa**; ao concluir, a janela dedicada é
  fechada. Limitação honesta: **não existe "headless" real para extensões** — o
  Chrome precisa estar aberto e a janela dedicada existe (sem foco); anexar o
  depurador e abrir/ativar abas são operações nativas que podem trazer a janela
  para frente — a extensão confere o foco na hora e o devolve a você, então a
  janela dedicada permanece em segundo plano do início ao fim; se um
  captcha/2FA/login exigir sua ação, ela é trazida para frente automaticamente e
  volta ao fundo depois.
- **Captcha**: a resolução é sempre manual (a extensão não tenta deslizar o desafio).
  Detecção por `#nc_1_n1z`, `.btn_slide`, containers `nocaptcha`/`baxia` e iframes.
  Sem tempo máximo: resolve ou cancele pelo popup.
- **Login**: 100% manual — a extensão nunca pede nem guarda credenciais. Quando o
  AliExpress pede login, a execução termina com erro acionável: a aba é convertida na
  **tela de login da versão desktop** (sem emulação mobile — UA/Client Hints e viewport
  são removidos), trazida para frente e **preservada ao fim do run**, e uma notificação
  avisa para entrar e executar a extensão novamente.
- **Tarefas de app** (Prize Land, minigames, quizzes, avaliações) são ignoradas por padrão,
  como no ali-coins (`SKIP_APP_ONLY_TASKS=true`).

## Segurança e privacidade

- A extensão **não pede nem guarda credenciais**: o login é feito por você no próprio
  AliExpress e a automação apenas reutiliza a sessão (cookies) do perfil do Chrome.
- Nenhuma telemetria, nenhum servidor remoto. O único tráfego é para o AliExpress.
- Recomendações: perfil dedicado do Chrome para automação; não sincronizar esse perfil;
  revisar as permissões antes de instalar.

## Desenvolvimento

```bash
npm ci          # devDependencies (ESLint + jsdom; o runtime não tem dependências)
npm test        # testes unitários + testes de DOM (jsdom) dos content scripts
npm run check   # checagem dinâmica de sintaxe de todos os módulos + versão
npm run lint    # ESLint (configuração flat)
npm run pack    # gera dist/ali-coins-chrome-<versão>.zip + dist/SHA256SUMS.txt
npm run icons   # regera os ícones (tools/make-icons.py)
```

O **CI** (GitHub Actions — `.github/workflows/ci.yml`) roda `npm ci`, `npm run check`,
`npm run lint` e `npm test` em cada push/PR, e o workflow `.github/workflows/release.yml`
publica automaticamente a GitHub Release ao enviar uma tag `v*`.

## Limitações conhecidas

- **Captcha e 2FA são manuais** — aguardam o usuário resolver (sem tempo máximo) e a
  automação prossegue sozinha. **Sessão expirada** encerra a execução com o aviso para
  fazer login na versão desktop e executar novamente.
- **RGV587** (controle de risco do AliExpress): a execução é encerrada por precaução
  (sem pausa fixa) — você decide quando rodar de novo.
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
src/common/               constantes, agendamento, fila de tarefas, contabilidade
src/content/              seletores, classificação, DOM, ações, bridge
src/popup/                popup de status
src/options/              página de opções
tests/unit.test.js        testes da lógica pura, storage e manifest
tests/content-dom.test.js testes de DOM (jsdom) dos content scripts reais
tools/check.mjs           verificador dinâmico de sintaxe e consistência de versão
tools/pack-release.py     empacotador determinístico (.zip + SHA256SUMS.txt)
tools/make-icons.py       gerador de ícones (sem dependências)
```

## Licença

MIT — veja [`LICENSE`](LICENSE). A automação do AliExpress é de responsabilidade
do usuário (veja o aviso no topo deste README).
