// Agendador: a cada minuto, para cada cliente, sincroniza a agenda (a cada N min) e envia o que estiver na hora.
import { accessState, magicLink, trialDaysLeft } from './account.js';
import { config } from './config.js';
import {
  getEvents, hasEventsCache, listTenants, pruneMessages, pruneSent, setEvents, takeQueue, updateTenant,
} from './db.js';
import { dispatch, isQuiet } from './dispatcher.js';
import { fetchEvents, isAuthError } from './google.js';
import { diffEvents } from './rules/analysis.js';
import { computeAlerts } from './rules/engine.js';
import { listRules } from './rules/scripts.js';
import { listTasks, tasksDueForReminder, tasksForDay } from './tasks.js';
import { addDays, dayKey, fmtDay, startOfDay } from './time.js';

const SYNC_DAYS = 8;

export async function syncTenant(tenant, now = new Date()) {
  if (!tenant.hasGoogle) return { ok: false, changes: [] };
  try {
    const prev = hasEventsCache(tenant.id) ? getEvents(tenant.id) : null;
    const events = await fetchEvents(tenant, startOfDay(now), addDays(startOfDay(now), SYNC_DAYS));
    setEvents(tenant.id, events);
    updateTenant(tenant.id, { lastSyncAt: now.toISOString(), googleError: null });
    return { ok: true, changes: diffEvents(prev, events, now) };
  } catch (err) {
    console.error(`[sync] cliente ${tenant.id}:`, err.message);
    const t = updateTenant(tenant.id, { googleError: err.message });
    if (isAuthError(err)) {
      await dispatch(t, {
        key: `google_err:${dayKey(now)}`, kind: 'conta', account: true,
        text: `⚠️ Perdi o acesso à sua Google Agenda (a permissão pode ter sido removida). Reconecte aqui para continuar recebendo os avisos:\n${magicLink(t.id, '/app/conectar-google')}`,
        template: { name: 'sec_alerta', params: ['perdi o acesso à sua Google Agenda. Reconecte pelo painel para continuar recebendo os avisos.'] },
      }, now);
    }
    return { ok: false, changes: [] };
  }
}

/** Avisos de fim do teste (3 dias, 1 dia, último dia). */
function accountNotices(t, now) {
  if (t.status !== 'trial') return [];
  const left = trialDaysLeft(t, now);
  const notice = (key, txt) => ({
    key, kind: 'conta', account: true,
    text: `${txt}\n\nPara continuar, escolha seu plano (Pix, cartão ou boleto):\n${magicLink(t.id, '/app#conta')}`,
    template: { name: 'sec_assinatura', params: [txt.replace(/^[^\p{L}]+/u, ''), `${config.baseUrl}/app`] },
  });
  if (left === 3) return [notice('trial:3d', `⏳ Faltam 3 dias para acabar seu teste grátis (até ${fmtDay(new Date(t.trialEndsAt))}).`)];
  if (left === 1) return [notice('trial:1d', '⏳ Seu teste grátis termina amanhã.')];
  if (left === 0 && accessState(t, now) === 'blocked') return [notice('trial:end', '⏸️ Seu teste grátis terminou e pausei seus avisos.')];
  return [];
}

const lastSync = new Map();

export async function processTenant(tenant, now = new Date(), { forceSync = false } = {}) {
  const sent = [];
  for (const n of accountNotices(tenant, now)) if (await dispatch(tenant, n, now) === 'sent') sent.push(n);
  if (accessState(tenant, now) === 'blocked') return sent;

  let changes = [];
  const due = forceSync || !lastSync.has(tenant.id) || now - lastSync.get(tenant.id) >= config.syncEveryMinutes * 60e3;
  if (tenant.hasGoogle && due) {
    lastSync.set(tenant.id, now.getTime());
    ({ changes } = await syncTenant(tenant, now));
  }

  const rules = listRules(tenant.id);
  const alerts = computeAlerts({
    tenant,
    rules,
    events: getEvents(tenant.id),
    openTasks: listTasks(tenant.id),
    todayTasks: tasksForDay(tenant.id, now),
    tomorrowTasks: tasksForDay(tenant.id, addDays(now, 1)).filter((x) => dayKey(x.dueAt) === dayKey(addDays(now, 1))),
    dueTasks: tasksDueForReminder(tenant.id, now),
    changes,
    now,
  });
  for (const a of alerts) if (await dispatch(tenant, a, now) === 'sent') sent.push(a);

  if (!isQuiet(tenant, now)) {
    for (const a of takeQueue(tenant.id)) if (await dispatch(tenant, a, now) === 'sent') sent.push(a);
  }
  return sent;
}

let running = false;
let lastPrune = '';

export async function tick(now = new Date()) {
  if (running) return;
  running = true;
  try {
    for (const t of listTenants()) {
      if (t.onboarding === 'ask_name') continue;
      try { await processTenant(t, now); } catch (err) { console.error(`[tick] cliente ${t.id}:`, err); }
    }
    if (lastPrune !== dayKey(now)) { lastPrune = dayKey(now); pruneSent(); pruneMessages(); }
  } finally {
    running = false;
  }
}

export function startScheduler() {
  tick();
  const timer = setInterval(() => tick(), 60e3);
  return () => clearInterval(timer);
}
