# 📱 Secretária de Bolso v0.4: MVP SaaS

A Secretária de Bolso é uma secretária para pequenos empresários que funciona dentro do WhatsApp. Ela é vendida por assinatura mensal.

O que ela faz:
- **sincroniza com a Google Agenda** e **marca, remarca e desmarca compromissos** quando o cliente pede (sempre com confirmação);
- envia **avisos estratégicos** pelo WhatsApp;
- cuida da **lista de tarefas**;
- deixa o cliente **configurar regras e textos** das mensagens;
- **conversa** em português simples.

O WhatsApp é conectado pela **[Evolution API](https://github.com/EvolutionAPI/evolution-api)**: você lê um QR Code no painel `/admin` com o celular do número da Secretária, e pronto.

## Ver funcionando agora, direto do GitHub

[![Abrir no GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/cheirodeverde/secretaria-virtual?quickstart=1)

1. Toque no botão acima → **Create codespace** (precisa estar logado no GitHub; a conta gratuita tem horas mensais incluídas).
2. Espere 1–2 minutos. O sistema sobe sozinho em modo demonstração (agenda fictícia e WhatsApp simulado) e o navegador abre o site.
   Se não abrir: aba **Portas** → porta 3000 → ícone 🌐.
3. No endereço que abriu, acrescente **`/admin`** (usuário qualquer, senha `admin`).
4. Para desligar e não gastar horas: github.com/codespaces → ⋯ → **Stop codespace**.

## Testar no seu computador (sem nenhuma credencial)

```bash
npm install                # Node 22.13+
npm test                   # 23 testes: datas, intenções, compromissos, Evolution API, motor de regras e conversas completas
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
| **Avisos automáticos** | Resumo da manhã, prévia de amanhã, lembrete antes de cada compromisso ("saia até 13:30" + rota), conflitos, deslocamento apertado, mudanças na agenda e lembrete de tarefa ("Responda FEITO 2 ou ADIAR 2 PARA AMANHÃ"). |
| **Conversa** | Entende agenda, horários livres, semana, criar/listar/concluir/adiar/apagar tarefas, ajustes ("resumo às 7h", "não perturbe das 22h às 7h"), pausar e conta. Datas naturais: "sexta à tarde", "dia 15", "daqui a 2 horas", "segunda que vem 8h". |
| **Mexer na agenda** | "marcar reunião com João amanhã das 14h às 15h30", "agendar dentista sexta 10h por 40 min", "call com contador quinta 9h online" (cria link do Meet), "almoço dia 20 meio-dia na Rua Augusta 100", "feriado segunda o dia todo", "remarcar dentista pra 16h", "mudar a reunião com João para sexta", "desmarcar reunião". Sempre mostra o resumo e pede confirmação ("Responda SIM ou NÃO"), avisa conflitos, avisa quando os convidados serão notificados e quando o evento se repete (muda só aquela data). Se o nome bater com vários compromissos, lista e pergunta o número. DESFAZER volta a última alteração por 30 min. Convites de outras pessoas não são alterados. Também dá para marcar, remarcar e cancelar pelo painel. |
| **Regras e roteiros** | Cada aviso tem um texto editável com variáveis ({nome}, {agenda}, {tarefas}…) e pode ser desligado. O cliente também cria regras próprias: antes de um evento, depois de um evento ou todo dia, com filtro por título e por dia da semana. A prévia usa os dados reais da agenda. |
| **Painel (PWA)** | Telas Hoje, Tarefas, Regras, Ajustes e Conta. O acesso é por link mágico enviado no WhatsApp (comando PAINEL), sem senha. |
| **Assinatura** | Pelo Asaas: o cliente informa CPF/CNPJ, recebe o link de pagamento e paga com Pix, cartão ou boleto. O webhook ativa a conta. Se atrasar, os avisos continuam por mais 3 dias; depois disso param e as respostas oferecem o link para pagar. |
| **Admin** | Conexão do WhatsApp (QR Code, status, mensagem de teste, desconectar), clientes, situação, mensagens do mês, % de frases não entendidas e o simulador. |
| **WhatsApp (Evolution API)** | Texto em tudo (Evolution não tem janela de 24h nem modelos pagos). Botões viram instruções em texto ("Responda SIM ou NÃO"), que funcionam em qualquer celular. Ignora grupos, status e mensagens enviadas pelo próprio número. Mensagens do mesmo cliente são processadas na ordem. O webhook é protegido por token e configurado sozinho pelo sistema. |

## Implantar de verdade

> ⚠️ **Evolution API é não oficial.** O WhatsApp pode banir o número. Use um **chip só para a Secretária** (nunca o seu pessoal), mande mensagens só para quem falou com ela primeiro e evite disparos em massa. Se um dia quiser a API oficial, o código da Meta continua aqui: `WHATSAPP_PROVIDER=meta`.

1. Copie o arquivo de exemplo com `cp .env.example .env` e preencha. `APP_SECRET` (32+ caracteres aleatórios) e `ADMIN_PASSWORD` são obrigatórios.
2. **Google Cloud:**
   - ative a Google Calendar API;
   - configure a tela de consentimento OAuth no modo Externo, com os clientes do piloto como usuários de teste;
   - crie a credencial do tipo Web com o redirect `https://SEU-DOMINIO/auth/google/callback`.
   - escopos: com `CALENDAR_WRITE=true` (padrão) o app pede `calendar.events` (ver e editar eventos); com `false`, só `calendar.readonly`, como na v0.2. Cadastre na tela de consentimento o escopo que vai usar.
   - Para abrir o produto ao público, peça a verificação do app (o escopo de agenda é sensível). Ela exige vídeo, política de privacidade e domínio verificado. O vídeo precisa mostrar a criação/remarcação de um compromisso pelo WhatsApp.
   - **Quem já usava a v0.2** conectou só com leitura. Ao pedir para marcar algo, a Secretária manda o link para autorizar a edição, e o painel mostra o botão "Autorizar edição da agenda". Nada quebra enquanto o cliente não autoriza.
3. **Servidor** (escolha um):
   - **VPS com Docker (tudo junto, recomendado):** um servidor com 2 GB de RAM (Hetzner, Contabo, DigitalOcean, Hostinger). Aponte o DNS do seu domínio para ele, preencha no `.env` também `DOMAIN`, `EVOLUTION_API_KEY` (invente uma chave longa) e `POSTGRES_PASSWORD`, e rode `docker compose up -d`. Sobem a Secretária, a Evolution API, o Postgres, o Redis e o HTTPS (Caddy). Os dados ficam em volumes do Docker.
   - **Railway:** crie um projeto com dois serviços: (a) a Evolution API pelo template "Evolution API" do Railway e (b) este repositório (`npm start`) com um **volume montado em `/app/data`** e `DB_FILE=/app/data/secretaria.db`. No serviço da Secretária, preencha `EVOLUTION_API_URL` (URL da Evolution) e `EVOLUTION_API_KEY` (a `AUTHENTICATION_API_KEY` dela) e `BASE_URL` (URL pública da Secretária).
   - ⚠️ **Vercel/Netlify/Cloudflare não servem**: o sistema precisa ficar ligado (agendador a cada minuto) e de disco para o banco.
4. **Conectar o WhatsApp:** abra `https://SEU-DOMINIO/admin` → **Conectar WhatsApp (QR Code)** → no celular da Secretária: WhatsApp → Aparelhos conectados → Conectar aparelho → leia o QR. O sistema cria a instância e configura o webhook sozinho. Use **Enviar mensagem de teste** para conferir.
5. **Asaas:** gere a API key. Crie o webhook `https://SEU-DOMINIO/billing/webhook` com um authToken e coloque esse mesmo valor em `ASAAS_WEBHOOK_TOKEN`. Assine os eventos `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_OVERDUE`, `SUBSCRIPTION_DELETED` e `SUBSCRIPTION_INACTIVATED`.
6. Preencha `WHATSAPP_DISPLAY_NUMBER` com o número da Secretária (é o link "Começar no WhatsApp" do site).
7. Antes de publicar, revise `public/privacidade.html` e `public/termos.html` com um advogado.

## Estrutura

```
src/
  conversation.js     cadastro + modo conversacional (respostas)
  nlu/datetime.js     datas e horários em português
  nlu/intents.js      intenções (regras, sem IA — escopo fechado)
  rules/analysis.js   análise da agenda (conflitos, deslocamento, almoço, foco)
  rules/engine.js     motor de avisos (funções puras, testadas)
  rules/scripts.js    regras do sistema, roteiros editáveis e regras personalizadas
  tasks.js            tarefas com número curto ("feito 2")
  scheduler.js        a cada minuto: sincroniza, calcula e envia
  dispatcher.js       único ponto de saída: anti-duplicidade, não perturbe, pausa, conta
  whatsapp.js         Evolution API (envio, QR Code, webhook) e, opcional, API oficial da Meta
  nlu/event.js        pedidos de compromisso (início, fim, duração, local, Meet, dia todo)
  calendar.js         achar o compromisso citado, conflitos, criar/remarcar/cancelar, histórico e desfazer
  google.js           OAuth por cliente, tokens criptografados (AES-256-GCM), leitura e escrita na agenda
  billing.js          Asaas: assinatura + webhook idempotente
  account.js          situação da conta, teste, carência, link mágico
  db.js               SQLite embutido (node:sqlite), tudo filtrado por cliente
  server.js           rotas: site, webhooks, painel, admin
public/               site de vendas, painel do cliente (PWA), admin com simulador
templates/            7 modelos de mensagem (só se usar a API oficial da Meta)
docker-compose.yml    servidor completo: Secretária + Evolution + Postgres + Redis + HTTPS
.devcontainer/        demonstração no GitHub Codespaces
test/                 testes
```

## Limites conscientes (Fase 2)

- Convidar pessoas para um compromisso pelo WhatsApp e responder convites (aceitar/recusar).
- IA só para entender as frases, com a mesma lista fechada de intenções. Hoje o entendimento é por regras.
- Áudio, tarefas recorrentes e delegar tarefa a funcionários.
- Postgres e fila de jobs acima de cerca de 500 clientes. Fuso horário por cliente (hoje há um só para todos).
