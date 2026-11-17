// Carrega variáveis de ambiente e fixa o fuso horário ANTES de qualquer outro módulo usar Date.
import 'dotenv/config';

process.env.TZ = process.env.TIMEZONE || process.env.TZ || 'America/Sao_Paulo';

const bool = (v, def = false) => (v === undefined || v === '' ? def : ['1', 'true', 'sim', 'yes'].includes(String(v).toLowerCase()));
const port = Number(process.env.PORT || 3000);
// No GitHub Codespaces o endereço público é https://<codespace>-<porta>.<domínio>
const codespaceUrl = process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
  ? `https://${process.env.CODESPACE_NAME}-${port}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}` : null;

export const config = {
  port,
  // Railway informa o domínio público sozinho (RAILWAY_PUBLIC_DOMAIN)
  baseUrl: (process.env.BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN && `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`)
    || codespaceUrl || `http://localhost:${port}`).replace(/\/$/, ''),
  timezone: process.env.TZ,
  dbFile: process.env.DB_FILE || 'data/secretaria.db',
  // Segredo usado para assinar sessões e criptografar tokens do Google. OBRIGATÓRIO em produção.
  appSecret: process.env.APP_SECRET || 'dev-inseguro-troque-este-segredo',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  demoMode: bool(process.env.DEMO_MODE),
  trialDays: Number(process.env.TRIAL_DAYS || 14),
  graceDays: Number(process.env.GRACE_DAYS || 3),
  productName: process.env.PRODUCT_NAME || 'Secretária de Bolso',

  plans: {
    essencial: { name: 'Essencial', price: Number(process.env.PRICE_ESSENCIAL || 49), maxCalendars: 1, maxCustomRules: 3 },
    profissional: { name: 'Profissional', price: Number(process.env.PRICE_PROFISSIONAL || 89), maxCalendars: 5, maxCustomRules: 999 },
  },

  google: {
    // Permite criar/remarcar/cancelar compromissos (escopo calendar.events). false = só leitura, como na v0.2.
    calendarWrite: bool(process.env.CALENDAR_WRITE, true),
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || '',
  },

  whatsapp: {
    // evolution (padrão) = Evolution API conectada por QR Code · meta = API oficial do WhatsApp Cloud
    provider: (process.env.WHATSAPP_PROVIDER || 'evolution').trim().toLowerCase() === 'meta' ? 'meta' : 'evolution',
    // Opcional: um primeiro número vindo do .env (importado para o cadastro do /admin ao iniciar).
    // O normal é cadastrar os números direto no /admin → "Números da Secretária".
    evolution: {
      url: (process.env.EVOLUTION_API_URL || '').trim().replace(/\/$/, ''),
      apiKey: process.env.EVOLUTION_API_KEY || '',
      instance: process.env.EVOLUTION_INSTANCE || 'secretaria',
      webhookToken: process.env.EVOLUTION_WEBHOOK_TOKEN || '',
      // Opcional: endereço-base do webhook visto pela Evolution, se diferente de BASE_URL/webhook/evolution (ex.: rede interna do Docker).
      // O sistema acrescenta /<id do número>.
      webhookUrl: process.env.EVOLUTION_WEBHOOK_URL || '',
    },
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v23.0',
    token: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
    // Número público da Secretária (para o link wa.me do site), só dígitos
    displayNumber: (process.env.WHATSAPP_DISPLAY_NUMBER || '').replace(/\D/g, ''),
    templateLang: process.env.WHATSAPP_TEMPLATE_LANG || 'pt_BR',
  },

  asaas: {
    apiKey: process.env.ASAAS_API_KEY || '',
    baseUrl: process.env.ASAAS_ENV === 'production' ? 'https://api.asaas.com' : 'https://api-sandbox.asaas.com',
    webhookToken: process.env.ASAAS_WEBHOOK_TOKEN || '',
  },

  get calendarWrite() { return this.google.calendarWrite; },
  syncEveryMinutes: Number(process.env.SYNC_EVERY_MINUTES || 5),
};

// true = nunca envia de verdade (simulador do /admin). Sem número cadastrado também é simulação.
config.whatsapp.forceDryRun = bool(process.env.WHATSAPP_DRY_RUN);

if (!config.google.redirectUri) config.google.redirectUri = `${config.baseUrl}/auth/google/callback`;
if (process.env.NODE_ENV === 'production' && config.appSecret.startsWith('dev-')) {
  throw new Error('Defina APP_SECRET (32+ caracteres aleatórios) antes de rodar em produção.');
}
