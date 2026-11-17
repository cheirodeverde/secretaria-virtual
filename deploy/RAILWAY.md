# Colocar a Secretária no ar pelo Railway (o jeito mais simples)

A Evolution continua onde está (só fornece a conexão do WhatsApp).
A Secretária roda no Railway, que lê direto deste repositório do GitHub. Custo: cerca de US$ 5/mês.

## 1. Criar o projeto
1. Entre em **railway.com** → **Login with GitHub**.
2. **New Project** → **Deploy from GitHub repo** → escolha **`cheirodeverde/secretaria-virtual`**.
   (Se não aparecer: **Configure GitHub App** e libere o repositório.)
3. Ele começa a montar sozinho. Pode dar erro na primeira vez — é normal, faltam os passos 2 e 3.

## 2. Criar o disco (onde ficam clientes, tarefas e números)
No serviço criado → clique com o botão direito no quadro do serviço (ou **⌘K / Ctrl+K**) → **Add Volume** (ou aba **Settings → Volumes**):
- **Mount path:** `/app/data`

> Sem esse disco, tudo é apagado a cada atualização.

## 3. Cadastrar 2 variáveis
Serviço → aba **Variables** → **+ New Variable**:

| Nome | Valor |
|---|---|
| `APP_SECRET` | 40+ caracteres aleatórios (gerador de senhas). **Guarde e nunca troque.** |
| `ADMIN_PASSWORD` | a senha que você vai usar no `/admin` |

Para testar antes de ter o Google configurado, adicione também `DEMO_MODE` = `true` (agenda fictícia).

## 4. Gerar o endereço
Serviço → **Settings → Networking → Generate Domain** (porta: a que ele sugerir).
Vai aparecer algo como `https://secretaria-virtual-production.up.railway.app`.
(Opcional: **Custom Domain** → `secretaria.agentenpe.com.br` e crie o CNAME que ele mostrar, no Cloudflare.)

> Se usar domínio próprio, adicione a variável `BASE_URL` = `https://secretaria.agentenpe.com.br`.
> Com o domínio do Railway, não precisa: o sistema descobre sozinho.

Aguarde o deploy ficar **verde (Active)**. Teste: `https://SEU-ENDERECO/health` → `{"ok":true}`.

## 5. Conectar o WhatsApp (pela tela, sem variáveis)
Abra `https://SEU-ENDERECO/admin` (usuário: qualquer · senha: `ADMIN_PASSWORD`) → **Números da Secretária** → **+ Adicionar número**:

| Campo | Valor |
|---|---|
| Nome | `Secretária principal` |
| URL | `https://evoapi.agentenpe.com.br` (ou a URL do Worker do Cloudflare) |
| Chave | a API key da Evolution (ou o `PROXY_TOKEN` do Worker) |
| Instância | `secretaria` (nova, com chip próprio) |
| Número público | número do chip, ex.: `5511900000000` |

→ **Salvar e testar** → **QR Code** → leia com o celular do chip (WhatsApp → Aparelhos conectados).
→ **Testar envio**. Pronto: mande "oi" para o número.

## Depois (quando for vender)
Em **Variables**, adicione e o Railway reinicia sozinho:
- Google: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (redirect: `https://SEU-ENDERECO/auth/google/callback`) e remova `DEMO_MODE`.
- Asaas: `ASAAS_API_KEY`, `ASAAS_ENV` = `production`, `ASAAS_WEBHOOK_TOKEN` (webhook: `https://SEU-ENDERECO/billing/webhook`).

## Atualizações
Automáticas: a cada mudança no GitHub, o Railway monta e publica de novo. Os dados ficam no disco.
