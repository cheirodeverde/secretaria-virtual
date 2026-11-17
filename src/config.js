// Carrega variáveis de ambiente e fixa o fuso horário ANTES de qualquer outro módulo usar Date.
import 'dotenv/config';
import crypto from 'node:crypto';

process.env.TZ = process.env.TIMEZONE || process.env.TZ || 'America/Sao_Paulo';

const bool = (v, def = false) => (v === undefined || v === '' ? def : ['1', 'true', 'sim', 'yes'].includes(String(v).toLowerCase()));
const port = Number(process.env.PORT || 3000);
// No GitHub Codespaces o endereço público é https://<codespace>-<porta>.<domínio>
const codespaceUrl = process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN
  ? `https://${process.env.CODESPACE_NAME}-${port}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}` : null;

export const config = {
  port,
  baseUrl: (process.env.BASE_URL || codespaceUrl || `http://localhost:${port}`).replace(/\/$/, ''),
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
    evolution: {
      url: (process.env.EVOLUTION_API_URL || '').trim().replace(/\/$/, ''),
      apiKey: process.env.EVOLUTION_API_KEY || '',
      instance: process.env.EVOLUTION_INSTANCE || 'secretaria',
      // Segredo que a Evolution manda no header x-webhook-token (o sistema configura isso sozinho)
      webhookToken: process.env.EVOLUTION_WEBHOOK_TOKEN || '',
      // Opcional: URL do webhook vista pela Evolution, se for diferente de BASE_URL/webhook/evolution (ex.: rede interna do Docker)
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
    dryRun: false, // calculado abaixo
  },

  asaas: {
    apiKey: process.env.ASAAS_API_KEY || '',
    baseUrl: process.env.ASAAS_ENV === 'production' ? 'https://api.asaas.com' : 'https://api-sandbox.asaas.com',
    webhookToken: process.env.ASAAS_WEBHOOK_TOKEN || '',
  },

  get calendarWrite() { return this.google.calendarWrite; },
  syncEveryMinutes: Number(process.env.SYNC_EVERY_MINUTES || 5),
};

{
  const w = config.whatsapp;
  // Sem EVOLUTION_WEBHOOK_TOKEN, deriva um segredo estável do APP_SECRET (o sistema o envia à Evolution ao conectar).
  if (!w.evolution.webhookToken) w.evolution.webhookToken = crypto.createHash('sha256').update(`evolution-webhook:${config.appSecret}`).digest('hex').slice(0, 40);
  const configured = w.provider === 'meta' ? Boolean(w.token && w.phoneNumberId) : Boolean(w.evolution.url && w.evolution.apiKey);
  // Sem credenciais do provedor escolhido, nada é enviado de verdade (simulador do /admin).
  w.dryRun = bool(process.env.WHATSAPP_DRY_RUN) || !configured;
}

if (!config.google.redirectUri) config.google.redirectUri = `${config.baseUrl}/auth/google/callback`;
if (process.env.NODE_ENV === 'production' && config.appSecret.startsWith('dev-')) {
  throw new Error('Defina APP_SECRET (32+ caracteres aleatórios) antes de rodar em produção.');
}
