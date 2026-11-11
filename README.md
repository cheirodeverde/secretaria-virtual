# 📱 Secretária de Bolso v0.2: MVP SaaS

A Secretária de Bolso é uma secretária para pequenos empresários que funciona dentro do WhatsApp. Ela é vendida por assinatura mensal.

O que ela faz:
- **sincroniza com a Google Agenda** (somente leitura);
- envia **avisos estratégicos** pelo WhatsApp;
- cuida da **lista de tarefas**;
- deixa o cliente **configurar regras e textos** das mensagens;
- **conversa** em português simples.

O documento de requisitos completo fica no Claude Docs (link na entrega). Este README cobre só como rodar e implantar.

## Testar agora (sem nenhuma credencial)

```bash
npm install                # Node 22.13+
npm test                   # 12 testes: datas, intenções, motor de regras e uma conversa completa
npm run demo:conversa      # imprime no terminal uma conversa real com a Secretária
npm run demo               # servidor com agenda fictícia e WhatsApp simulado
```

Com o `npm run demo` rodando, abra **http://localhost:3000/admin** (usuário qualquer, senha `admin`). Lá você vai usar o **Simulador de WhatsApp**:

1. Converse como se fosse um cliente novo: "oi", depois "sim", depois "tarefa ligar pro contador amanhã 10h".
2. Toque em **Abrir painel deste cliente** para ver o painel do celular.
3. No painel, conecte a agenda (no modo demo ela é fictícia).
4. Use **Rodar agendador** para disparar os avisos automáticos daquele momento.

## Como o produto funciona

| Parte | O que faz |
|---|---|
| **Cadastro pelo WhatsApp** | O cliente manda "oi" para o número da Secretária. A conta é criada em teste grátis de 14 dias. Ela pergunta o nome e manda o link para conectar o Google. |
| **Avisos automáticos** | Resumo da manhã, prévia de amanhã, lembrete antes de cada compromisso ("saia até 13:30" + rota), conflitos, deslocamento apertado, mudanças na agenda e lembrete de tarefa com botões ✅ Feito / ⏰ Adiar 1h / 📅 Amanhã. |
| **Conversa** | Entende agenda, horários livres, semana, criar/listar/concluir/adiar/apagar tarefas, ajustes ("resumo às 7h", "não perturbe das 22h às 7h"), pausar e conta. Datas naturais: "sexta à tarde", "dia 15", "daqui a 2 horas", "segunda que vem 8h". |
| **Regras e roteiros** | Cada aviso tem um texto editável com variáveis ({nome}, {agenda}, {tarefas}…) e pode ser desligado. O cliente também cria regras próprias: antes de um evento, depois de um evento ou todo dia, com filtro por título e por dia da semana. A prévia usa os dados reais da agenda. |
| **Painel (PWA)** | Telas Hoje, Tarefas, Regras, Ajustes e Conta. O acesso é por link mágico enviado no WhatsApp (comando PAINEL), sem senha. |
| **Assinatura** | Pelo Asaas: o cliente informa CPF/CNPJ, recebe o link de pagamento e paga com Pix, cartão ou boleto. O webhook ativa a conta. Se atrasar, os avisos continuam por mais 3 dias; depois disso param e as respostas oferecem o link para pagar. |
| **Admin** | Clientes, situação, mensagens do mês, custo estimado de WhatsApp, % de frases não entendidas e o simulador. |

## Implantar de verdade

1. Copie o arquivo de exemplo com `cp .env.example .env` e preencha. Os campos `APP_SECRET` e `ADMIN_PASSWORD` são obrigatórios.
2. **Google Cloud:**
   - ative a Google Calendar API;
   - configure a tela de consentimento OAuth no modo Externo, com os clientes do piloto como usuários de teste;
   - crie a credencial do tipo Web com o redirect `https://SEU-DOMINIO/auth/google/callback`.
   - Para abrir o produto ao público, peça a verificação do app (o escopo de agenda é sensível). Ela exige vídeo, política de privacidade e domínio verificado.
3. **Meta (WhatsApp Cloud API):**
   - crie o app e use o número da Secretária;
   - gere um token permanente de usuário do sistema;
   - configure o webhook `https://SEU-DOMINIO/webhook` e assine o campo `messages`;
   - rode `npm run criar-templates` para enviar os 7 modelos de mensagem para aprovação.
4. **Asaas:** gere a API key. Crie o webhook `https://SEU-DOMINIO/billing/webhook` com um authToken e coloque esse mesmo valor em `ASAAS_WEBHOOK_TOKEN`. Assine os eventos `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_OVERDUE`, `SUBSCRIPTION_DELETED` e `SUBSCRIPTION_INACTIVATED`.
5. Rode `npm start` num servidor com HTTPS (Render, Railway, Fly.io ou VPS com Caddy). Guarde a pasta `data/` em disco persistente.
6. Antes de publicar, revise `public/privacidade.html` e `public/termos.html` com um advogado.

## Estrutura

```
src/
  conversation.js     cadastro + modo conversacional (respostas)
  nlu/datetime.js     datas e horários em português
  nlu/intents.js      intenções (regras, sem IA — escopo fechado, como exige a Meta)
  rules/analysis.js   análise da agenda (conflitos, deslocamento, almoço, foco)
  rules/engine.js     motor de avisos (funções puras, testadas)
  rules/scripts.js    regras do sistema, roteiros editáveis e regras personalizadas
  tasks.js            tarefas com número curto ("feito 2")
  scheduler.js        a cada minuto: sincroniza, calcula e envia
  dispatcher.js       único ponto de saída: anti-duplicidade, não perturbe, pausa, conta
  whatsapp.js         Cloud API: texto, botões, modelos, janela de 24h, assinatura do webhook
  google.js           OAuth por cliente, tokens criptografados (AES-256-GCM)
  billing.js          Asaas: assinatura + webhook idempotente
  account.js          situação da conta, teste, carência, link mágico
  db.js               SQLite embutido (node:sqlite), tudo filtrado por cliente
  server.js           rotas: site, webhooks, painel, admin
public/               site de vendas, painel do cliente (PWA), admin com simulador
templates/            7 modelos de mensagem para a Meta
test/                 testes
```

## Limites conscientes (Fase 2)

- Criar e remarcar eventos na Google Agenda pelo WhatsApp (exige o escopo `calendar.events` e uma nova verificação do Google).
- IA só para entender as frases, com a mesma lista fechada de intenções. Hoje o entendimento é por regras.
- Áudio, tarefas recorrentes e delegar tarefa a funcionários.
- Postgres e fila de jobs acima de cerca de 500 clientes. Fuso horário por cliente (hoje há um só para todos).
