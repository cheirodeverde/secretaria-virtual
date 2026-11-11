// Banco de dados (SQLite embutido no Node 22+). Todas as consultas são filtradas por tenant_id.
// Para escalar (500+ clientes), migrar para Postgres mantendo estas mesmas funções.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { decrypt, encrypt } from './crypto.js';
import { DEFAULT_SETTINGS } from './rules/analysis.js';

let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,
  name TEXT,
  email TEXT,
  cpf_cnpj TEXT,
  plan TEXT NOT NULL DEFAULT 'essencial',
  status TEXT NOT NULL DEFAULT 'trial',          -- trial | active | past_due | canceled
  trial_ends_at TEXT,
  past_due_since TEXT,
  onboarding TEXT NOT NULL DEFAULT 'ask_name',   -- ask_name | connect_google | done
  settings TEXT NOT NULL DEFAULT '{}',
  ctx TEXT NOT NULL DEFAULT '{}',                -- contexto curto da conversa
  google_tokens TEXT,                            -- criptografado (AES-256-GCM)
  google_email TEXT,
  google_error TEXT,
  last_sync_at TEXT,
  last_inbound_at TEXT,
  asaas_customer_id TEXT,
  asaas_subscription_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS events_cache (
  tenant_id INTEGER PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  events TEXT NOT NULL,
  synced_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  num INTEGER NOT NULL,                          -- número curto exibido ao cliente ("feito 2")
  title TEXT NOT NULL,
  due_at TEXT,
  has_time INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',           -- open | done | deleted
  reminded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  done_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON tasks(tenant_id, status);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  system_key TEXT,                               -- preenchido nas regras do sistema; NULL nas personalizadas
  name TEXT NOT NULL,
  trigger TEXT NOT NULL,                         -- before_event | after_event | daily | system
  params TEXT NOT NULL DEFAULT '{}',             -- { offsetMin, time, titleContains, weekdays }
  script TEXT NOT NULL,                          -- roteiro com {variaveis}
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(tenant_id, system_key)
);
CREATE TABLE IF NOT EXISTS sent (
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
CREATE TABLE IF NOT EXISTS queue (
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  alert TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  dir TEXT NOT NULL,                              -- in | out
  kind TEXT,
  via TEXT,                                      -- texto | template:<nome> | botoes
  text TEXT,
  intent TEXT,
  error TEXT,
  dry_run INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(tenant_id, at);
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
-- Tudo o que a Secretária mudou na Google Agenda do cliente (auditoria e suporte)
CREATE TABLE IF NOT EXISTS calendar_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action TEXT NOT NULL,                          -- create | move | cancel | undo
  event_id TEXT,
  title TEXT,
  detail TEXT,                                   -- JSON { before, after }
  source TEXT,                                   -- whatsapp | painel
  error TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_calendar_log_tenant ON calendar_log(tenant_id, at);
-- Agenda fictícia editável (DEMO_MODE): alterações feitas sobre os eventos de exemplo. data NULL = apagado.
CREATE TABLE IF NOT EXISTS demo_events (
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  data TEXT,
  PRIMARY KEY (tenant_id, event_id)
);
CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

export function openDb(file = config.dbFile) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export const sql = () => db ?? openDb();
const now = () => new Date().toISOString();

// ------------------------------------------------------------------ tenants

const parseTenant = (r) => r && ({
  id: r.id,
  phone: r.phone,
  name: r.name,
  email: r.email,
  cpfCnpj: r.cpf_cnpj,
  plan: r.plan,
  status: r.status,
  trialEndsAt: r.trial_ends_at,
  pastDueSince: r.past_due_since,
  onboarding: r.onboarding,
  settings: { ...DEFAULT_SETTINGS, ...JSON.parse(r.settings || '{}') },
  ctx: JSON.parse(r.ctx || '{}'),
  hasGoogle: Boolean(r.google_tokens),
  googleEmail: r.google_email,
  googleError: r.google_error,
  lastSyncAt: r.last_sync_at,
  lastInboundAt: r.last_inbound_at,
  asaasCustomerId: r.asaas_customer_id,
  asaasSubscriptionId: r.asaas_subscription_id,
  createdAt: r.created_at,
});

const COLS = {
  name: 'name', email: 'email', cpfCnpj: 'cpf_cnpj', plan: 'plan', status: 'status', trialEndsAt: 'trial_ends_at',
  pastDueSince: 'past_due_since', onboarding: 'onboarding', googleEmail: 'google_email', googleError: 'google_error',
  lastSyncAt: 'last_sync_at', lastInboundAt: 'last_inbound_at', asaasCustomerId: 'asaas_customer_id',
  asaasSubscriptionId: 'asaas_subscription_id',
};

export const getTenant = (id) => parseTenant(sql().prepare('SELECT * FROM tenants WHERE id = ?').get(id));
export const getTenantByPhone = (phone) => parseTenant(sql().prepare('SELECT * FROM tenants WHERE phone = ?').get(String(phone).replace(/\D/g, '')));
export const getTenantBySubscription = (subId) => parseTenant(sql().prepare('SELECT * FROM tenants WHERE asaas_subscription_id = ?').get(subId));
export const listTenants = () => sql().prepare('SELECT * FROM tenants ORDER BY id DESC').all().map(parseTenant);

export function createTenant(phone, at = new Date()) {
  const trialEnds = new Date(at.getTime() + config.trialDays * 864e5).toISOString();
  const r = sql().prepare('INSERT INTO tenants (phone, trial_ends_at) VALUES (?, ?)').run(String(phone).replace(/\D/g, ''), trialEnds);
  return getTenant(Number(r.lastInsertRowid));
}

export function updateTenant(id, patch) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'settings' || k === 'ctx') { sets.push(`${k} = ?`); vals.push(JSON.stringify(v)); continue; }
    if (k === 'googleTokens') { sets.push('google_tokens = ?'); vals.push(v ? encrypt(v) : null); continue; }
    if (!COLS[k]) throw new Error(`Campo desconhecido: ${k}`);
    sets.push(`${COLS[k]} = ?`);
    vals.push(v ?? null);
  }
  if (sets.length) sql().prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return getTenant(id);
}

export const getGoogleTokens = (id) => decrypt(sql().prepare('SELECT google_tokens FROM tenants WHERE id = ?').get(id)?.google_tokens);
export const deleteTenant = (id) => sql().prepare('DELETE FROM tenants WHERE id = ?').run(id);

// ------------------------------------------------------------------ agenda (cache)

export function getEvents(tenantId) {
  const r = sql().prepare('SELECT events FROM events_cache WHERE tenant_id = ?').get(tenantId);
  return r ? JSON.parse(r.events).map((e) => ({ ...e, start: new Date(e.start), end: new Date(e.end) })) : [];
}

export function setEvents(tenantId, events) {
  sql().prepare('INSERT INTO events_cache (tenant_id, events, synced_at) VALUES (?, ?, ?) ON CONFLICT(tenant_id) DO UPDATE SET events = excluded.events, synced_at = excluded.synced_at')
    .run(tenantId, JSON.stringify(events), now());
}

const toCache = (e) => ({ ...e, start: new Date(e.start).toISOString(), end: new Date(e.end).toISOString() });

/** Atualiza um evento no cache logo após a Secretária alterá-lo (a próxima sincronização não vê "mudança"). */
export function upsertCachedEvent(tenantId, event) {
  const list = getEvents(tenantId).filter((e) => e.id !== event.id);
  list.push(event);
  setEvents(tenantId, list.sort((a, b) => a.start - b.start).map(toCache));
}

export function removeCachedEvent(tenantId, eventId) {
  setEvents(tenantId, getEvents(tenantId).filter((e) => e.id !== eventId).map(toCache));
}

export const hasEventsCache = (tenantId) => Boolean(sql().prepare('SELECT 1 FROM events_cache WHERE tenant_id = ?').get(tenantId));

// ------------------------------------------------------------------ anti-duplicidade e fila

export const wasSent = (tenantId, key) => Boolean(sql().prepare('SELECT 1 FROM sent WHERE tenant_id = ? AND key = ?').get(tenantId, key));
export const markSent = (tenantId, key, at = new Date()) =>
  sql().prepare('INSERT OR IGNORE INTO sent (tenant_id, key, at) VALUES (?, ?, ?)').run(tenantId, key, at.toISOString());
export const pruneSent = () => sql().prepare('DELETE FROM sent WHERE at < ?').run(new Date(Date.now() - 14 * 864e5).toISOString());

export const enqueue = (tenantId, alert) =>
  sql().prepare('INSERT OR IGNORE INTO queue (tenant_id, key, alert) VALUES (?, ?, ?)').run(tenantId, alert.key, JSON.stringify(alert));
export function takeQueue(tenantId) {
  const rows = sql().prepare('SELECT alert FROM queue WHERE tenant_id = ?').all(tenantId);
  sql().prepare('DELETE FROM queue WHERE tenant_id = ?').run(tenantId);
  return rows.map((r) => JSON.parse(r.alert));
}
export const queueSize = (tenantId) => sql().prepare('SELECT COUNT(*) n FROM queue WHERE tenant_id = ?').get(tenantId).n;

// ------------------------------------------------------------------ mensagens (log + custo)

export function logMessage(m) {
  sql().prepare('INSERT INTO messages (tenant_id, dir, kind, via, text, intent, error, dry_run) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(m.tenantId ?? null, m.dir, m.kind ?? null, m.via ?? null, m.text ?? null, m.intent ?? null, m.error ?? null, m.dryRun ? 1 : 0);
}

export const listMessages = (tenantId, limit = 30) =>
  sql().prepare('SELECT * FROM messages WHERE tenant_id = ? ORDER BY id DESC LIMIT ?').all(tenantId, limit);

export function monthStats() {
  const since = new Date(); since.setDate(1); since.setHours(0, 0, 0, 0);
  return sql().prepare(`SELECT tenant_id, SUM(dir = 'out' AND error IS NULL) AS sent, SUM(dir = 'in') AS received,
      SUM(intent = 'nao_entendido') AS unknown FROM messages WHERE at >= ? GROUP BY tenant_id`).all(since.toISOString());
}

export const pruneMessages = () => sql().prepare('DELETE FROM messages WHERE at < ?').run(new Date(Date.now() - 90 * 864e5).toISOString());

// ------------------------------------------------------------------ link mágico

export function saveLoginToken(hash, tenantId, minutes = 15) {
  sql().prepare('INSERT INTO login_tokens (token_hash, tenant_id, expires_at) VALUES (?, ?, ?)')
    .run(hash, tenantId, new Date(Date.now() + minutes * 60000).toISOString());
}

export function consumeLoginToken(hash) {
  const r = sql().prepare('SELECT * FROM login_tokens WHERE token_hash = ?').get(hash);
  if (!r || r.used || r.expires_at < now()) return null;
  sql().prepare('UPDATE login_tokens SET used = 1 WHERE token_hash = ?').run(hash);
  return r.tenant_id;
}

// ------------------------------------------------------------------ alterações na agenda

export function logCalendar({ tenantId, action, eventId = null, title = null, before = null, after = null, source = 'whatsapp', error = null }) {
  sql().prepare('INSERT INTO calendar_log (tenant_id, action, event_id, title, detail, source, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(tenantId, action, eventId, title, JSON.stringify({ before, after }), source, error);
}

export const listCalendarLog = (tenantId, limit = 20) => sql().prepare('SELECT * FROM calendar_log WHERE tenant_id = ? ORDER BY id DESC LIMIT ?')
  .all(tenantId, limit).map((r) => ({ ...r, detail: JSON.parse(r.detail || '{}') }));

export function calendarStats() {
  const since = new Date(); since.setDate(1); since.setHours(0, 0, 0, 0);
  return sql().prepare('SELECT tenant_id, COUNT(*) AS n FROM calendar_log WHERE at >= ? AND error IS NULL GROUP BY tenant_id').all(since.toISOString());
}

export const getDemoOverrides = (tenantId) => sql().prepare('SELECT event_id, data FROM demo_events WHERE tenant_id = ?').all(tenantId)
  .map((r) => ({ id: r.event_id, data: r.data ? JSON.parse(r.data) : null }));
export const setDemoOverride = (tenantId, eventId, data) => sql()
  .prepare('INSERT INTO demo_events (tenant_id, event_id, data) VALUES (?, ?, ?) ON CONFLICT(tenant_id, event_id) DO UPDATE SET data = excluded.data')
  .run(tenantId, eventId, data ? JSON.stringify(data) : null);
export const clearDemoOverrides = (tenantId) => sql().prepare('DELETE FROM demo_events WHERE tenant_id = ?').run(tenantId);

// ------------------------------------------------------------------ idempotência de cobrança

export function firstTimeBillingEvent(id) {
  const r = sql().prepare('INSERT OR IGNORE INTO billing_events (id) VALUES (?)').run(String(id));
  return r.changes > 0;
}
