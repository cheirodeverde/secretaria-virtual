# Instalar a Secretária no Portainer (na mesma VPS da Evolution)

Resultado: a Secretária rodando em `https://secretaria.SEUDOMINIO` (ex.: `https://secretaria.agentenpe.com.br`), usando a Evolution que você já tem.

A imagem é gerada sozinha pelo GitHub a cada atualização: `ghcr.io/cheirodeverde/secretaria-virtual:latest` (pública, não precisa de senha).

---

## Passo 1 — Cloudflare: criar o endereço

**Onde:** Cloudflare → seu domínio → **DNS** → **Records** → **Add record**

| Campo | Valor |
|---|---|
| Type | `A` |
| Name | `secretaria` |
| IPv4 address | o **mesmo IP** do registro `evoapi` (copie de lá) |
| Proxy status | **igual ao do `evoapi`** (se lá a nuvem está cinza, deixe cinza; se laranja, laranja) |

## Passo 2 — Portainer: anotar 3 coisas da stack da Evolution

**Onde:** Portainer → **Stacks** → stack da Evolution → aba **Editor**

Procure e anote:

1. **Nome da rede** — no fim do arquivo, em `networks:` (algo como `agent_network`, `minha_rede`, `OrionNet`…)
2. **entrypoints** — na linha `traefik.http.routers.….entrypoints=` (normalmente `websecure`)
3. **certresolver** — na linha `traefik.http.routers.….tls.certresolver=` (normalmente `letsencryptresolver`)

> Se a stack da Evolution **não** tiver `deploy:` (não é Swarm), me avise: o arquivo muda um pouco.

## Passo 3 — Portainer: criar a stack da Secretária

**Onde:** Portainer → **Stacks** → **+ Add stack**

1. **Name:** `secretaria`
2. **Build method:** **Web editor**
3. Cole o conteúdo de [`deploy/portainer-stack.yml`](portainer-stack.yml)
4. No texto colado, troque:
   - `REDE_DA_EVOLUTION` (aparece **3 vezes**) → o nome da rede do passo 2
   - `websecure` → o entrypoint do passo 2 (se for diferente)
   - `letsencryptresolver` → o certresolver do passo 2 (se for diferente)

## Passo 4 — Portainer: cadastrar as variáveis

**Onde:** na mesma tela, role até **Environment variables** → **+ Add an environment variable** (uma por linha).

### Obrigatórias

| Nome | Valor | Observação |
|---|---|---|
| `DOMINIO` | `secretaria.agentenpe.com.br` | sem `https://` |
| `BASE_URL` | `https://secretaria.agentenpe.com.br` | com `https://` |
| `APP_SECRET` | 40+ caracteres aleatórios | use um gerador de senhas. **Guarde e nunca troque**: ele criptografa as chaves dos números e os acessos ao Google |
| `ADMIN_PASSWORD` | uma senha forte | senha do `/admin` |

### Google Agenda (pode deixar para depois)

| Nome | Valor |
|---|---|
| `GOOGLE_CLIENT_ID` | do Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | do Google Cloud Console |

Sem elas, a Secretária funciona (tarefas, conversa), mas o cliente não consegue conectar a agenda. Para testar sem Google: `DEMO_MODE` = `true` (agenda fictícia).

### Cobrança Asaas (pode deixar para depois)

| Nome | Valor |
|---|---|
| `ASAAS_API_KEY` | chave da API do Asaas |
| `ASAAS_ENV` | `sandbox` para testar, `production` para valer |
| `ASAAS_WEBHOOK_TOKEN` | um texto aleatório (o mesmo vai no webhook do Asaas) |

### Opcionais

| Nome | Padrão |
|---|---|
| `PRODUCT_NAME` | `Secretária de Bolso` |
| `TRIAL_DAYS` | `14` |
| `PRICE_ESSENCIAL` / `PRICE_PROFISSIONAL` | `49` / `89` |

> ⚠️ **Os números de WhatsApp e as chaves da Evolution NÃO vão aqui.** Eles são cadastrados na tela do `/admin` (passo 6).

Clique em **Deploy the stack**.

## Passo 5 — Conferir

1. **Stacks → secretaria**: o serviço deve aparecer **running** (1/1).
2. Abra `https://secretaria.agentenpe.com.br/health` → deve mostrar `{"ok":true}`.
3. Se não abrir: **Services → secretaria_secretaria → Logs**. A primeira linha mostra o endereço e o modo de cada parte.

## Passo 6 — Cadastrar o número da Secretária

**Onde:** `https://secretaria.agentenpe.com.br/admin` (usuário: qualquer · senha: `ADMIN_PASSWORD`)

**Números da Secretária** → **+ Adicionar número**:

| Campo | Direto na Evolution | Pela ponte do Cloudflare |
|---|---|---|
| Nome | `Secretária principal` | `Secretária principal` |
| URL | `https://evoapi.agentenpe.com.br` | URL do Worker (`https://….workers.dev`) |
| Chave | a `AUTHENTICATION_API_KEY` da Evolution | o `PROXY_TOKEN` do Worker |
| Instância | `secretaria` (nova, com chip próprio) | um nome liberado no `INSTANCE` do Worker |
| Número público | número do chip, ex.: `5511900000000` | idem |

→ **Salvar e testar** → **QR Code** → no celular do chip: WhatsApp → **Aparelhos conectados** → **Conectar aparelho** → leia o QR.
→ **Testar envio** para o seu celular.

Pronto: mande "oi" do seu celular para o número da Secretária.

> Use uma **instância nova** com **chip próprio**. Se usar a `CheirodeVerdeOficial`, a Secretária vai responder todos os clientes da loja e o webhook atual dessa instância será substituído.

## Passo 7 — Google e Asaas (quando for vender)

- **Google Cloud Console** → Credenciais → OAuth (Web): redirect `https://secretaria.agentenpe.com.br/auth/google/callback`.
- **Asaas** → Integrações → Webhooks: URL `https://secretaria.agentenpe.com.br/billing/webhook`, token = `ASAAS_WEBHOOK_TOKEN`.

Depois de cadastrar as variáveis novas: **Stacks → secretaria → Update the stack**.

---

## Atualizar para uma versão nova

**Services → secretaria_secretaria → Update the service** → marque **Pull latest image** → **Update**.
Os dados ficam no volume `secretaria_data` e não se perdem.

## Backup

O volume `secretaria_data` guarda tudo (clientes, tarefas, números). Faça cópia dele de tempos em tempos
(ex.: **Volumes → secretaria_secretaria_data** → caminho no disco → copie o arquivo `secretaria.db`).
