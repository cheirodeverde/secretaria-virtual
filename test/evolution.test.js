// Integração com a Evolution API, contra um servidor Evolution falso (mesmas rotas e formatos da v2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const calls = [];
const state = { exists: false, conn: 'close' };
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ method: req.method, url: req.url, apikey: req.headers.apikey, body });
    const json = (code, d) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (req.url.startsWith('/instance/connectionState/')) {
      return state.exists ? json(200, { instance: { instanceName: 'secretaria', state: state.conn } })
        : json(404, { status: 404, error: 'Not Found', response: { message: ['The "secretaria" instance does not exist'] } });
    }
    if (req.url === '/instance/create') { state.exists = true; return json(201, { instance: { instanceName: body.instanceName }, hash: 'abc' }); }
    if (req.url.startsWith('/webhook/set/')) return json(201, { webhook: body.webhook });
    if (req.url.startsWith('/instance/connect/')) { state.conn = 'connecting'; return json(200, { pairingCode: null, code: '2@xyz', base64: 'data:image/png;base64,QRDATA', count: 1 }); }
    if (req.url.startsWith('/message/sendText/')) return json(201, { key: { id: 'MSG1' }, status: 'PENDING' });
    if (req.url.startsWith('/instance/fetchInstances')) return json(200, [{ name: 'secretaria', ownerJid: '5511900001111@s.whatsapp.net', profileName: 'Secretária' }]);
    if (req.url.startsWith('/instance/logout/')) { state.conn = 'close'; return json(200, { status: 'SUCCESS' }); }
    json(404, { message: 'rota desconhecida' });
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));

process.env.EVOLUTION_API_URL = `http://127.0.0.1:${fake.address().port}/`;
process.env.EVOLUTION_API_KEY = 'CHAVE-GLOBAL';
process.env.EVOLUTION_WEBHOOK_TOKEN = 'segredo-do-webhook';
process.env.WHATSAPP_DRY_RUN = 'false';
process.env.BASE_URL = 'https://secretaria.exemplo.com';

const { config } = await import('../src/config.js');
const W = await import('../src/whatsapp.js');

test.after(() => fake.close());

test('configuração: Evolution é o padrão e sai do modo simulação com URL + chave', () => {
  assert.equal(config.whatsapp.provider, 'evolution');
  assert.equal(config.whatsapp.dryRun, false);
  assert.equal(config.whatsapp.evolution.url, process.env.EVOLUTION_API_URL.replace(/\/$/, ''));
  assert.equal(W.evolutionWebhookUrl(), 'https://secretaria.exemplo.com/webhook/evolution');
});

test('envio: texto pela rota sendText com apikey; botões viram instrução em texto', async () => {
  calls.length = 0;
  const r = await W.deliver({ phone: '5511988887777' }, {
    text: '📅 Vou marcar: Dentista\n\nConfirma?', buttons: [{ id: 'sim', title: '✅ Confirmar' }, { id: 'nao', title: '✖️ Não' }],
  });
  assert.equal(r.via, 'texto');
  const c = calls.at(-1);
  assert.equal(c.method, 'POST');
  assert.equal(c.url, '/message/sendText/secretaria');
  assert.equal(c.apikey, 'CHAVE-GLOBAL');
  assert.equal(c.body.number, '5511988887777');
  assert.match(c.body.text, /Confirma\?\n\nResponda \*CONFIRMAR\* ou \*NÃO\*\.$/);

  await W.deliver({ phone: '5511988887777' }, { text: 'Lembrete', buttons: [{ id: 'btn:done:1', title: 'Feito' }], buttonsFallback: 'Responda FEITO 1.' });
  assert.match(calls.at(-1).body.text, /Lembrete\n\nResponda FEITO 1\.$/);

  // Avisos com modelo (Meta) também saem como texto: na Evolution não existe janela de 24h
  await W.deliver({ phone: '5511988887777', lastInboundAt: null }, { text: 'Resumo da manhã', template: { name: 'sec_resumo', params: ['x'] } });
  assert.equal(calls.at(-1).body.text, 'Resumo da manhã');
});

test('conexão: cria a instância, aponta o webhook com o token e devolve o QR Code', async () => {
  calls.length = 0;
  assert.equal(await W.evolutionState(), 'not_found');
  const r = await W.evolutionConnect();
  assert.equal(r.state, 'connecting');
  assert.equal(r.qr, 'data:image/png;base64,QRDATA');
  const create = calls.find((c) => c.url === '/instance/create');
  assert.equal(create.body.instanceName, 'secretaria');
  assert.equal(create.body.integration, 'WHATSAPP-BAILEYS');
  const hook = calls.find((c) => c.url === '/webhook/set/secretaria').body.webhook;
  assert.equal(hook.url, 'https://secretaria.exemplo.com/webhook/evolution');
  assert.deepEqual(hook.headers, { 'x-webhook-token': 'segredo-do-webhook' });
  assert.deepEqual(hook.events, ['MESSAGES_UPSERT', 'CONNECTION_UPDATE']);
  assert.equal(hook.enabled, true);

  // Segunda vez: instância já existe → não cria de novo
  calls.length = 0;
  await W.evolutionConnect();
  assert.equal(calls.some((c) => c.url === '/instance/create'), false);

  state.conn = 'open';
  assert.equal(await W.evolutionState(), 'open');
  assert.equal((await W.evolutionInfo()).number, '5511900001111');
});

test('erros da Evolution chegam com a mensagem dela', async () => {
  const saved = config.whatsapp.evolution.url;
  config.whatsapp.evolution.url = 'http://127.0.0.1:1'; // porta fechada
  await assert.rejects(() => W.evolutionState(), /Não consegui falar com a Evolution API/);
  config.whatsapp.evolution.url = saved;
});

test('webhook: extrai texto, resolve @lid e ignora o que não é conversa com cliente', () => {
  const msg = (key, message, extra = {}) => ({ event: 'messages.upsert', instance: 'secretaria', data: { key, pushName: 'Ana', message, messageType: Object.keys(message)[0], ...extra } });
  const one = (p) => W.extractEvolution(p);

  assert.deepEqual(one(msg({ remoteJid: '5511988887777@s.whatsapp.net', fromMe: false, id: 'A1' }, { conversation: 'oi' })),
    [{ id: 'A1', from: '5511988887777', text: 'oi', type: 'text', profileName: 'Ana' }]);
  assert.equal(one(msg({ remoteJid: '5511988887777@s.whatsapp.net', fromMe: false, id: 'A2' }, { extendedTextMessage: { text: 'agenda amanhã' } }))[0].text, 'agenda amanhã');
  // @lid com número real em remoteJidAlt
  assert.equal(one(msg({ remoteJid: '123456789@lid', remoteJidAlt: '5511977776666@s.whatsapp.net', fromMe: false, id: 'A3' }, { conversation: 'oi' }))[0].from, '5511977776666');
  // ignorados: enviadas pelo próprio número, grupos, status, @lid sem número
  assert.equal(one(msg({ remoteJid: '5511988887777@s.whatsapp.net', fromMe: true, id: 'A4' }, { conversation: 'oi' })).length, 0);
  assert.equal(one(msg({ remoteJid: '120363000000@g.us', fromMe: false, id: 'A5' }, { conversation: 'oi' })).length, 0);
  assert.equal(one(msg({ remoteJid: 'status@broadcast', fromMe: false, id: 'A6' }, { conversation: 'x' })).length, 0);
  assert.equal(one(msg({ remoteJid: '123456789@lid', fromMe: false, id: 'A7' }, { conversation: 'oi' })).length, 0);
  // áudio vira tipo "audio" (a conversa responde que só entende texto)
  assert.equal(one(msg({ remoteJid: '5511988887777@s.whatsapp.net', fromMe: false, id: 'A8' }, { audioMessage: { seconds: 3 } }))[0].type, 'audio');
  // evento com nome em MAIÚSCULAS e outros eventos
  assert.equal(one({ ...msg({ remoteJid: '5511988887777@s.whatsapp.net', fromMe: false, id: 'A9' }, { conversation: 'oi' }), event: 'MESSAGES_UPSERT' }).length, 1);
  assert.equal(one({ event: 'messages.update', data: {} }).length, 0);
  assert.equal(W.extractConnection({ event: 'connection.update', data: { instance: 'secretaria', state: 'open' } }), 'open');
});

test('webhook: só aceita com o token certo', () => {
  const req = (h = {}, q = {}) => ({ get: (k) => h[k.toLowerCase()], query: q });
  assert.equal(W.validEvolutionToken(req({ 'x-webhook-token': 'segredo-do-webhook' })), true);
  assert.equal(W.validEvolutionToken(req({}, { token: 'segredo-do-webhook' })), true);
  assert.equal(W.validEvolutionToken(req({ 'x-webhook-token': 'errado' })), false);
  assert.equal(W.validEvolutionToken(req()), false);
});
