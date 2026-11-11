// Ações na agenda: achar o compromisso que o cliente citou, checar conflitos, executar e registrar.
// Toda alteração passa por aqui (WhatsApp e painel), atualiza o cache na hora e fica no histórico.
import { getEvents, logCalendar, removeCachedEvent, upsertCachedEvent } from './db.js';
import { CalendarError, cancelEvent, createEvent, moveEvent } from './google.js';
import { normalize } from './nlu/datetime.js';
import { isPhysical } from './rules/analysis.js';
import { addDays, dayKey, fmtDay, fmtDayLong, fmtTime, minutesBetween, startOfDay } from './time.js';

const STOP = new Set([
  'com', 'de', 'do', 'da', 'dos', 'das', 'o', 'a', 'os', 'as', 'e', 'um', 'uma', 'meu', 'minha', 'no', 'na', 'em', 'para', 'pra', 'pro',
  'evento', 'compromisso', 'agenda', 'horario', 'marcado', 'marcada', 'que', 'tenho', 'aquele', 'aquela', 'esse', 'essa', 'este', 'esta',
]);
const words = (s) => normalize(s).split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));

/** Eventos que ainda podem ser alterados (não terminaram e estão no cache dos próximos dias). */
export const editableEvents = (tenantId, now = new Date()) => getEvents(tenantId).filter((e) => e.end > now);

/**
 * Procura os compromissos que combinam com o texto ("reunião com João", "dentista", "o próximo").
 * day = filtra por dia. Retorna a lista ordenada da melhor para a pior combinação.
 */
export function findEvents(events, query, { day = null, now = new Date() } = {}) {
  let list = events.filter((e) => e.end > now);
  if (day) list = list.filter((e) => (e.allDay ? e.start <= startOfDay(day) && e.end > startOfDay(day) : dayKey(e.start) === dayKey(day)));
  list.sort((a, b) => a.start - b.start);
  const q = normalize(query || '');
  if (/\bproxim[oa]\b/.test(q)) return list.filter((e) => !e.allDay && e.start > now).slice(0, 1);
  const terms = words(query || '');
  if (!terms.length) return day ? list : [];
  const scored = list.map((e) => {
    const title = words(`${e.title} ${e.location || ''}`);
    const hits = terms.filter((t) => title.some((w) => w === t || (t.length >= 4 && (w.startsWith(t) || t.startsWith(w)))));
    return { e, score: hits.length / terms.length };
  }).filter((x) => x.score >= 0.5);
  scored.sort((a, b) => b.score - a.score || a.e.start - b.e.start);
  // Se um evento bate em tudo e os outros só em parte, fica só ele.
  if (scored.length > 1 && scored[0].score === 1 && scored[1].score < 1) return [scored[0].e];
  return scored.map((x) => x.e);
}

/** Compromissos ocupados que se sobrepõem a [start, end), ignorando o próprio evento. */
export function conflictsFor(events, start, end, ignoreId = null) {
  return events.filter((e) => e.id !== ignoreId && !e.allDay && e.busy !== false && e.start < end && e.end > start);
}

// ---------------------------------------------------------------- textos

export function whenText(e, now = new Date()) {
  const d = e.start;
  const day = dayKey(d) === dayKey(now) ? 'hoje' : dayKey(d) === dayKey(addDays(now, 1)) ? 'amanhã' : fmtDay(d);
  if (e.allDay) {
    const days = Math.round(minutesBetween(startOfDay(e.start), startOfDay(e.end)) / 1440);
    return days > 1 ? `${day} (dia todo, ${days} dias)` : `${day} (dia todo)`;
  }
  return `${day}, ${fmtTime(e.start)}–${fmtTime(e.end)}`;
}

export const eventSummary = (e, now = new Date()) => [
  `*${e.title}*`,
  `🗓 ${whenText(e, now)}`,
  e.location ? `📍 ${e.location}` : null,
  e.online || e.meetLink ? `💻 ${e.meetLink || 'com link do Google Meet'}` : null,
].filter(Boolean).join('\n');

export const conflictText = (list) => (list.length
  ? `\n\n⚠️ Choca com: ${list.slice(0, 3).map((c) => `${c.title} (${fmtTime(c.start)}–${fmtTime(c.end)})`).join(', ')}`
  : '');

export const guestsText = (e, verb) => ((e.attendees || 0) > 0
  ? `\n👥 ${e.attendees === 1 ? 'O convidado será avisado' : `Os ${e.attendees} convidados serão avisados`} pelo Google ${verb}.`
  : '');

export const recurringText = (e) => (e.recurring ? '\n🔁 É um compromisso que se repete: vou mexer só nesta data.' : '');

/** Por que não dá para mexer neste evento (ou null se dá). */
export function cannotEdit(e) {
  if (!e.mine) return `Esse compromisso é um convite${e.organizer ? ` de ${e.organizer}` : ''}: só quem organizou pode mudar o horário ou cancelar para todos.`;
  return null;
}

/** Calcula o novo início/fim de uma remarcação mantendo a duração. */
export function newTimes(event, target) {
  const dur = event.end - event.start;
  if (event.allDay) {
    const start = startOfDay(target.date);
    return { start, end: new Date(start.getTime() + dur), allDay: true };
  }
  let start;
  if (target.hasTime && target.hasDay) start = new Date(target.date);
  else if (target.hasTime) { // só o horário: mesmo dia do compromisso
    start = new Date(event.start);
    start.setHours(target.date.getHours(), target.date.getMinutes(), 0, 0);
  } else { // só o dia: mantém o horário
    start = new Date(target.date);
    start.setHours(event.start.getHours(), event.start.getMinutes(), 0, 0);
  }
  return { start, end: new Date(start.getTime() + dur), allDay: false };
}

export const nearLabel = (e) => `${fmtDayLong(e.start)}${e.allDay ? '' : ` às ${fmtTime(e.start)}`}`;

// ---------------------------------------------------------------- execução

const snap = (e) => e && ({ ...e, start: new Date(e.start).toISOString(), end: new Date(e.end).toISOString() });

async function run(tenant, action, fn, { title, before = null, source }) {
  try {
    const after = await fn();
    logCalendar({ tenantId: tenant.id, action, eventId: (after || before)?.id, title, before: snap(before), after: snap(after), source });
    return after;
  } catch (err) {
    const e = err instanceof CalendarError ? err : new CalendarError('other', 'Não consegui alterar a agenda agora. Tente de novo em alguns minutos.', err);
    console.error(`[agenda] cliente ${tenant.id} ${action}:`, e.cause?.message || e.message);
    logCalendar({ tenantId: tenant.id, action, eventId: before?.id, title, before: snap(before), source, error: e.cause?.message || e.message });
    throw e;
  }
}

export async function doCreate(tenant, draft, { source = 'whatsapp' } = {}) {
  const e = await run(tenant, 'create', () => createEvent(tenant, draft), { title: draft.title, source });
  upsertCachedEvent(tenant.id, e);
  return e;
}

export async function doMove(tenant, event, start, end, { source = 'whatsapp' } = {}) {
  const e = await run(tenant, 'move', () => moveEvent(tenant, event, start, end), { title: event.title, before: event, source });
  upsertCachedEvent(tenant.id, e);
  return e;
}

export async function doCancel(tenant, event, { source = 'whatsapp' } = {}) {
  await run(tenant, 'cancel', async () => { await cancelEvent(tenant, event); return null; }, { title: event.title, before: event, source });
  removeCachedEvent(tenant.id, event.id);
}

/** Desfaz a última ação (guardada no contexto da conversa). Retorna o texto de resposta. */
export async function doUndo(tenant, last, now = new Date()) {
  const revive = (e) => e && ({ ...e, start: new Date(e.start), end: new Date(e.end) });
  const before = revive(last.before);
  const after = revive(last.after);
  if (last.action === 'create') {
    await doCancel(tenant, after, { source: 'desfazer' });
    return `↩️ Desfeito: tirei *${after.title}* da agenda.`;
  }
  if (last.action === 'move') {
    const current = getEvents(tenant.id).find((e) => e.id === after.id) || after;
    const e = await doMove(tenant, current, before.start, before.end, { source: 'desfazer' });
    return `↩️ Desfeito: *${e.title}* voltou para ${whenText(e, now)}.`;
  }
  if (last.action === 'cancel') {
    const e = await doCreate(tenant, {
      title: before.title, start: before.start, end: before.end, allDay: before.allDay, location: before.location,
      description: before.description, online: false,
    }, { source: 'desfazer' });
    const lost = (before.attendees || 0) > 0 || before.meetLink ? '\n(Os convidados e o link da chamada não voltam: convide de novo pelo Google Agenda se precisar.)' : '';
    return `↩️ Desfeito: *${e.title}* voltou para a agenda (${whenText(e, now)}).${lost}`;
  }
  return 'Não tenho o que desfazer.';
}

/** Rótulo curto para listas de escolha ("1. Reunião com João — qui, 12/11 15:00"). */
export const pickLine = (e, i, now = new Date()) => `${i + 1}. ${e.title} — ${whenText(e, now)}${isPhysical(e) ? ' 📍' : ''}`;
