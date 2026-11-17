// Secretária → Worker do Cloudflare (evolution-proxy) → Evolution API (falsa).
// A chave real da Evolution só existe no Worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import worker, { instanceAllowed } from '../cloudflare/evolution-proxy/worker.js';

const REAL_KEY = 'CHAVE-REAL-DA-EVOLUTION';
const seen = [];
const evo = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, apikey: req.headers.apikey, body: raw ? JSON.parse(raw) : null });
    res.writeHead(req.headers.apikey === REAL_KEY ? 200 : 401, { 'Content-Type': 'application/json' });
    if (req.url.startsWith('/instance/connectionState/')) return res.end(JSON.stringify({ instance: { state: 'open' } }));
    if (req.url.startsWith('/instance/fetchInstances')) return res.end(JSON.stringify([{ ownerJid: '5511900001111@s.whatsapp.net' }]));
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise((r) => evo.listen(0, '127.0.0.1', r));

const env = {
  EVOLUTION_URL: `http://127.0.0.1:${evo.address().port}`, INSTANCE: 'secretaria*', EVOLUTION_API_KEY: REAL_KEY, PROXY_TOKEN: 'token-do-proxy-123',
};
// Simula o Cloudflare: cada requisição HTTP vira um Request para worker.fetch(request, env)
const cf = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const r = await worker.fetch(new Request(`http://worker.local${req.url}`, {
    method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw,
  }), env);
  res.writeHead(r.status, { 'Content-Type': 'application/json' });
  res.end(await r.text());
});
await new Promise((r) => cf.listen(0, '127.0.0.1', r));
const CF = `http://127.0.0.1:${cf.address().port}`;

process.env.WHATSAPP_DRY_RUN = 'false';
const { openDb } = await import('../src/db.js');
const { createConnection, getConnection } = await import('../src/connections.js');
const W = await import('../src/whatsapp.js');
openDb(':memory:');
// a Secretária só conhece o token do proxy (cadastrado como "Chave" do número no /admin)
const C = getConnection(createConnection({ name: 'Principal', apiUrl: CF, apiKey: env.PROXY_TOKEN, instance: 'secretaria' }).id, { withKey: true });
const C2 = getConnection(createConnection({ name: 'Padaria', apiUrl: CF, apiKey: env.PROXY_TOKEN, instance: 'secretaria-padaria' }).id, { withKey: true });

test.after(() => { evo.close(); cf.close(); });

test('a Secretária funciona através do Worker, e a chave real só aparece entre o Worker e a Evolution', async () => {
  assert.equal(await W.evolutionState(C), 'open');
  assert.equal((await W.evolutionInfo(C)).number, '5511900001111');
  await W.evolutionEnsure(C);
  await W.evolutionEnsure(C2); // segunda instância liberada pelo curinga "secretaria*"
  await W.sendText('5511988887777', 'oi', C);
  assert.ok(seen.length >= 4);
  assert.ok(seen.every((c) => c.apikey === REAL_KEY), 'Worker trocou o token pela chave real');
  assert.deepEqual(seen.at(-1).body, { number: '5511988887777', text: 'oi', delay: 1000, linkPreview: true });
});

test('o Worker recusa token errado, outras rotas e outras instâncias', async () => {
  const call = (method, path, { key = env.PROXY_TOKEN, body } = {}) => fetch(`${CF}${path}`, {
    method, headers: { apikey: key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.status);
  const before = seen.length;
  assert.equal(await call('GET', '/instance/connectionState/secretaria', { key: 'errado' }), 401);
  assert.equal(await call('GET', '/instance/connectionState/secretaria', { key: '' }), 401);
  assert.equal(await call('POST', '/message/sendText/CheirodeVerdeOficial', { body: { number: '1', text: 'x' } }), 403);
  assert.equal(await call('GET', '/instance/fetchInstances'), 403); // listar todas as instâncias
  assert.equal(await call('GET', '/instance/fetchInstances?instanceName=CheirodeVerdeOficial'), 403);
  assert.equal(await call('DELETE', '/instance/delete/secretaria'), 403);
  assert.equal(await call('POST', '/chat/findMessages/secretaria', { body: {} }), 403); // ler conversas
  assert.equal(await call('POST', '/instance/create', { body: { instanceName: 'outra' } }), 403);
  assert.equal(await call('GET', '/instance/connectionState/..%2F..%2Finstance'), 403);
  assert.equal(await call('POST', '/instance/create', { body: { instanceName: 'secretaria' } }), 200);
  assert.equal(seen.length, before + 1, 'só a criação permitida chegou à Evolution');
  // Worker sem configuração avisa claramente
  const r = await worker.fetch(new Request('http://w/instance/connectionState/secretaria'), {});
  assert.equal(r.status, 500);
  assert.match((await r.json()).message, /EVOLUTION_URL, INSTANCE, EVOLUTION_API_KEY, PROXY_TOKEN/);
});

test('lista de instâncias do Worker: nomes, vírgulas e curinga', () => {
  assert.equal(instanceAllowed('secretaria', 'secretaria'), true);
  assert.equal(instanceAllowed('secretaria-2', 'secretaria'), false);
  assert.equal(instanceAllowed('secretaria-2', 'secretaria, secretaria-2'), true);
  assert.equal(instanceAllowed('secretaria-padaria', 'secretaria*'), true);
  assert.equal(instanceAllowed('CheirodeVerdeOficial', 'secretaria*'), false);
  assert.equal(instanceAllowed('', '*'), false);
});
