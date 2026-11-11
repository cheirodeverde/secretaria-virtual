// Carrega variáveis de ambiente e fixa o fuso horário ANTES de qualquer outro módulo usar Date.
import 'dotenv/config';

process.env.TZ = process.env.TIMEZONE || process.env.TZ || 'America/Sao_Paulo';

const bool = (v, def = false) => (v === undefined || v === '' ? def : ['1', 'true', 'sim', 'yes'].includes(String(v).toLowerCase()));
const port = Number(process.env.PORT || 3000);

export const config = {
  port,
  baseUrl: (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
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
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || '',
  },

  whatsapp: {
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v23.0',
    token: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
    // Número público da Secretária (para o link wa.me do site), só dígitos
    displayNumber: (process.env.WHATSAPP_DISPLAY_NUMBER || '').replace(/\D/g, ''),
    templateLang: process.env.WHATSAPP_TEMPLATE_LANG || 'pt_BR',
    dryRun: bool(process.env.WHATSAPP_DRY_RUN) || !process.env.WHATSAPP_TOKEN,
  },

  asaas: {
    apiKey: process.env.ASAAS_API_KEY || '',
    baseUrl: process.env.ASAAS_ENV === 'production' ? 'https://api.asaas.com' : 'https://api-sandbox.asaas.com',
    webhookToken: process.env.ASAAS_WEBHOOK_TOKEN || '',
  },

  syncEveryMinutes: Number(process.env.SYNC_EVERY_MINUTES || 5),
};

if (!config.google.redirectUri) config.google.redirectUri = `${config.baseUrl}/auth/google/callback`;
if (process.env.NODE_ENV === 'production' && config.appSecret.startsWith('dev-')) {
  throw new Error('Defina APP_SECRET (32+ caracteres aleatórios) antes de rodar em produção.');
}
