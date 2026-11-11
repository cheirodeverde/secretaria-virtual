// Assinatura recorrente via Asaas (Pix, Pix Automático, cartão, boleto).
// A situação da conta só muda pelo webhook — nunca pela resposta síncrona da API.
import { config } from './config.js';
import { safeEqual } from './crypto.js';
import { firstTimeBillingEvent, getTenant, getTenantBySubscription, updateTenant } from './db.js';
import { dispatch } from './dispatcher.js';

export const billingConfigured = () => Boolean(config.asaas.apiKey);

async function asaas(method, path, body) {
  const res = await fetch(`${config.asaas.baseUrl}${path}`, {
    method,
    headers: { access_token: config.asaas.apiKey, 'Content-Type': 'application/json', 'User-Agent': 'secretaria-de-bolso' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.errors?.[0]?.description || `Asaas ${res.status}`);
  return data;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Cria (ou reaproveita) o cliente e a assinatura no Asaas e devolve o link da primeira cobrança.
 * Sem ASAAS_API_KEY, devolve um link de demonstração.
 */
export async function startSubscription(tenant, { plan, cpfCnpj, email }) {
  const p = config.plans[plan];
  if (!p) throw new Error('Plano inválido');
  const doc = String(cpfCnpj || '').replace(/\D/g, '');
  if (![11, 14].includes(doc.length)) throw new Error('Informe um CPF ou CNPJ válido');
  updateTenant(tenant.id, { plan, cpfCnpj: doc, email: email || tenant.email });

  if (!billingConfigured()) return { url: `${config.baseUrl}/app?assinatura=demo#conta`, demo: true };

  let customerId = tenant.asaasCustomerId;
  if (!customerId) {
    const c = await asaas('POST', '/v3/customers', {
      name: tenant.name || `Cliente ${tenant.id}`, cpfCnpj: doc, email: email || undefined,
      mobilePhone: tenant.phone.replace(/^55/, ''), externalReference: String(tenant.id), notificationDisabled: false,
    });
    customerId = c.id;
  }
  if (tenant.asaasSubscriptionId) {
    try { await asaas('DELETE', `/v3/subscriptions/${tenant.asaasSubscriptionId}`); } catch { /* já removida */ }
  }
  const sub = await asaas('POST', '/v3/subscriptions', {
    customer: customerId, billingType: 'UNDEFINED', value: p.price, nextDueDate: today(), cycle: 'MONTHLY',
    description: `${config.productName} — plano ${p.name}`, externalReference: String(tenant.id),
  });
  updateTenant(tenant.id, { asaasCustomerId: customerId, asaasSubscriptionId: sub.id });
  const payments = await asaas('GET', `/v3/subscriptions/${sub.id}/payments`);
  const url = payments?.data?.[0]?.invoiceUrl;
  if (!url) throw new Error('Cobrança criada, mas o link ainda não está disponível. Tente de novo em instantes.');
  return { url };
}

export const validWebhookToken = (header) => Boolean(config.asaas.webhookToken) && safeEqual(header, config.asaas.webhookToken);

/** Processa um evento do webhook do Asaas. Idempotente pelo id do evento. */
export async function handleBillingEvent(body, now = new Date()) {
  if (body?.id && !firstTimeBillingEvent(body.id)) return { ignored: 'duplicado' };
  const payment = body?.payment;
  const subscription = body?.subscription;
  const subId = payment?.subscription || subscription?.id;
  const ref = payment?.externalReference || subscription?.externalReference;
  let tenant = (subId && getTenantBySubscription(subId)) || (ref && getTenant(Number(ref)));
  if (!tenant) return { ignored: 'cliente não encontrado' };

  switch (body.event) {
    case 'PAYMENT_CONFIRMED':
    case 'PAYMENT_RECEIVED': {
      const wasActive = tenant.status === 'active';
      tenant = updateTenant(tenant.id, { status: 'active', pastDueSince: null });
      if (!wasActive) {
        await dispatch(tenant, {
          key: `pay:${payment?.id || now.toISOString()}`, kind: 'conta', account: true,
          text: `✅ Pagamento confirmado! Sua assinatura do plano ${config.plans[tenant.plan]?.name} está ativa. Obrigado pela confiança. 💚`,
          template: { name: 'sec_assinatura', params: ['seu pagamento foi confirmado e sua assinatura está ativa.', 'o painel'] },
        }, now);
      }
      return { status: 'active' };
    }
    case 'PAYMENT_OVERDUE': {
      if (tenant.status !== 'past_due') tenant = updateTenant(tenant.id, { status: 'past_due', pastDueSince: now.toISOString() });
      await dispatch(tenant, {
        key: `overdue:${payment?.id}`, kind: 'conta', account: true,
        text: `⚠️ Não identificamos o pagamento da sua assinatura. Seus avisos continuam por mais ${config.graceDays} dias.\n\nPague por aqui: ${payment?.invoiceUrl || 'responda ASSINATURA'}`,
        template: { name: 'sec_assinatura', params: [`não identificamos o pagamento da mensalidade. Seus avisos continuam por mais ${config.graceDays} dias.`, payment?.invoiceUrl || 'o painel'] },
      }, now);
      return { status: 'past_due' };
    }
    case 'SUBSCRIPTION_DELETED':
    case 'SUBSCRIPTION_INACTIVATED':
      updateTenant(tenant.id, { status: 'canceled' });
      return { status: 'canceled' };
    default:
      return { ignored: body.event };
  }
}
