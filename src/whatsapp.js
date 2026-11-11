// WhatsApp Cloud API (Meta). Um único número — o da Secretária — conversa com todos os clientes.
//
// Janela de 24h: texto livre (e botões) só até 24h depois da última mensagem do cliente.
// Fora dela, apenas modelos (templates) aprovados.
import crypto from 'node:crypto';
import { config } from './config.js';

const WINDOW_MS = 24 * 3600e3 - 5 * 60e3; // margem de 5 min

export const windowOpen = (tenant, now = new Date()) =>
  Boolean(tenant?.lastInboundAt) && now - new Date(tenant.lastInboundAt) < WINDOW_MS;

export const whatsappConfigured = () => Boolean(config.whatsapp.token && config.whatsapp.phoneNumberId);

/** Parâmetros de template não podem ter quebra de linha, tab ou 4+ espaços seguidos. */
export const cleanParam = (s) =>
  String(s ?? '').replace(/[*_~]/g, '').replace(/[\r\n\t]+/g, ' · ').replace(/ {2,}/g, ' ').trim().slice(0, 900) || '—';

// Caixa de saída da simulação (modo sem token): usada pelo simulador do painel admin e pelos testes.
export const outbox = [];

async function post(payload) {
  if (config.whatsapp.dryRun) {
    outbox.push({ ...payload, at: new Date().toISOString() });
    if (outbox.length > 500) outbox.shift();
    if (process.env.NODE_ENV !== 'test') {
      const body = payload.type === 'text' ? payload.text.body
        : payload.type === 'interactive' ? `${payload.interactive.body.text}\n[${payload.interactive.action.buttons.map((b) => b.reply.title).join('] [')}]`
          : `(modelo ${payload.template.name}) ${payload.template.components?.[0]?.parameters?.map((p) => p.text).join(' | ') || ''}`;
      console.log(`\n[WhatsApp simulado → ${payload.to}]\n${body}`);
    }
    return { dryRun: true };
  }
  const res = await fetch(`https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.whatsapp.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body?.error?.message || `WhatsApp API ${res.status}`);
    err.code = body?.error?.code;
    throw err;
  }
  return body;
}

export const sendText = (to, body) => post({ to, type: 'text', text: { preview_url: true, body: String(body).slice(0, 4096) } });

export const sendTemplate = (to, name, params = []) => post({
  to,
  type: 'template',
  template: {
    name,
    language: { code: config.whatsapp.templateLang },
    components: params.length ? [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: cleanParam(p) })) }] : [],
  },
});

/** Até 3 botões de resposta rápida (título com no máximo 20 caracteres). */
export const sendButtons = (to, body, buttons) => post({
  to,
  type: 'interactive',
  interactive: {
    type: 'button',
    body: { text: String(body).slice(0, 1024) },
    action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) },
  },
});

/**
 * Envia uma mensagem escolhendo o formato: botões/texto (janela aberta) ou modelo (janela fechada).
 * Retorna { via, dryRun }.
 */
export async function deliver(tenant, msg, now = new Date()) {
  const open = windowOpen(tenant, now);
  try {
    if (open || !msg.template) {
      if (msg.buttons?.length) {
        const r = await sendButtons(tenant.phone, msg.text, msg.buttons);
        return { via: 'botoes', dryRun: Boolean(r.dryRun) };
      }
      const r = await sendText(tenant.phone, msg.text);
      return { via: 'texto', dryRun: Boolean(r.dryRun) };
    }
    const r = await sendTemplate(tenant.phone, msg.template.name, msg.template.params);
    return { via: `template:${msg.template.name}`, dryRun: Boolean(r.dryRun) };
  } catch (err) {
    // 131047 = janela de 24h expirou → reenvia como modelo
    if (open && err.code === 131047 && msg.template) {
      const r = await sendTemplate(tenant.phone, msg.template.name, msg.template.params);
      return { via: `template:${msg.template.name}`, dryRun: Boolean(r.dryRun) };
    }
    throw err;
  }
}

/** Valida a assinatura X-Hub-Signature-256 enviada pela Meta no webhook. */
export function validSignature(rawBody, header) {
  if (!config.whatsapp.appSecret) return process.env.NODE_ENV !== 'production';
  if (!header || !rawBody) return false;
  const expected = `sha256=${crypto.createHmac('sha256', config.whatsapp.appSecret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Extrai mensagens (texto, botões, listas) do payload do webhook. Botões viram "btn:<acao>:<id>". */
export function extractMessages(payload) {
  const out = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of v.messages || []) {
        const text = m.interactive?.button_reply?.id || m.interactive?.list_reply?.id || m.text?.body || m.button?.text || '';
        out.push({ id: m.id, from: m.from, text, type: m.type, profileName: names[m.from] || null });
      }
    }
  }
  return out;
}
