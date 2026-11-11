import { config } from './config.js'; // primeiro import: define o fuso horário
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { accessState, effectivePlan, magicLink, statusLabel, trialDaysLeft } from './account.js';
import { billingConfigured, handleBillingEvent, startSubscription, validWebhookToken } from './billing.js';
import { handleIncoming } from './conversation.js';
import { safeEqual, sha256, sign, verify } from './crypto.js';
import {
  consumeLoginToken, deleteTenant, getEvents, getTenant, listMessages, listTenants, monthStats, openDb, queueSize, updateTenant,
} from './db.js';
import { dispatch } from './dispatcher.js';
import { authUrl, connectDemo, disconnect, googleConfigured, handleCallback } from './google.js';
import { analyzeDay, attentionItems, dayAgendaText } from './rules/analysis.js';
import { buildBriefing, buildPreview, previewRule } from './rules/engine.js';
import {
  countCustomRules, createRule, CUSTOM_TRIGGERS, deleteRule, getRule, listRules, resetSystemScript, SYSTEM_BY_KEY, updateRule,
} from './rules/scripts.js';
import { processTenant, startScheduler, syncTenant, tick } from './scheduler.js';
import {
  completeTask, createTask, deleteTask, getTask, listTasks, tasksForDay, updateTask,
} from './tasks.js';
import { addDays, dayKey, fmtDayLong } from './time.js';
import { extractMessages, outbox, validSignature, whatsappConfigured } from './whatsapp.js';
import { parseDateTime } from './nlu/datetime.js';

openDb();
const app = express();
app.set('trust proxy', 1);
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const page = (name) => (_req, res) => res.sendFile(path.join(pub, name));
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

// ================================================================== público

app.get('/', page('index.html'));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/public', (_req, res) => res.json({
  productName: config.productName, trialDays: config.trialDays, whatsapp: config.whatsapp.displayNumber, plans: config.plans,
}));

// --- webhook do WhatsApp
app.get('/webhook', (req, res) => {
  const ok = req.query['hub.mode'] === 'subscribe' && config.whatsapp.verifyToken && req.query['hub.verify_token'] === config.whatsapp.verifyToken;
  return ok ? res.status(200).send(req.query['hub.challenge']) : res.sendStatus(403);
});

const seen = new Set(); // a Meta pode reenviar o mesmo evento
app.post('/webhook', (req, res) => {
  if (!validSignature(req.rawBody, req.get('x-hub-signature-256'))) return res.sendStatus(401);
  res.sendStatus(200); // responde rápido; processa em seguida
  for (const m of extractMessages(req.body)) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    if (seen.size > 5000) seen.delete(seen.values().next().value);
    handleIncoming(m).catch((err) => console.error('[webhook]', err));
  }
});

// --- webhook de cobrança (Asaas)
app.post('/billing/webhook', asyncH(async (req, res) => {
  if (!validWebhookToken(req.get('asaas-access-token'))) return res.sendStatus(401);
  res.json({ received: true });
  handleBillingEvent(req.body).catch((err) => console.error('[billing]', err));
}));

// --- link mágico
app.get('/entrar', (req, res) => {
  const tid = consumeLoginToken(sha256(String(req.query.t || '')));
  if (!tid) return res.redirect('/sem-acesso');
  setSession(res, tid);
  const next = String(req.query.next || '/app');
  res.redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/app');
});
app.get('/sem-acesso', page('sem-acesso.html'));

// ================================================================== sessão

const COOKIE = 'sb_sess';
function setSession(res, tid) {
  res.cookie(COOKIE, sign({ tid, exp: Date.now() + 30 * 864e5 }), {
    httpOnly: true, sameSite: 'lax', secure: config.baseUrl.startsWith('https'), maxAge: 30 * 864e5, path: '/',
  });
}
function readCookie(req, name) {
  const m = (req.get('cookie') || '').split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function session(req, res, next) {
  const p = verify(readCookie(req, COOKIE));
  const tenant = p && getTenant(p.tid);
  if (!tenant) return req.path.startsWith('/api/') ? res.status(401).json({ error: 'Sessão expirada. Mande PAINEL no WhatsApp para um novo link.' }) : res.redirect('/sem-acesso');
  req.tenant = tenant;
  next();
}

// ================================================================== Google OAuth

async function onGoogleConnected(tenant) {
  let t = updateTenant(tenant.id, { onboarding: 'done' });
  await syncTenant(t);
  t = getTenant(t.id);
  const s = t.settings;
  const today = dayAgendaText(analyzeDay(getEvents(t.id), new Date(), s), s, { header: `📋 Seu dia hoje (${fmtDayLong(new Date())})` });
  await dispatch(t, {
    key: `google_ok:${Date.now()}`, kind: 'conta', account: true,
    text: `✅ Agenda conectada! A partir de agora:\n☀️ resumo do dia às ${s.briefingTime}\n🌙 prévia de amanhã às ${s.previewTime}\n⏰ lembrete antes de cada compromisso\n\n${today}`,
    template: { name: 'sec_alerta', params: ['sua Google Agenda foi conectada com sucesso.'] },
  });
}

app.get('/app/conectar-google', session, asyncH(async (req, res) => {
  if (config.demoMode || !googleConfigured()) {
    if (!config.demoMode) return res.status(400).send('Google não configurado (GOOGLE_CLIENT_ID/SECRET). Use DEMO_MODE=true para testar.');
    const t = connectDemo(req.tenant.id);
    await onGoogleConnected(t);
    return res.redirect('/app?google=ok');
  }
  res.redirect(authUrl(req.tenant.id));
}));

app.get('/auth/google/callback', asyncH(async (req, res) => {
  const st = verify(String(req.query.state || ''));
  if (!st?.tid || req.query.error) return res.redirect('/app?google=erro');
  try {
    const t = await handleCallback(st.tid, String(req.query.code || ''));
    setSession(res, t.id);
    await onGoogleConnected(t);
    res.redirect('/app?google=ok');
  } catch (err) {
    console.error('[google] callback:', err.message);
    res.redirect('/app?google=erro');
  }
}));

// ================================================================== painel do cliente

app.get('/app', session, page('app.html'));
app.use('/api/me', session);
app.use('/api/app', session);

const NUM_FIELDS = ['reminderLeadMin', 'travelBufferMin', 'maxMeetingHours', 'focusMinMinutes'];
const HM_FIELDS = ['briefingTime', 'previewTime', 'workStart', 'workEnd', 'quietStart', 'quietEnd'];

app.get('/api/me', (req, res) => {
  const t = req.tenant;
  const plan = effectivePlan(t);
  res.json({
    name: t.name, phone: t.phone, email: t.email, plan: t.plan, status: t.status, statusLabel: statusLabel(t),
    access: accessState(t), trialDaysLeft: trialDaysLeft(t), trialEndsAt: t.trialEndsAt,
    google: { connected: t.hasGoogle, email: t.googleEmail, error: t.googleError, lastSyncAt: t.lastSyncAt },
    settings: t.settings, limits: plan, plans: config.plans, billingConfigured: billingConfigured(),
    whatsappDryRun: config.whatsapp.dryRun, demoMode: config.demoMode, queued: queueSize(t.id),
  });
});

app.put('/api/app/profile', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const email = String(req.body.email || '').trim().slice(0, 120);
  res.json(updateTenant(req.tenant.id, { name: name || req.tenant.name, email: email || null }));
});

app.put('/api/app/settings', (req, res) => {
  const next = { ...req.tenant.settings };
  for (const [k, v0] of Object.entries(req.body)) {
    if (!(k in next)) continue;
    let v = v0;
    if (NUM_FIELDS.includes(k)) { v = Number(v); if (!Number.isFinite(v) || v < 0 || v > 1440) return res.status(400).json({ error: `${k} inválido` }); }
    if (HM_FIELDS.includes(k) && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return res.status(400).json({ error: `${k} deve ser HH:MM` });
    if (k === 'paused') v = Boolean(v);
    if (k === 'calendarIds') v = String(v).split(',').map((s) => s.trim()).filter(Boolean).slice(0, effectivePlan(req.tenant).maxCalendars).join(',') || 'primary';
    next[k] = v;
  }
  res.json(updateTenant(req.tenant.id, { settings: next }).settings);
});

app.get('/api/app/today', (req, res) => {
  const t = req.tenant;
  const now = new Date();
  const a = analyzeDay(getEvents(t.id), now, t.settings);
  res.json({ events: [...a.allDay, ...a.timed], busyMin: a.busyMin, attention: attentionItems(a, t.settings), focus: a.focus, tasks: tasksForDay(t.id, now) });
});

app.post('/api/app/sync', asyncH(async (req, res) => {
  const r = await syncTenant(req.tenant);
  res.status(r.ok ? 200 : 400).json({ ok: r.ok, error: getTenant(req.tenant.id).googleError });
}));

app.post('/api/app/google/disconnect', asyncH(async (req, res) => { await disconnect(req.tenant); res.json({ ok: true }); }));

// --- tarefas
const taskOut = (x) => x && ({ ...x, dueAt: x.dueAt?.toISOString() ?? null });
function dueFromBody(b) {
  if (b.dueText) { const p = parseDateTime(b.dueText); return { dueAt: p.date, hasTime: p.hasTime }; }
  if (b.dueAt === null || b.dueAt === '') return { dueAt: null, hasTime: false };
  if (b.dueAt) return { dueAt: new Date(b.dueAt), hasTime: Boolean(b.hasTime) };
  return {};
}
app.get('/api/app/tasks', (req, res) => res.json({
  open: listTasks(req.tenant.id).map(taskOut), done: listTasks(req.tenant.id, { status: 'done', limit: 20 }).map(taskOut),
}));
app.post('/api/app/tasks', (req, res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Escreva a tarefa' });
  const parsed = req.body.dueAt === undefined && !req.body.dueText ? parseDateTime(title) : null; // "ligar pro João amanhã 10h"
  const due = parsed ? { dueAt: parsed.date, hasTime: parsed.hasTime } : dueFromBody(req.body);
  res.json(taskOut(createTask(req.tenant.id, { title: parsed?.rest || title, ...due })));
});
app.put('/api/app/tasks/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!getTask(req.tenant.id, id)) return res.sendStatus(404);
  if (req.body.status === 'done') completeTask(req.tenant.id, id);
  else updateTask(req.tenant.id, id, { title: req.body.title, ...dueFromBody(req.body) });
  res.json(taskOut(getTask(req.tenant.id, id)));
});
app.delete('/api/app/tasks/:id', (req, res) => { deleteTask(req.tenant.id, Number(req.params.id)); res.json({ ok: true }); });

// --- regras e roteiros
const ruleOut = (r) => ({ ...r, meta: r.systemKey ? SYSTEM_BY_KEY[r.systemKey] : CUSTOM_TRIGGERS[r.trigger] });
app.get('/api/app/rules', (req, res) => res.json({
  rules: listRules(req.tenant.id).map(ruleOut), triggers: CUSTOM_TRIGGERS,
  limit: effectivePlan(req.tenant).maxCustomRules, used: countCustomRules(req.tenant.id),
}));
app.post('/api/app/rules', (req, res) => {
  if (countCustomRules(req.tenant.id) >= effectivePlan(req.tenant).maxCustomRules) return res.status(403).json({ error: 'Limite de regras do seu plano atingido. Passe para o Profissional para regras ilimitadas.' });
  try { res.json(ruleOut(createRule(req.tenant.id, req.body))); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/app/rules/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const r = req.body.reset ? resetSystemScript(req.tenant.id, id) : updateRule(req.tenant.id, id, req.body);
    return r ? res.json(ruleOut(r)) : res.sendStatus(404);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/app/rules/:id', (req, res) => { deleteRule(req.tenant.id, Number(req.params.id)); res.json({ ok: true }); });

/** Prévia de qualquer regra com dados reais (antes de salvar). */
app.post('/api/app/rules/preview', (req, res) => {
  const t = req.tenant;
  const now = new Date();
  const rules = listRules(t.id);
  const events = getEvents(t.id);
  const { systemKey, script, trigger, params } = req.body;
  if (systemKey) {
    const merged = rules.map((r) => (r.systemKey === systemKey ? { ...r, script: script ?? r.script, enabled: true } : r));
    if (systemKey === 'resumo_manha') return res.json({ text: buildBriefing({ tenant: t, rules: merged, events, todayTasks: tasksForDay(t.id, now), now }).text });
    if (systemKey === 'previa_amanha') return res.json({ text: buildPreview({ tenant: t, rules: merged, events, tomorrowTasks: tasksForDay(t.id, addDays(now, 1)).filter((x) => dayKey(x.dueAt) === dayKey(addDays(now, 1))), now }).text });
    return res.json({ text: previewRule({ tenant: t, rule: { trigger: 'before_event', params: {}, script: script ?? rules.find((r) => r.systemKey === systemKey)?.script }, events, now }) });
  }
  res.json({ text: previewRule({ tenant: t, rule: { trigger, params: params || {}, script: script || '' }, events, openTasks: listTasks(t.id), now }) });
});

// --- envio manual e histórico
app.post('/api/app/send/:kind', asyncH(async (req, res) => {
  const t = req.tenant;
  const now = new Date();
  const rules = listRules(t.id);
  const events = getEvents(t.id);
  const make = {
    resumo: () => buildBriefing({ tenant: t, rules, events, todayTasks: tasksForDay(t.id, now), now }),
    teste: () => ({ text: '✅ Teste da sua secretária: os avisos estão chegando! Responda AJUDA para ver o que eu entendo.', template: { name: 'sec_alerta', params: ['esta é uma mensagem de teste da sua secretária.'] } }),
  }[req.params.kind];
  if (!make) return res.sendStatus(404);
  const alert = { ...make(), key: `manual:${req.params.kind}:${now.toISOString()}`, kind: req.params.kind, account: true };
  const r = await dispatch(t, alert, now, { force: true });
  res.status(r === 'sent' ? 200 : 502).json({ result: r });
}));
app.get('/api/app/messages', (req, res) => res.json(listMessages(req.tenant.id, 40)));

// --- assinatura
app.post('/api/app/subscribe', asyncH(async (req, res) => {
  try { res.json(await startSubscription(req.tenant, req.body)); } catch (e) { res.status(400).json({ error: e.message }); }
}));

app.post('/api/app/logout', (_req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true }); });
app.post('/api/app/delete-account', asyncH(async (req, res) => {
  await disconnect(req.tenant).catch(() => {});
  deleteTenant(req.tenant.id); // apaga eventos, tarefas, regras e mensagens em cascata
  res.clearCookie(COOKIE, { path: '/' }).json({ ok: true });
}));

// ================================================================== admin do SaaS

function admin(req, res, next) {
  const [type, value] = (req.get('authorization') || '').split(' ');
  const pass = type === 'Basic' && value ? Buffer.from(value, 'base64').toString().split(':').slice(1).join(':') : '';
  if (config.adminPassword && safeEqual(pass, config.adminPassword)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Admin"').sendStatus(401);
}
const COST_PER_MSG = Number(process.env.COST_PER_MESSAGE_BRL || 0.035);

app.get('/admin', admin, page('admin.html'));
app.get('/api/admin/tenants', admin, (_req, res) => {
  const stats = Object.fromEntries(monthStats().map((s) => [s.tenant_id, s]));
  res.json({
    costPerMessage: COST_PER_MSG,
    dryRun: config.whatsapp.dryRun,
    whatsappConfigured: whatsappConfigured(),
    tenants: listTenants().map((t) => {
      const s = stats[t.id] || {};
      const msgs = (s.sent || 0) + (s.received || 0);
      return {
        id: t.id, name: t.name, phone: t.phone, plan: t.plan, status: t.status, statusLabel: statusLabel(t), access: accessState(t),
        google: t.hasGoogle, createdAt: t.createdAt, sent: s.sent || 0, received: s.received || 0, unknown: s.unknown || 0,
        estCost: +(msgs * COST_PER_MSG).toFixed(2),
      };
    }),
  });
});
app.post('/api/admin/tenants/:id/status', admin, (req, res) => {
  const status = String(req.body.status);
  if (!['trial', 'active', 'past_due', 'canceled'].includes(status)) return res.status(400).json({ error: 'status inválido' });
  const patch = { status, pastDueSince: status === 'past_due' ? new Date().toISOString() : null };
  if (req.body.plan && config.plans[req.body.plan]) patch.plan = req.body.plan;
  if (status === 'trial') patch.trialEndsAt = new Date(Date.now() + config.trialDays * 864e5).toISOString();
  res.json(updateTenant(Number(req.params.id), patch));
});
app.get('/api/admin/tenants/:id/link', admin, (req, res) => res.json({ url: magicLink(Number(req.params.id), '/app') }));

/** Simulador de WhatsApp (só no modo simulação): manda uma mensagem como se fosse o cliente. */
app.post('/api/admin/simulate', admin, asyncH(async (req, res) => {
  if (!config.whatsapp.dryRun) return res.status(400).json({ error: 'Simulador disponível só com WHATSAPP_DRY_RUN=true' });
  const from = String(req.body.phone || '').replace(/\D/g, '');
  if (from.length < 10) return res.status(400).json({ error: 'Informe o telefone com DDI e DDD' });
  const before = outbox.length;
  await handleIncoming({ from, text: String(req.body.text || ''), profileName: req.body.profileName || null, type: 'text' });
  res.json({ replies: outbox.slice(before).filter((m) => m.to === from) });
}));
app.post('/api/admin/tick', admin, asyncH(async (req, res) => {
  const before = outbox.length;
  const phone = String(req.body?.phone || '').replace(/\D/g, '');
  if (phone) {
    const t = listTenants().find((x) => x.phone === phone);
    if (t) await processTenant(t, new Date(), { forceSync: true });
  } else await tick();
  res.json({ sent: outbox.slice(before) });
}));

app.use(express.static(pub, { index: false }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Erro interno' });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(config.port, () => {
    console.log(`\n📱 ${config.productName} rodando em ${config.baseUrl}`);
    console.log(`   Fuso: ${config.timezone} · WhatsApp: ${config.whatsapp.dryRun ? 'SIMULAÇÃO' : 'ativo'} · Google: ${config.demoMode ? 'DEMO (agenda fictícia)' : googleConfigured() ? 'configurado' : 'não configurado'} · Cobrança: ${billingConfigured() ? 'Asaas' : 'demo'}`);
    if (!config.adminPassword) console.log('   ⚠️  Defina ADMIN_PASSWORD para acessar /admin.');
    startScheduler();
  });
}

export default app;
