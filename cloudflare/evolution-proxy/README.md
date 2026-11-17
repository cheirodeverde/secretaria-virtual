# Ponte segura Secretária → Evolution API (Cloudflare Worker)

Guarda a chave da Evolution **só no Cloudflare**. A Secretária usa outro token (`PROXY_TOKEN`) e só consegue
status, QR Code, desconectar, webhook, criar a instância e enviar texto — **só da instância configurada**.
Ela não consegue ler conversas nem mexer em outras instâncias (ex.: o WhatsApp oficial da loja).

```
Secretária ──(PROXY_TOKEN)──▶ Worker ──(chave real da Evolution)──▶ evoapi.agentenpe.com.br
```

## Instalar pelo painel do Cloudflare (sem terminal)

1. **Workers & Pages** → **Create** → **Create Worker** (Start with Hello World) → nome `secretaria-evolution-proxy` → **Deploy**.
2. **Edit code** → apague tudo → cole o conteúdo de [`worker.js`](worker.js) → **Deploy**.
3. **Settings → Variables and Secrets → Add**:

   | Tipo | Nome | Valor |
   |---|---|---|
   | Text | `EVOLUTION_URL` | `https://evoapi.agentenpe.com.br` |
   | Text | `INSTANCE` | `secretaria*` — instâncias liberadas. Vírgula separa nomes; `*` no fim libera todas que começam assim (ex.: `secretaria`, `secretaria-padaria`). |
   | **Secret** | `EVOLUTION_API_KEY` | a `AUTHENTICATION_API_KEY` da sua Evolution |
   | **Secret** | `PROXY_TOKEN` | um texto longo e aleatório (ex.: gere em um gerador de senhas, 40+ caracteres) |

   Clique em **Deploy** para salvar.
4. Abra a URL do Worker (ex.: `https://secretaria-evolution-proxy.SEU-USUARIO.workers.dev`).
   Deve aparecer `{"ok":true,"service":"evolution-proxy","instance":"secretaria*"}`.
5. Na Secretária, abra `/admin` → **Números da Secretária** → **Adicionar número**:
   - **URL**: a do Worker (ex.: `https://secretaria-evolution-proxy.SEU-USUARIO.workers.dev`)
   - **Chave**: o mesmo `PROXY_TOKEN` (**não** a chave da Evolution)
   - **Instância**: um nome liberado em `INSTANCE` (ex.: `secretaria`, `secretaria-2`)
6. Toque em **QR Code** e leia com o celular desse número. Repita o passo 5 para cada número novo.

## Se o PROXY_TOKEN vazar
Troque o segredo `PROXY_TOKEN` no Cloudflare e no servidor da Secretária. A chave da Evolution continua segura.

## Teste
`npm test` (na raiz do projeto) roda `test/proxy.test.js`: Secretária → Worker → Evolution falsa, e confere
que rotas, instâncias e tokens não permitidos são recusados.
