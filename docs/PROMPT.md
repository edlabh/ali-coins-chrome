# Prompt gerado (skill: prompt-engineer)

> **Nota (a partir da v0.4.x):** este é o prompt original de implementação (histórico).
> Alguns comportamentos evoluíram depois dele: o **login agora é 100% manual** (as
> credenciais saíram das Opções — o item "Credenciais" do prompt perdeu efeito),
> captcha/2FA aguardam o usuário **sem tempo máximo** (sessão expirada encerra a
> execução com erro acionável — faça login na versão desktop e execute novamente) e o
> bloqueio anti-bot (RGV587) **não aplica mais cooldown** — a execução apenas encerra
> por precaução. O restante do documento continua válido como referência de paridade
> com o ali-coins.

> Este é o prompt otimizado que rege a implementação desta extensão, gerado a partir de:
> 1. análise profunda do projeto [edlabh/ali-coins](https://github.com/edlabh/ali-coins);
> 2. skills selecionadas do catálogo [sickn33/agentic-awesome-skills](https://github.com/sickn33/agentic-awesome-skills).

## Skills selecionadas no catálogo

| Skill | Por que foi escolhida |
| --- | --- |
| `chrome-extension-developer` | Núcleo MV3: service worker, content scripts, message passing, `chrome.alarms`, `declarativeNetRequest`, `chrome.storage`. |
| `browser-extension-builder` | Estrutura de projeto de extensão (popup, options, content, background) e boas práticas de UX. |
| `browser-automation` | Padrões de automação confiável: estado observado da UI, locators semânticos, esperas limitadas. |
| `playwright-skill` | Referência de automação usada pelo ali-coins (Playwright) — usada na análise e para paridade de seletores/fluxos. |
| `systematic-debugging` | Metodologia para diagnosticar automação frágil (seletores que mudam, telas intersticiais, timeouts). |

## Prompt (pronto para uso)

```text
Role: Você é um engenheiro sênior de extensões Chrome (Manifest V3) e automação web,
com prática em Playwright, páginas de e-commerce móvel e engenharia de robustez
(esperas limitadas, locators semânticos, degradação graciosa).

Objetivo: Implementar uma extensão Chrome que replique o comportamento do projeto
ali-coins (github.com/edlabh/ali-coins): abrir uma janela mobile emulando um Google
Pixel 8, autenticar no AliExpress com usuário e senha, realizar o check-in diário de
moedas e executar as tarefas do painel "Ganhe mais moedas" (checkin + tarefas), com
agendamento diário em horário configurável e/ou execução ao abrir o Chrome, pausando
para o usuário resolver captchas e retomando automaticamente.

Contexto do sistema de referência (ali-coins) — comportamento a replicar:
- Playwright com contexto mobile (Pixel 7, locale pt-BR) navegando para
  https://m.aliexpress.com/p/coin-index/index.html.
- Login: preenche #fm-login-id → senha (#fm-login-password / input[type="password"])
  → botão primário cosmos; valida a sessão por cookies (login_aliyunid_ticket e
  rotação do xman_us_t) e por sinais de UI; trata verificação 2FA; detecta bloqueio
  de risco RGV587 e entra em cooldown (48h) sem insistir.
- Check-in: clica em #signButton (com lista de fallbacks), confirma pelo marcador
  [class*="today-checked"], lê o +N de moedas do modal de sucesso e registra a
  sequência (streak) — tiers: dia 1=+10 até dia 7+=+40.
- Tarefas: abre a gaveta de tarefas (.e2e_task) pelo botão "Earn more coins /
  Ganhe mais moedas"; lê os cards .e2e_normal_task (título, subtítulo, botão
  GO/IR/COLLECT, status "n/m"); executa por tipo:
  • produtos surpresa ("toque em 3 itens"): toca 3 cards .feeds-discount-card sem
    repetir (assinatura por data-id/href/texto), rolando o feed para carregar novos;
  • busca por palavra-chave: preenche o campo de busca (ex.: "fone bluetooth"), dá
    Enter e rola a página de resultados;
  • super descontos: permanência mínima de 16s com scroll;
  • Prize Land/minigames/quizzes/avaliações: exigem app nativo → ignorados por
    padrão (opção configurável);
  • demais tarefas: rolagem/permanência (~10s) na página aberta.
  Após cada ação, retorna à central de moedas e reabre a gaveta para a próxima.
- Ritmo anti-detecção: pausas aleatórias entre tarefas, atraso inicial aleatório,
  limpeza de abas órfãs, sem rajadas.

Instruções — implemente uma extensão MV3 completa:
1. Estrutura mínima viável: manifest.json com permissões mínimas (storage, alarms,
   tabs, notifications, cookies, declarativeNetRequest) e host permissions apenas
   para *://*.aliexpress.com/* e *://*.aliexpress.us/*; service worker como módulo;
   content scripts; popup de status; página de opções — tudo em pt-BR.
2. Janela mobile Pixel 8: chrome.windows.create tipo popup com 412×915 CSS px;
   reescrever User-Agent e Client Hints móveis (sec-ch-ua-mobile: ?1,
   sec-ch-ua-platform: "Android") via declarativeNetRequest em session rules
   escopadas pelo tabId da execução.
3. Credenciais: usuário e senha na página de opções; senha cifrada em repouso com
   AES-256-GCM usando chave não exportável (WebCrypto + IndexedDB); nunca manter
   senha em texto puro quando a criptografia estiver disponível.
4. Orquestração no background: máquina de estados auth → checkin → tasks →
   finalize, enviando comandos curtos e idempotentes ao content script a cada
   página (resiliente a navegações completas); estado do run em
   chrome.storage.session para sobreviver a reinícios do service worker; keepalive
   durante o run; botão "Parar" cooperativo.
5. Login: preencha usuário → senha → submeta; valide a sessão por UI + cookies;
   se 2FA aparecer, peça a intervenção do usuário na janela e aguarde.
6. Captcha: detecte o slider nocaptcha (#nc_1_n1z/.btn_slide) e iframes baxia;
   traga a janela para frente, mostre notificação e badge; aguarde em laço o
   usuário resolver e prossiga; se detectar RGV587/limite de tráfego, aborte com
   cooldown configurável (padrão 48h) em vez de insistir.
7. Check-in e tarefas: replique os seletores e heurísticas do ali-coins listados
   acima, com fallbacks por texto e por classe; classifique as tarefas por tipo;
   limite ações por execução e tentativas por tarefa; priorize resgates (COLLECT);
   ignore tarefas exclusivas de app conforme opção.
8. Agendamento: alarme diário em horário HH:MM configurável + execução ao abrir o
   Chrome (chrome.runtime.onStartup) + botão "Executar agora" no popup; atraso
   inicial aleatório apenas em execuções agendadas/na abertura.
9. Relatórios: saldo antes/depois, moedas do check-in, streak, ações executadas,
   tarefas ignoradas, captchas e erros; persistir histórico; exibir no popup;
   notificações do sistema no início, fim, captcha e bloqueio.
10. Qualidade: código modular sem dependências externas; testes unitários da lógica
    pura com node --test; README com instalação (carregar sem empacotamento), uso,
    segurança e limitações.

Raciocine passo a passo antes de codificar (análise → arquitetura → implementação →
verificação) e valide ao final: manifest válido e todos os arquivos referenciados
existem; sintaxe de todos os arquivos JS ok; testes passando.

Critérios de aceite:
- A extensão carrega sem erros em chrome://extensions ("Carregar sem empacotamento").
- "Executar agora" abre a janela mobile Pixel 8 e conduz login → check-in → tarefas.
- Com captcha presente, a automação pausa, notifica, foca a janela e retoma após a
  resolução manual.
- Agenda diária e "ao abrir o Chrome" funcionam; o popup mostra o estado ao vivo e
  o último relatório.
- Nenhuma credencial sai do navegador; senha cifrada em repouso.

Formato de saída: manifest.json, src/{background,content,popup,options}, icons/,
tests/, README.md e docs/PROMPT.md; relatório final do que foi criado e como validar.
```
