// Números da Secretária: cada um é uma instância da Evolution API (direto ou pela ponte do Cloudflare).
// Os dados são cadastrados no /admin. A chave fica criptografada no banco e nunca volta para a tela.
import crypto from 'node:crypto';
import { config } from './config.js';
import { decrypt, encrypt, randomToken } from './crypto.js';
import { sql } from './db.js';

const parse = (r, withKey = false) => {
  if (!r) return null;
  const key = decrypt(r.api_key);
  return {
    id: r.id,
    name: r.name,
    apiUrl: r.api_url,
    instance: r.instance,
    displayNumber: r.display_number || null,
    webhookSecret: r.webhook_secret,
    enabled: Boolean(r.enabled),
    isDefault: Boolean(r.is_default),
    createdAt: r.created_at,
    keyHint: key ? `••••${String(key).slice(-4)}` : null,
    ...(withKey ? { apiKey: key } : {}),
  };
};

/** Versão segura para mandar ao navegador (sem chave nem segredo do webhook). */
export const publicConnection = ({ apiKey, webhookSecret, ...c }) => c;

export const listConnections = ({ withKey = false } = {}) =>
  sql().prepare('SELECT * FROM wa_connections ORDER BY is_default DESC, id').all().map((r) => parse(r, withKey));
export const getConnection = (id, { withKey = false } = {}) =>
  parse(sql().prepare('SELECT * FROM wa_connections WHERE id = ?').get(Number(id)), withKey);
export const findConnectionByInstance = (instance, { withKey = false } = {}) =>
  parse(sql().prepare('SELECT * FROM wa_connections WHERE instance = ? ORDER BY is_default DESC, id LIMIT 1').get(String(instance || '')), withKey);
export const hasActiveConnection = () => Boolean(sql().prepare('SELECT 1 FROM wa_connections WHERE enabled = 1 LIMIT 1').get());

function clean(input, { partial = false } = {}) {
  const out = {};
  if (!partial || input.name !== undefined) {
    out.name = String(input.name || '').trim().slice(0, 80);
    if (!out.name) throw new Error('Dê um nome ao número (ex.: "Secretária principal").');
  }
  if (!partial || input.apiUrl !== undefined) {
    out.apiUrl = String(input.apiUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/i.test(out.apiUrl)) throw new Error('URL inválida. Ex.: https://evoapi.seudominio.com.br');
  }
  if (!partial || input.instance !== undefined) {
    out.instance = String(input.instance || '').trim();
    if (!/^[\w.-]{1,64}$/.test(out.instance)) throw new Error('Instância inválida: use letras, números, "-", "_" ou "." (sem espaços).');
  }
  if (input.apiKey !== undefined && String(input.apiKey).trim()) out.apiKey = String(input.apiKey).trim().slice(0, 500);
  else if (!partial) throw new Error('Informe a chave (API key da Evolution ou o PROXY_TOKEN do Worker).');
  if (input.displayNumber !== undefined) out.displayNumber = String(input.displayNumber || '').replace(/\D/g, '').slice(0, 15) || null;
  if (input.enabled !== undefined) out.enabled = Boolean(input.enabled);
  return out;
}

export function createConnection(input, { webhookSecret } = {}) {
  const c = clean(input);
  try {
    const r = sql().prepare(`INSERT INTO wa_connections (name, api_url, api_key, instance, display_number, webhook_secret)
      VALUES (?, ?, ?, ?, ?, ?)`).run(c.name, c.apiUrl, encrypt(c.apiKey), c.instance, c.displayNumber ?? null, webhookSecret || randomToken(24));
    ensureDefault();
    return getConnection(Number(r.lastInsertRowid));
  } catch (err) {
    if (/UNIQUE/.test(err.message)) throw new Error('Essa instância dessa Evolution já está cadastrada.');
    throw err;
  }
}

export function updateConnection(id, input) {
  const c = clean(input, { partial: true });
  const map = { name: 'name', apiUrl: 'api_url', instance: 'instance', displayNumber: 'display_number', enabled: 'enabled' };
  const sets = []; const vals = [];
  for (const [k, col] of Object.entries(map)) if (c[k] !== undefined) { sets.push(`${col} = ?`); vals.push(typeof c[k] === 'boolean' ? Number(c[k]) : c[k]); }
  if (c.apiKey) { sets.push('api_key = ?'); vals.push(encrypt(c.apiKey)); }
  if (sets.length) {
    try { sql().prepare(`UPDATE wa_connections SET ${sets.join(', ')} WHERE id = ?`).run(...vals, Number(id)); } catch (err) {
      if (/UNIQUE/.test(err.message)) throw new Error('Essa instância dessa Evolution já está cadastrada.');
      throw err;
    }
  }
  ensureDefault();
  return getConnection(id);
}

export function deleteConnection(id) {
  sql().prepare('UPDATE tenants SET wa_connection_id = NULL WHERE wa_connection_id = ?').run(Number(id));
  sql().prepare('DELETE FROM wa_connections WHERE id = ?').run(Number(id));
  ensureDefault();
}

export function setDefaultConnection(id) {
  sql().prepare('UPDATE wa_connections SET is_default = (id = ?)').run(Number(id));
}

/** Sempre há um padrão entre os números ativos (o primeiro, se o padrão foi removido/desligado). */
function ensureDefault() {
  if (sql().prepare('SELECT 1 FROM wa_connections WHERE is_default = 1 AND enabled = 1').get()) return;
  const first = sql().prepare('SELECT id FROM wa_connections WHERE enabled = 1 ORDER BY id LIMIT 1').get();
  sql().prepare('UPDATE wa_connections SET is_default = (id = ?)').run(first?.id ?? -1);
}

/** Por qual número falar com este cliente: o dele (se ativo) → o padrão → nenhum (simulação). */
export function connectionForTenant(tenant) {
  if (tenant?.waConnectionId) {
    const own = getConnection(tenant.waConnectionId, { withKey: true });
    if (own?.enabled) return own;
  }
  const def = sql().prepare('SELECT * FROM wa_connections WHERE enabled = 1 ORDER BY is_default DESC, id LIMIT 1').get();
  return parse(def, true);
}

export const tenantsPerConnection = () => Object.fromEntries(
  sql().prepare('SELECT wa_connection_id AS id, COUNT(*) AS n FROM tenants WHERE wa_connection_id IS NOT NULL GROUP BY wa_connection_id').all().map((r) => [r.id, r.n]),
);

/** Compatibilidade: quem configurou EVOLUTION_API_URL/KEY no .env ganha esse número cadastrado automaticamente. */
export function importEnvConnection() {
  const e = config.whatsapp.evolution;
  if (!e.url || !e.apiKey || sql().prepare('SELECT 1 FROM wa_connections LIMIT 1').get()) return null;
  const secret = e.webhookToken || crypto.randomBytes(18).toString('base64url');
  return createConnection({ name: 'Secretária principal', apiUrl: e.url, apiKey: e.apiKey, instance: e.instance }, { webhookSecret: secret });
}
