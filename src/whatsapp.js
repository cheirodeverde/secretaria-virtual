// WhatsApp: um único número — o da Secretária — conversa com todos os clientes.
//
// Provedor padrão: Evolution API (WHATSAPP_PROVIDER=evolution), conectada por QR Code no painel /admin.
//   • Não há janela de 24h nem modelos: tudo sai como texto.
//   • Botões não são confiáveis em API não oficial: viram uma linha "Responda SIM ou NÃO".
// Alternativa: API oficial da Meta (WHATSAPP_PROVIDER=meta), com modelos e janela de 24h.
// Sem credenciais (ou WHATSAPP_DRY_RUN=true) nada é enviado: as mensagens vão para o simulador do /admin.
import crypto from 'node:crypto';
import { config } from './config.js';

const W = config.whatsapp;
const E = W.evolution;
const WINDOW_MS = 24 * 3600e3 - 5 * 60e3; // margem de 5 min

export const isEvolution = () => W.provider !== 'meta';

export const windowOpen = (tenant, now = new Date()) =>
  isEvolution() || (Boolean(tenant?.lastInboundAt) && now - new Date(tenant.lastInboundAt) < WINDOW_MS);

export const whatsappConfigured = () => (isEvolution()
  ? Boolean(E.url && E.apiKey && E.instance)
  : Boolean(W.token && W.phoneNumberId));

/** Parâmetros de template (Meta) não podem ter quebra de linha, tab ou 4+ espaços seguidos. */
export const cleanParam = (s) =>
  String(s ?? '').replace(/[*_~]/g, '').replace(/[\r\n\t]+/g, ' · ').replace(/ {2,}/g, ' ').trim().slice(0, 900) || '—';

// Caixa de saída da simulação: usada pelo simulador do painel admin e pelos testes.
export const outbox = [];

// ================================================================== Evolution API

/** Chamada à Evolution API (autenticação pela apikey global). */
export async function evolution(method, path, body) {
  if (!E.url || !E.apiKey) throw new Error('Evolution API não configurada (EVOLUTION_API_URL e EVOLUTION_API_KEY).');
  let res;
  try {
    res = await fetch(`${E.url}${path}`, {
      method,
      headers: { apikey: E.apiKey, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new Error(`Não consegui falar com a Evolution API em ${E.url} (${err.cause?.code || err.message}).`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const m = data?.response?.message;
    const err = new Error((Array.isArray(m) ? m.flat().join('; ') : m) || data?.message || data?.error || `Evolution API ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const inst = () => encodeURIComponent(E.instance);
export const evolutionWebhookUrl = () => E.webhookUrl || `${config.baseUrl}/webhook/evolution`;

function webhookConfig() {
  return {
    enabled: true,
    url: evolutionWebhookUrl(),
    byEvents: false,
    base64: false,
    headers: E.webhookToken ? { 'x-webhook-token': E.webhookToken } : {},
    events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
  };
}

/** Estado da conexão: 'open' | 'connecting' | 'close' | 'not_found'. */
export async function evolutionState() {
  try {
    const d = await evolution('GET', `/instance/connectionState/${inst()}`);
    return d?.instance?.state || d?.state || 'close';
  } catch (err) {
    if (err.status === 404 || err.status === 400) return 'not_found';
    throw err;
  }
}

/** Número e nome do WhatsApp conectado (quando houver). */
export async function evolutionInfo() {
  try {
    const d = await evolution('GET', `/instance/fetchInstances?instanceName=${inst()}`);
    const i = Array.isArray(d) ? d[0] : d?.instance || d;
    return { number: String(i?.ownerJid || i?.owner || '').split('@')[0] || null, profileName: i?.profileName || null, profilePicUrl: i?.profilePicUrl || null };
  } catch { return {}; }
}

/** Cria a instância se não existir e (re)aponta o webhook para este sistema. */
export async function evolutionEnsure() {
  if (await evolutionState() === 'not_found') {
    await evolution('POST', '/instance/create', {
      instanceName: E.instance, integration: 'WHATSAPP-BAILEYS', qrcode: true, groupsIgnore: true, alwaysOnline: false,
      readMessages: true, webhook: webhookConfig(),
    });
  }
  await evolution('POST', `/webhook/set/${inst()}`, { webhook: webhookConfig() });
}

/** Pede o QR Code (ou devolve que já está conectado). */
export async function evolutionConnect() {
  await evolutionEnsure();
  const d = await evolution('GET', `/instance/connect/${inst()}`);
  if (d?.instance?.state === 'open') return { state: 'open' };
  const b64 = d?.base64 || null;
  return { state: 'connecting', qr: b64 && !b64.startsWith('data:') ? `data:image/png;base64,${b64}` : b64, pairingCode: d?.pairingCode || null };
}

export const evolutionLogout = () => evolution('DELETE', `/instance/logout/${inst()}`);

/** Valida o token que a Evolution manda no header (configurado no webhook). */
export function validEvolutionToken(req) {
  if (!E.webhookToken) return process.env.NODE_ENV !== 'production';
  const got = String(req.get('x-webhook-token') || req.query?.token || '');
  const a = Buffer.from(got);
  const b = Buffer.from(E.webhookToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const MEDIA = { audioMessage: 'audio', pttMessage: 'audio', imageMessage: 'image', videoMessage: 'video', documentMessage: 'document', stickerMessage: 'sticker', locationMessage: 'location', contactMessage: 'contacts' };

/**
 * Extrai mensagens recebidas do webhook da Evolution (evento messages.upsert).
 * Ignora mensagens enviadas pelo próprio número, grupos, status e canais.
 */
export function extractEvolution(payload) {
  const event = String(payload?.event || '').toLowerCase().replace(/_/g, '.');
  if (event !== 'messages.upsert') return [];
  const list = Array.isArray(payload.data) ? payload.data : payload.data?.messages || [payload.data];
  const out = [];
  for (const d of list) {
    const key = d?.key || {};
    if (!key.remoteJid || key.fromMe) continue;
    // A Evolution troca "@lid" pelo número real quando sabe (remoteJidAlt); sem número real, não dá para responder.
    const jid = key.remoteJid.endsWith('@lid') && key.remoteJidAlt ? key.remoteJidAlt : key.remoteJid;
    if (!jid.endsWith('@s.whatsapp.net')) continue;
    const m = d.message || {};
    const text = m.conversation || m.extendedTextMessage?.text || m.buttonsResponseMessage?.selectedButtonId
      || m.listResponseMessage?.singleSelectReply?.selectedRowId || m.templateButtonReplyMessage?.selectedId
      || m.imageMessage?.caption || '';
    const kind = Object.keys(MEDIA).find((k) => m[k]) || (d.messageType && MEDIA[d.messageType]);
    out.push({ id: key.id, from: jid.split('@')[0], text, type: kind ? MEDIA[kind] || kind : 'text', profileName: d.pushName || null });
  }
  return out;
}

/** Atualização de conexão (connection.update) → 'open' | 'close' | 'connecting' | null. */
export const extractConnection = (payload) =>
  (String(payload?.event || '').toLowerCase().replace(/_/g, '.') === 'connection.update' ? payload?.data?.state || null : null);

// ================================================================== envio

async function post(payload) {
  if (W.dryRun) {
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
  if (isEvolution()) {
    if (payload.type !== 'text') throw new Error('Evolution: só texto é suportado');
    // delay = "digitando…" por 1 s: deixa o envio com ritmo humano (menos risco de bloqueio)
    return evolution('POST', `/message/sendText/${inst()}`, { number: payload.to, text: payload.text.body, delay: 1000, linkPreview: true });
  }
  const res = await fetch(`https://graph.facebook.com/${W.apiVersion}/${W.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${W.token}`, 'Content-Type': 'application/json' },
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
    language: { code: W.templateLang },
    components: params.length ? [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: cleanParam(p) })) }] : [],
  },
});

/** Até 3 botões de resposta rápida (só Meta). */
export const sendButtons = (to, body, buttons) => post({
  to,
  type: 'interactive',
  interactive: {
    type: 'button',
    body: { text: String(body).slice(0, 1024) },
    action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title.slice(0, 20) } })) },
  },
});

/** Texto que substitui os botões quando o provedor não tem botões. */
export const buttonsAsText = (msg) => msg.buttonsFallback
  || `Responda ${msg.buttons.map((b) => `*${(b.reply || b.title).replace(/^[^\p{L}\p{N}]+/u, '').toUpperCase()}*`).join(' ou ')}.`;

/**
 * Envia uma mensagem escolhendo o formato.
 * Evolution: sempre texto. Meta: botões/texto (janela aberta) ou modelo (janela fechada).
 * Retorna { via, dryRun }.
 */
export async function deliver(tenant, msg, now = new Date()) {
  if (isEvolution()) {
    const text = msg.buttons?.length ? `${msg.text}\n\n${buttonsAsText(msg)}` : msg.text;
    const r = await sendText(tenant.phone, text);
    return { via: 'texto', dryRun: Boolean(r?.dryRun) };
  }
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

// ================================================================== Meta (webhook)

/** Valida a assinatura X-Hub-Signature-256 enviada pela Meta no webhook. */
export function validSignature(rawBody, header) {
  if (!W.appSecret) return process.env.NODE_ENV !== 'production';
  if (!header || !rawBody) return false;
  const expected = `sha256=${crypto.createHmac('sha256', W.appSecret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Extrai mensagens (texto, botões, listas) do payload do webhook da Meta. Botões viram "btn:<acao>:<id>". */
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
