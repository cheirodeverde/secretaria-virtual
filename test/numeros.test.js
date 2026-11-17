// Vários números da Secretária: cadastro pelo /admin, webhook por número e envio pelo número certo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// --- Evolution falsa com duas instâncias (sec-a e sec-b)
const sent = [];
const KEY = 'CHAVE-EVOLUTION-SECRETA-1234';
const evo = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const json = (code, d) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (req.headers.apikey !== KEY) return json(401, { status: 401, error: 'Unauthorized', response: { message: 'Unauthorized' } });
    const body = raw ? JSON.parse(raw) : null;
    const m = req.url.match(/^\/message\/sendText\/(.+)$/);
    if (m) { sent.push({ instance: decodeURIComponent(m[1]), ...body }); return json(201, {}); }
    if (req.url.startsWith('/instance/connectionState/')) return json(200, { instance: { state: 'open' } });
    json(200, {});
  });
});
await new Promise((r) => evo.listen(0, '127.0.0.1', r));
const EVO = `http://127.0.0.1:${evo.address().port}`;

process.env.ADMIN_PASSWORD = 'admin';
process.env.WHATSAPP_DRY_RUN = 'false';
const { default: app } = await import('../src/server.js');
const { getConnection } = await import('../src/connections.js');
const { getTenantByPhone } = await import('../src/db.js');
const { dispatch } = await import('../src/dispatcher.js');
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const URL0 = `http://127.0.0.1:${server.address().port}`;

test.after(() => { server.close(); evo.close(); });

const AUTH = `Basic ${Buffer.from('x:admin').toString('base64')}`;
const admin = async (method, path, body) => {
  const r = await fetch(`${URL0}${path}`, { method, headers: { Authorization: AUTH, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})), raw: r };
};
const hook = (id, token, from, text, msgId) => fetch(`${URL0}/webhook/evolution/${id}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-webhook-token': token },
  body: JSON.stringify({ event: 'messages.upsert', instance: 'x', data: { key: { remoteJid: `${from}@s.whatsapp.net`, fromMe: false, id: msgId }, pushName: 'Cliente', message: { conversation: text } } }),
}).then((r) => r.status);
const waitSent = async (n) => { for (let i = 0; i < 100 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 20)); return sent.length; };

let A; let B;

test('cadastro de números pelo admin: valida a chave e nunca devolve o segredo', async () => {
  const bad = await admin('POST', '/api/admin/whatsapp', { name: 'Errado', apiUrl: EVO, apiKey: 'chave-errada', instance: 'sec-x' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /Chave recusada/);
  assert.equal((await admin('POST', '/api/admin/whatsapp', { name: '', apiUrl: EVO, apiKey: KEY, instance: 'a' })).status, 400);
  assert.equal((await admin('POST', '/api/admin/whatsapp', { name: 'X', apiUrl: 'ftp://x', apiKey: KEY, instance: 'a' })).status, 400);
  assert.equal((await admin('POST', '/api/admin/whatsapp', { name: 'X', apiUrl: EVO, apiKey: KEY, instance: 'com espaço' })).status, 400);

  const a = await admin('POST', '/api/admin/whatsapp', { name: 'Secretária A', apiUrl: `${EVO}/`, apiKey: KEY, instance: 'sec-a', displayNumber: '+55 (11) 90000-1111' });
  const b = await admin('POST', '/api/admin/whatsapp', { name: 'Secretária B', apiUrl: EVO, apiKey: KEY, instance: 'sec-b' });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal((await admin('POST', '/api/admin/whatsapp', { name: 'Dup', apiUrl: EVO, apiKey: KEY, instance: 'sec-a' })).status, 400, 'não duplica');

  const list = await admin('GET', '/api/admin/whatsapp');
  assert.equal(list.data.simulation, false);
  assert.deepEqual(list.data.connections.map((c) => [c.name, c.isDefault]), [['Secretária A', true], ['Secretária B', false]]);
  const json = JSON.stringify(list.data);
  assert.equal(json.includes(KEY), false, 'chave nunca vai para o navegador');
  assert.equal(list.data.connections[0].keyHint, '••••1234');
  assert.equal(list.data.connections[0].displayNumber, '5511900001111');
  assert.equal('webhookSecret' in list.data.connections[0], false);
  assert.match(list.data.connections[1].webhookUrl, new RegExp(`/webhook/evolution/${b.data.id}$`));

  A = getConnection(a.data.id, { withKey: true });
  B = getConnection(b.data.id, { withKey: true });
  // o segredo fica criptografado no banco, e o site usa o número público do padrão
  assert.equal(A.apiKey, KEY);
  assert.equal((await (await fetch(`${URL0}/api/public`)).json()).whatsapp, '5511900001111');
});

test('cada cliente é respondido pelo número para o qual escreveu', async () => {
  sent.length = 0;
  assert.equal(await hook(B.id, 'token-errado', '5521911110000', 'oi', 'm1'), 401);
  assert.equal(await hook(B.id, A.webhookSecret, '5521911110000', 'oi', 'm1'), 401, 'token de outro número não serve');
  assert.equal(await hook(9999, B.webhookSecret, '5521911110000', 'oi', 'm1'), 401);

  assert.equal(await hook(B.id, B.webhookSecret, '5521911110000', 'oi', 'm1'), 200);
  assert.equal(await hook(A.id, A.webhookSecret, '5531922220000', 'oi', 'm2'), 200);
  await waitSent(2);
  const by = Object.fromEntries(sent.map((s) => [s.number, s.instance]));
  assert.equal(by['5521911110000'], 'sec-b');
  assert.equal(by['5531922220000'], 'sec-a');
  assert.equal(getTenantByPhone('5521911110000').waConnectionId, B.id);

  // mensagem repetida (mesmo id, mesmo número) é ignorada
  const before = sent.length;
  assert.equal(await hook(B.id, B.webhookSecret, '5521911110000', 'oi', 'm1'), 200);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(sent.length, before);
});

test('avisos automáticos saem pelo número do cliente; o admin pode trocar o número', async () => {
  sent.length = 0;
  const t = getTenantByPhone('5521911110000');
  assert.equal(await dispatch(t, { key: 'aviso-1', kind: 'alerta', text: 'Aviso', bypassQuiet: true }), 'sent');
  assert.equal(sent.at(-1).instance, 'sec-b');

  assert.equal((await admin('POST', `/api/admin/tenants/${t.id}/connection`, { connectionId: A.id })).status, 200);
  assert.equal(await dispatch(getTenantByPhone('5521911110000'), { key: 'aviso-2', kind: 'alerta', text: 'Aviso 2', bypassQuiet: true }), 'sent');
  assert.equal(sent.at(-1).instance, 'sec-a');

  // número desligado → usa o padrão; se o cliente escrever para outro número, passa a ser atendido por ele
  assert.equal((await admin('PUT', `/api/admin/whatsapp/${A.id}`, { enabled: false })).status, 200);
  const list = await admin('GET', '/api/admin/whatsapp');
  assert.deepEqual(list.data.connections.filter((c) => c.isDefault).map((c) => c.name), ['Secretária B'], 'padrão passa para um número ativo');
  assert.equal(await dispatch(getTenantByPhone('5521911110000'), { key: 'aviso-3', kind: 'alerta', text: 'Aviso 3', bypassQuiet: true }), 'sent');
  assert.equal(sent.at(-1).instance, 'sec-b');
  assert.equal(await hook(A.id, A.webhookSecret, '5531922220000', 'tarefas', 'm3'), 200, 'número desligado não processa');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(sent.some((s) => s.number === '5531922220000' && /tarefa/i.test(s.text)), false);
});

test('editar sem reenviar a chave mantém a chave; remover não apaga clientes', async () => {
  const r = await admin('PUT', `/api/admin/whatsapp/${B.id}`, { name: 'Secretária B (loja)', apiKey: '' });
  assert.equal(r.status, 200);
  assert.equal(getConnection(B.id, { withKey: true }).apiKey, KEY);
  assert.equal((await admin('DELETE', `/api/admin/whatsapp/${A.id}`)).status, 200);
  assert.equal(getTenantByPhone('5531922220000').waConnectionId, null);
  const list = await admin('GET', '/api/admin/whatsapp');
  assert.deepEqual(list.data.connections.map((c) => c.name), ['Secretária B (loja)']);
});
