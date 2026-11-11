// Situação da conta (teste, ativa, inadimplente, cancelada) e links de acesso.
import { config } from './config.js';
import { randomToken, sha256 } from './crypto.js';
import { saveLoginToken } from './db.js';

/**
 * ok          → recebe tudo
 * grace       → inadimplente dentro da carência (recebe tudo, com lembrete de pagamento)
 * blocked     → teste vencido, inadimplência além da carência ou cancelada: sem avisos, conversa só sobre assinatura
 */
export function accessState(t, now = new Date()) {
  if (t.status === 'active') return 'ok';
  if (t.status === 'trial') return new Date(t.trialEndsAt) > now ? 'ok' : 'blocked';
  if (t.status === 'past_due') {
    const since = new Date(t.pastDueSince || now);
    return now - since < config.graceDays * 864e5 ? 'grace' : 'blocked';
  }
  return 'blocked';
}

export function trialDaysLeft(t, now = new Date()) {
  if (t.status !== 'trial') return null;
  return Math.max(0, Math.ceil((new Date(t.trialEndsAt) - now) / 864e5));
}

export const statusLabel = (t, now = new Date()) => ({
  trial: accessState(t, now) === 'ok' ? `teste grátis (${trialDaysLeft(t, now)} dia(s) restantes)` : 'teste grátis encerrado',
  active: `ativa — plano ${config.plans[t.plan]?.name || t.plan}`,
  past_due: 'pagamento pendente',
  canceled: 'cancelada',
}[t.status] || t.status);

/** Link mágico de uso único (15 min) que abre o painel já autenticado. */
export function magicLink(tenantId, next = '/app') {
  const token = randomToken();
  saveLoginToken(sha256(token), tenantId, 15);
  return `${config.baseUrl}/entrar?t=${token}&next=${encodeURIComponent(next)}`;
}

export const planOf = (t) => config.plans[t.plan] || config.plans.essencial;
/** Durante o teste, o cliente experimenta tudo do Profissional. */
export const effectivePlan = (t) => (t.status === 'trial' ? config.plans.profissional : planOf(t));
