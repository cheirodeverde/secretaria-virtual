// Análise da agenda — funções puras (sem I/O), fáceis de testar.
//
// Evento normalizado:
// { id, title, start: Date, end: Date, allDay, location, meetLink, attendees, busy, description }

import {
  addMinutes, atTime, dayKey, fmtDuration, fmtTime, minutesBetween, startOfDay,
} from '../time.js';

export const DEFAULT_SETTINGS = {
  calendarIds: 'primary',
  briefingTime: '07:30',     // resumo da manhã
  previewTime: '20:00',      // prévia de amanhã
  reminderLeadMin: 30,       // antecedência do lembrete (compromissos online / sem local)
  travelBufferMin: 30,       // tempo de deslocamento estimado para compromissos presenciais
  workStart: '08:00',
  workEnd: '18:00',
  quietStart: '22:00',       // não perturbe (lembretes de compromisso ainda passam)
  quietEnd: '07:00',
  maxMeetingHours: 6,        // acima disso o dia é considerado sobrecarregado
  focusMinMinutes: 60,       // menor bloco livre que vale sugerir como "tempo de foco"
  paused: false,
  defaultEventMin: 60,       // duração padrão de um compromisso marcado pelo WhatsApp sem hora de término
  writeCalendarId: '',       // agenda onde criar compromissos (vazio = a primeira de calendarIds)
};

const PREP_KEYWORDS = /(cliente|proposta|apresenta|pitch|entrevista|negocia|investidor|banco|contador|fornecedor|or[cç]amento|contrato|venda|reuni[aã]o com)/i;

// ---------------------------------------------------------------- análise

export const isPhysical = (e) => Boolean(e.location) && !/^https?:\/\//i.test(e.location.trim());
const busyTimed = (events) => events.filter((e) => !e.allDay && e.busy !== false);
const sortByStart = (events) => [...events].sort((a, b) => a.start - b.start || a.end - b.end);

export function eventsOnDay(events, day) {
  const k = dayKey(day);
  const d0 = startOfDay(day);
  return sortByStart(events.filter((e) => (e.allDay ? e.start <= d0 && e.end > d0 : dayKey(e.start) === k)));
}

/** Une intervalos ocupados sobrepostos. */
export function mergeBusy(events) {
  const out = [];
  for (const e of sortByStart(busyTimed(events))) {
    const last = out[out.length - 1];
    if (last && e.start <= last.end) last.end = new Date(Math.max(last.end, e.end));
    else out.push({ start: e.start, end: e.end });
  }
  return out;
}

export const busyMinutes = (events) => mergeBusy(events).reduce((s, i) => s + minutesBetween(i.start, i.end), 0);

/** Blocos livres dentro de [from, to) com pelo menos `minMinutes`. */
export function freeSlots(events, from, to, minMinutes) {
  const slots = [];
  let cursor = from;
  for (const b of mergeBusy(events)) {
    if (b.end <= cursor) continue;
    if (b.start >= to) break;
    if (b.start > cursor) slots.push({ start: cursor, end: new Date(Math.min(b.start, to)) });
    cursor = new Date(Math.max(cursor, b.end));
  }
  if (cursor < to) slots.push({ start: cursor, end: to });
  return slots.filter((s) => minutesBetween(s.start, s.end) >= minMinutes);
}

export function findConflicts(events) {
  const list = sortByStart(busyTimed(events));
  const out = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length && list[j].start < list[i].end; j++) {
      out.push({ a: list[i], b: list[j] });
    }
  }
  return out;
}

const normLoc = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Compromissos presenciais em locais diferentes sem tempo de deslocamento entre eles. */
export function findTightTransitions(events, travelBufferMin) {
  const list = sortByStart(busyTimed(events));
  const out = [];
  for (let i = 0; i + 1 < list.length; i++) {
    const a = list[i];
    const b = list[i + 1];
    const gap = minutesBetween(a.end, b.start);
    if (gap >= 0 && gap < travelBufferMin && isPhysical(a) && isPhysical(b) && normLoc(a.location) !== normLoc(b.location)) {
      out.push({ a, b, gap });
    }
  }
  return out;
}

export function needsPrep(e) {
  return PREP_KEYWORDS.test(`${e.title} ${e.description || ''}`) || (e.attendees || 0) >= 3;
}

export function analyzeDay(events, day, s = DEFAULT_SETTINGS) {
  const all = eventsOnDay(events, day);
  const timed = all.filter((e) => !e.allDay);
  const allDay = all.filter((e) => e.allDay);
  const busy = busyMinutes(timed);
  const lunchFrom = atTime(day, '11:30');
  const lunchTo = atTime(day, '14:30');
  const touchesLunch = timed.some((e) => e.busy !== false && e.start < lunchTo && e.end > lunchFrom);
  const lunchAtRisk = touchesLunch && freeSlots(timed, lunchFrom, lunchTo, 45).length === 0;
  return {
    day,
    timed,
    allDay,
    busyMin: busy,
    conflicts: findConflicts(timed),
    tight: findTightTransitions(timed, s.travelBufferMin),
    lunchAtRisk,
    overloaded: busy > s.maxMeetingHours * 60,
    focus: freeSlots(timed, atTime(day, s.workStart), atTime(day, s.workEnd), s.focusMinMinutes),
    prep: timed.filter(needsPrep),
  };
}

// ---------------------------------------------------------------- formatação

export const where = (e) => (isPhysical(e) ? ` 📍 ${e.location}` : e.meetLink ? ' 💻 online' : '');
export const eventLine = (e) => (e.allDay ? `• Dia todo: ${e.title}` : `• ${fmtTime(e.start)}–${fmtTime(e.end)} ${e.title}${where(e)}`);
export const slotLine = (s) => `• ${fmtTime(s.start)}–${fmtTime(s.end)} (${fmtDuration(minutesBetween(s.start, s.end))})`;
export const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

export function attentionItems(a, s = DEFAULT_SETTINGS) {
  const items = [];
  for (const c of a.conflicts) items.push(`Conflito: ${c.a.title} (${fmtTime(c.a.start)}) × ${c.b.title} (${fmtTime(c.b.start)})`);
  for (const t of a.tight) items.push(`Deslocamento apertado: ${t.a.title} → ${t.b.title} (só ${t.gap} min)`);
  if (a.lunchAtRisk) items.push('Sem pausa para almoço entre 11h30 e 14h30');
  if (a.overloaded) items.push(`Dia pesado: ${fmtDuration(a.busyMin)} em compromissos (seu limite: ${s.maxMeetingHours}h)`);
  return items;
}

export function attentionShort(a) {
  const tags = [];
  if (a.conflicts.length) tags.push(plural(a.conflicts.length, 'conflito de horário', 'conflitos de horário'));
  if (a.tight.length) tags.push('deslocamento apertado');
  if (a.lunchAtRisk) tags.push('sem pausa para almoço');
  if (a.overloaded) tags.push('dia sobrecarregado');
  return tags.length ? `Atenção: ${tags.join(', ')}.` : 'Nenhum conflito detectado.';
}

export function dayAgendaText(a, s = DEFAULT_SETTINGS, { header } = {}) {
  const lines = [];
  if (header) lines.push(header, '');
  if (!a.timed.length && !a.allDay.length) {
    lines.push('📭 Nenhum compromisso na agenda.');
    return lines.join('\n');
  }
  lines.push(`📅 ${plural(a.timed.length, 'compromisso', 'compromissos')} · ${fmtDuration(a.busyMin)} ocupadas`);
  for (const e of [...a.allDay, ...a.timed]) lines.push(eventLine(e));
  const att = attentionItems(a, s);
  if (att.length) lines.push('', '⚠️ Pontos de atenção', ...att.map((x) => `• ${x}`));
  return lines.join('\n');
}

export const mapsLink = (loc) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(loc)}`;

export function reminderLeadFor(e, s = DEFAULT_SETTINGS) {
  return isPhysical(e) ? s.travelBufferMin + 15 : s.reminderLeadMin;
}

/** Compara a agenda anterior com a atual e retorna mudanças que afetam as próximas 24h. */
export function diffEvents(prev, curr, now) {
  if (!prev) return [];
  const horizon = addMinutes(now, 24 * 60);
  const soon = (d) => d > now && d < horizon;
  const prevMap = new Map(prev.map((e) => [e.id, e]));
  const currMap = new Map(curr.map((e) => [e.id, e]));
  const changes = [];
  for (const e of curr) {
    const p = prevMap.get(e.id);
    if (!p) { if (soon(e.start)) changes.push({ type: 'added', event: e }); continue; }
    if (p.start.getTime() !== e.start.getTime() && (soon(e.start) || soon(p.start))) changes.push({ type: 'moved', event: e, prev: p });
  }
  for (const p of prev) if (!currMap.has(p.id) && soon(p.start)) changes.push({ type: 'cancelled', event: p });
  return changes;
}
