// Integração com Google Agenda por cliente (OAuth 2.0).
// Leitura dos eventos + (com CALENDAR_WRITE=true) criar, remarcar e cancelar compromissos.
import crypto from 'node:crypto';
import { calendar as calendarApi } from '@googleapis/calendar';
import { OAuth2Client } from 'google-auth-library';
import { effectivePlan } from './account.js';
import { config } from './config.js';
import { sign } from './crypto.js';
import { demoEvents } from './demo-data.js';
import { getDemoOverrides, getGoogleTokens, setDemoOverride, updateTenant } from './db.js';
import { dayKey } from './time.js';

const READ_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
// calendar.events = ver e editar eventos (não mexe nas configurações nem no compartilhamento das agendas).
const WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const SCOPES = [config.calendarWrite ? WRITE_SCOPE : READ_SCOPE, 'openid', 'email'];

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
  return client().generateAuthUrl({ access_type: 'offline', prompt: 'consent', include_granted_scopes: true, scope: SCOPES, state });
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

/** O cliente deu permissão de edição? (quem conectou na v0.2 só deu leitura e precisa reconectar) */
export function canWrite(tenant) {
  if (!config.calendarWrite) return false;
  const tokens = getGoogleTokens(tenant.id);
  if (!tokens) return false;
  if (tokens.demo) return true;
  const scopes = String(tokens.scope || '').split(/\s+/);
  return scopes.includes(WRITE_SCOPE) || scopes.includes('https://www.googleapis.com/auth/calendar');
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
  // Convite de outra pessoa: só o organizador pode remarcar/cancelar para todos.
  const invited = !g.organizer?.self && (g.attendees || []).some((a) => a.self && !a.organizer);
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
    calendarId,
    mine: !invited || Boolean(g.guestsCanModify),
    organizer: invited ? (g.organizer?.displayName || g.organizer?.email || null) : null,
    recurring: Boolean(g.recurringEventId),
    bySecretaria: g.extendedProperties?.private?.secretaria === '1',
    htmlLink: g.htmlLink || null,
  };
}

/** Busca os eventos das agendas do cliente (respeitando o limite do plano). */
export async function fetchEvents(tenant, timeMin, timeMax) {
  const tokens = getGoogleTokens(tenant.id);
  if (!tokens) return [];
  if (tokens.demo) return demoCalendar(tenant.id, timeMin, timeMax);

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

// ================================================================== escrita na agenda

/** Agenda onde os novos compromissos são criados. */
export const writeCalendarId = (tenant) => String(tenant.settings.writeCalendarId || '').trim()
  || String(tenant.settings.calendarIds || 'primary').split(',').map((x) => x.trim()).find(Boolean) || 'primary';

/** "agenda@grupo:abc123" → { calendarId, eventId } (eventos da agenda principal não têm prefixo). */
export function splitEventId(id) {
  const i = String(id).indexOf(':');
  return i < 0 ? { calendarId: 'primary', eventId: String(id) } : { calendarId: id.slice(0, i), eventId: id.slice(i + 1) };
}

/** Erro amigável para mostrar ao cliente, preservando o original para o log. */
export class CalendarError extends Error {
  constructor(kind, message, cause) { super(message); this.kind = kind; this.cause = cause; }
}

function wrapError(err) {
  const status = err?.code || err?.status || err?.response?.status;
  if (isAuthError(err)) return new CalendarError('auth', 'Perdi o acesso à sua Google Agenda. Reconecte para continuar.', err);
  if (status === 403) return new CalendarError('forbidden', 'O Google não deixou fazer essa alteração (sem permissão de edição nessa agenda).', err);
  if (status === 404 || status === 410) return new CalendarError('gone', 'Esse compromisso não existe mais na sua agenda.', err);
  return new CalendarError('other', 'O Google não respondeu agora. Tente de novo em alguns minutos.', err);
}

function timeBody(e) {
  if (e.allDay) return { start: { date: dayKey(e.start) }, end: { date: dayKey(e.end) } };
  return {
    start: { dateTime: e.start.toISOString(), timeZone: config.timezone },
    end: { dateTime: e.end.toISOString(), timeZone: config.timezone },
  };
}

const api = (tenant) => calendarApi({ version: 'v3', auth: client(tenant.id) });
const isDemo = (tenant) => Boolean(getGoogleTokens(tenant.id)?.demo);
const notifyGuests = (e) => ((e.attendees || 0) > 0 ? 'all' : 'none');

/**
 * Cria um compromisso. draft = { title, start, end, allDay, location, online, description }
 * Retorna o evento no formato interno.
 */
export async function createEvent(tenant, draft) {
  const calendarId = writeCalendarId(tenant);
  if (isDemo(tenant)) {
    const id = `demo_${crypto.randomUUID().slice(0, 8)}`;
    const e = {
      id, title: draft.title, start: draft.start, end: draft.end, allDay: Boolean(draft.allDay), location: draft.location || null,
      meetLink: draft.online ? `https://meet.google.com/demo-${id.slice(5, 9)}` : null, attendees: 0, busy: true,
      description: draft.description || '', calendarId: 'primary', mine: true, organizer: null, recurring: false, bySecretaria: true, htmlLink: null,
    };
    setDemoOverride(tenant.id, id, e);
    return e;
  }
  try {
    const { data } = await api(tenant).events.insert({
      calendarId,
      conferenceDataVersion: draft.online ? 1 : 0,
      sendUpdates: 'none',
      requestBody: {
        summary: draft.title,
        location: draft.location || undefined,
        description: draft.description || undefined,
        ...timeBody(draft),
        ...(draft.online ? { conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {}),
        extendedProperties: { private: { secretaria: '1' } },
      },
    });
    return normalizeEvent(data, calendarId);
  } catch (err) { throw wrapError(err); }
}

/** Muda o horário de um compromisso (mantém título, local, convidados). */
export async function moveEvent(tenant, event, start, end) {
  if (isDemo(tenant)) {
    const e = { ...event, start, end };
    setDemoOverride(tenant.id, event.id, e);
    return e;
  }
  const { calendarId, eventId } = splitEventId(event.id);
  try {
    const { data } = await api(tenant).events.patch({
      calendarId, eventId, sendUpdates: notifyGuests(event), requestBody: timeBody({ ...event, start, end }),
    });
    return normalizeEvent(data, calendarId);
  } catch (err) { throw wrapError(err); }
}

/** Cancela (apaga) um compromisso. Convidados são avisados pelo próprio Google. */
export async function cancelEvent(tenant, event) {
  if (isDemo(tenant)) { setDemoOverride(tenant.id, event.id, null); return; }
  const { calendarId, eventId } = splitEventId(event.id);
  try {
    await api(tenant).events.delete({ calendarId, eventId, sendUpdates: notifyGuests(event) });
  } catch (err) {
    if (err?.code === 410) return; // já tinha sido apagado
    throw wrapError(err);
  }
}

/** Agenda demo: eventos de exemplo + o que o cliente criou/remarcou/cancelou nela. */
function demoCalendar(tenantId, timeMin, timeMax) {
  const overrides = new Map(getDemoOverrides(tenantId).map((o) => [o.id, o.data]));
  const revive = (e) => ({ ...e, start: new Date(e.start), end: new Date(e.end) });
  const base = demoEvents(timeMin).map((e) => ({ calendarId: 'primary', mine: true, organizer: null, recurring: false, bySecretaria: false, ...e }));
  const out = [];
  for (const e of base) {
    if (!overrides.has(e.id)) out.push(e);
    else if (overrides.get(e.id)) out.push(revive(overrides.get(e.id)));
  }
  for (const [id, data] of overrides) if (data && !base.some((e) => e.id === id)) out.push(revive(data));
  return out.filter((e) => e.end > timeMin && e.start < timeMax).sort((a, b) => a.start - b.start);
}
