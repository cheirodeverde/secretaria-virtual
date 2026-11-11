// Integração com Google Agenda por cliente (OAuth 2.0, somente leitura).
import { calendar as calendarApi } from '@googleapis/calendar';
import { OAuth2Client } from 'google-auth-library';
import { effectivePlan } from './account.js';
import { config } from './config.js';
import { sign } from './crypto.js';
import { demoEvents } from './demo-data.js';
import { getGoogleTokens, updateTenant } from './db.js';

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly', 'openid', 'email'];

export const googleConfigured = () => Boolean(config.google.clientId && config.google.clientSecret);

function client(tenantId) {
  const c = new OAuth2Client(config.google.clientId, config.google.clientSecret, config.google.redirectUri);
  if (tenantId) {
    const tokens = getGoogleTokens(tenantId);
    if (tokens) c.setCredentials(tokens);
    // O Google renova o access_token sozinho; guardamos o novo (criptografado).
    c.on('tokens', (t) => updateTenant(tenantId, { googleTokens: { ...getGoogleTokens(tenantId), ...t } }));
  }
  return c;
}

/** URL de consentimento. O "state" assinado amarra o retorno ao cliente certo. */
export function authUrl(tenantId) {
  const state = sign({ tid: tenantId, exp: Date.now() + 15 * 60000 });
  return client().generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, state });
}

export async function handleCallback(tenantId, code) {
  const c = client();
  const { tokens } = await c.getToken(code);
  let email = null;
  if (tokens.id_token) {
    const ticket = await c.verifyIdToken({ idToken: tokens.id_token, audience: config.google.clientId });
    email = ticket.getPayload()?.email || null;
  }
  return updateTenant(tenantId, { googleTokens: tokens, googleEmail: email, googleError: null });
}

/** No modo demo, "conectar" usa uma agenda fictícia. */
export const connectDemo = (tenantId) =>
  updateTenant(tenantId, { googleTokens: { demo: true }, googleEmail: 'agenda-demo@exemplo.com', googleError: null });

export async function disconnect(tenant) {
  const tokens = getGoogleTokens(tenant.id);
  if (tokens?.refresh_token || tokens?.access_token) {
    try { await client().revokeToken(tokens.refresh_token || tokens.access_token); } catch { /* já revogado */ }
  }
  return updateTenant(tenant.id, { googleTokens: null, googleEmail: null, googleError: null });
}

/** Converte um evento da API do Google para o formato interno usado pelas regras. */
export function normalizeEvent(g, calendarId = 'primary') {
  if (g.status === 'cancelled') return null;
  const me = (g.attendees || []).find((a) => a.self);
  if (me?.responseStatus === 'declined') return null;
  const allDay = Boolean(g.start?.date);
  const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const start = allDay ? parseDate(g.start.date) : new Date(g.start.dateTime);
  const end = allDay ? parseDate(g.end.date) : new Date(g.end.dateTime);
  const video = g.hangoutLink || g.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri || null;
  return {
    id: calendarId === 'primary' ? g.id : `${calendarId}:${g.id}`,
    title: (g.summary || '(sem título)').trim(),
    start,
    end,
    allDay,
    location: g.location?.trim() || null,
    meetLink: video,
    attendees: (g.attendees || []).filter((a) => !a.self && !a.resource).length,
    busy: g.transparency !== 'transparent',
    description: (g.description || '').slice(0, 300),
  };
}

/** Busca os eventos das agendas do cliente (respeitando o limite do plano). */
export async function fetchEvents(tenant, timeMin, timeMax) {
  const tokens = getGoogleTokens(tenant.id);
  if (!tokens) return [];
  if (tokens.demo) return demoEvents(timeMin);

  const cal = calendarApi({ version: 'v3', auth: client(tenant.id) });
  const ids = String(tenant.settings.calendarIds || 'primary').split(',').map((s) => s.trim()).filter(Boolean)
    .slice(0, effectivePlan(tenant).maxCalendars);
  const out = [];
  for (const calendarId of ids) {
    let pageToken;
    do {
      const { data } = await cal.events.list({
        calendarId, timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(),
        singleEvents: true, orderBy: 'startTime', maxResults: 250, pageToken,
      });
      for (const item of data.items || []) {
        const e = normalizeEvent(item, calendarId);
        if (e) out.push(e);
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
  }
  return out;
}

/** Erros que exigem o cliente reconectar (token revogado/expirado). */
export const isAuthError = (err) => /invalid_grant|unauthorized|invalid_token|401/i.test(`${err?.message} ${err?.code}`);
