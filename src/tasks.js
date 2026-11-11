// Tarefas do empresário. Cada tarefa aberta tem um número curto (1, 2, 3...) usado na conversa ("feito 2").
import { sql } from './db.js';
import { addDays, dayKey, fmtDay, fmtTime, startOfDay } from './time.js';

const parse = (r) => r && ({
  id: r.id,
  num: r.num,
  title: r.title,
  dueAt: r.due_at ? new Date(r.due_at) : null,
  hasTime: Boolean(r.has_time),
  status: r.status,
  remindedAt: r.reminded_at,
  createdAt: r.created_at,
  doneAt: r.done_at,
});

/** Menor número livre entre as tarefas abertas (mantém os números pequenos). */
function nextNum(tenantId) {
  const used = new Set(sql().prepare("SELECT num FROM tasks WHERE tenant_id = ? AND status = 'open'").all(tenantId).map((r) => r.num));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

export function createTask(tenantId, { title, dueAt = null, hasTime = false }) {
  const clean = String(title).trim().replace(/\s+/g, ' ').slice(0, 200);
  if (!clean) throw new Error('Título vazio');
  const num = nextNum(tenantId);
  const r = sql().prepare('INSERT INTO tasks (tenant_id, num, title, due_at, has_time) VALUES (?, ?, ?, ?, ?)')
    .run(tenantId, num, clean.charAt(0).toUpperCase() + clean.slice(1), dueAt ? dueAt.toISOString() : null, hasTime ? 1 : 0);
  return getTask(tenantId, Number(r.lastInsertRowid));
}

export const getTask = (tenantId, id) => parse(sql().prepare('SELECT * FROM tasks WHERE tenant_id = ? AND id = ?').get(tenantId, id));
export const findOpenByNum = (tenantId, num) =>
  parse(sql().prepare("SELECT * FROM tasks WHERE tenant_id = ? AND num = ? AND status = 'open'").get(tenantId, Number(num)));

export function listTasks(tenantId, { status = 'open', limit = 100 } = {}) {
  const order = status === 'open' ? 'CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at, num' : 'done_at DESC';
  return sql().prepare(`SELECT * FROM tasks WHERE tenant_id = ? AND status = ? ORDER BY ${order} LIMIT ?`).all(tenantId, status, limit).map(parse);
}

export function completeTask(tenantId, id, at = new Date()) {
  sql().prepare("UPDATE tasks SET status = 'done', done_at = ? WHERE tenant_id = ? AND id = ?").run(at.toISOString(), tenantId, id);
}

export function deleteTask(tenantId, id) {
  sql().prepare("UPDATE tasks SET status = 'deleted' WHERE tenant_id = ? AND id = ?").run(tenantId, id);
}

export function rescheduleTask(tenantId, id, dueAt, hasTime) {
  sql().prepare('UPDATE tasks SET due_at = ?, has_time = ?, reminded_at = NULL WHERE tenant_id = ? AND id = ?')
    .run(dueAt ? dueAt.toISOString() : null, hasTime ? 1 : 0, tenantId, id);
}

export function updateTask(tenantId, id, { title, dueAt, hasTime }) {
  const t = getTask(tenantId, id);
  if (!t) return null;
  const oldDue = t.dueAt?.toISOString() ?? null;
  const newDue = dueAt === undefined ? oldDue : dueAt?.toISOString() ?? null;
  const newHasTime = hasTime === undefined ? t.hasTime : Boolean(hasTime);
  const reminded = newDue === oldDue && newHasTime === t.hasTime ? t.remindedAt : null;
  sql().prepare('UPDATE tasks SET title = ?, due_at = ?, has_time = ?, reminded_at = ? WHERE tenant_id = ? AND id = ?')
    .run(String(title ?? t.title).trim().slice(0, 200) || t.title, newDue, newHasTime ? 1 : 0, reminded, tenantId, id);
  return getTask(tenantId, id);
}

export const markReminded = (tenantId, id, at = new Date()) =>
  sql().prepare('UPDATE tasks SET reminded_at = ? WHERE tenant_id = ? AND id = ?').run(at.toISOString(), tenantId, id);

/** Tarefas com hora marcada que já venceram e ainda não foram lembradas (até 12h de atraso). */
export function tasksDueForReminder(tenantId, now = new Date()) {
  const from = new Date(now.getTime() - 12 * 3600e3).toISOString();
  return sql().prepare("SELECT * FROM tasks WHERE tenant_id = ? AND status = 'open' AND has_time = 1 AND reminded_at IS NULL AND due_at <= ? AND due_at > ?")
    .all(tenantId, now.toISOString(), from).map(parse);
}

/** Tarefas do dia (vencem hoje) e atrasadas. */
export function tasksForDay(tenantId, day) {
  const end = addDays(startOfDay(day), 1).toISOString();
  return listTasks(tenantId).filter((t) => t.dueAt && t.dueAt.toISOString() < end);
}

// ------------------------------------------------------------------ formatação

export function dueLabel(t, now = new Date()) {
  if (!t.dueAt) return '';
  const today = startOfDay(now);
  const k = dayKey(t.dueAt);
  const time = t.hasTime ? ` ${fmtTime(t.dueAt)}` : '';
  const late = t.hasTime ? t.dueAt < now : t.dueAt < today;
  let day;
  if (k === dayKey(today)) day = 'hoje';
  else if (k === dayKey(addDays(today, 1))) day = 'amanhã';
  else day = fmtDay(t.dueAt);
  return ` — ${day}${time}${late ? ' ⚠️ atrasada' : ''}`;
}

/** "hoje às 15:00", "amanhã", "sex, 13/11 às 14:00" */
export function whenLabel(dueAt, hasTime, now = new Date()) {
  const today = startOfDay(now);
  const k = dayKey(dueAt);
  const day = k === dayKey(today) ? 'hoje' : k === dayKey(addDays(today, 1)) ? 'amanhã' : fmtDay(dueAt);
  return hasTime ? `${day} às ${fmtTime(dueAt)}` : day;
}

export const taskLine = (t, now) => `${t.num}. ${t.title}${dueLabel(t, now)}`;

export function tasksText(tasks, now = new Date(), { header = '📝 Suas tarefas', empty = '✅ Nenhuma tarefa pendente. Para criar: "tarefa ligar pro contador amanhã 10h".' } = {}) {
  if (!tasks.length) return empty;
  return [`${header} (${tasks.length}):`, ...tasks.map((t) => taskLine(t, now)), '', 'Responda FEITO 1, ADIAR 1 PARA AMANHÃ ou APAGAR 1.'].join('\n');
}
