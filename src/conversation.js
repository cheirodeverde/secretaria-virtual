// Modo conversacional: recebe a mensagem do cliente, entende a intenção e responde.
// Escopo fechado (agenda, tarefas, configurações, conta) — sem conversa livre, por produto e por política da Meta.
import { accessState, magicLink, statusLabel, trialDaysLeft } from './account.js';
import {
  cannotEdit, conflictsFor, conflictText, doCancel, doCreate, doMove, doUndo, editableEvents, eventSummary, findEvents, guestsText,
  newTimes, pickLine, recurringText, whenText,
} from './calendar.js';
import { config } from './config.js';
import { createTenant, getEvents, getTenant, getTenantByPhone, logMessage, updateTenant } from './db.js';
import { reply } from './dispatcher.js';
import { canWrite } from './google.js';
import { normalize, parseDateTime } from './nlu/datetime.js';
import { parseEventText } from './nlu/event.js';
import { parseIntent } from './nlu/intents.js';
import { analyzeDay, dayAgendaText, freeSlots } from './rules/analysis.js';
import { ensureSystemRules } from './rules/scripts.js';
import {
  completeTask, createTask, deleteTask, dueLabel, findOpenByNum, getTask, listTasks, rescheduleTask, tasksText, whenLabel,
} from './tasks.js';
import { addDays, addMinutes, atTime, dayKey, fmtDay, fmtDayLong, fmtDuration, fmtTime, minutesBetween, startOfDay } from './time.js';

const P = config.productName;
const first = (n) => (n || '').trim().split(/\s+/)[0] || '';

export const HELP = [
  `🤖 *${P}* — o que eu entendo:`,
  '',
  '📅 *Agenda*: "agenda", "o que tenho amanhã?", "agenda sexta", "próximo compromisso", "livre", "semana"',
  ...(config.calendarWrite ? ['✍️ *Mexer na agenda*: "marcar reunião com João amanhã 15h", "agendar dentista sexta 10h por 40 min", "remarcar dentista pra 16h", "desmarcar reunião com João", "desfazer"'] : []),
  '📝 *Tarefas*: "tarefa ligar pro contador amanhã 10h", "anota: comprar embalagens", "tarefas", "feito 2", "adiar 1 para segunda", "apagar 3"',
  '⚙️ *Ajustes*: "resumo às 7h", "prévia às 21h", "lembrete 15 min antes", "não perturbe das 22h às 7h", "pausar", "retomar"',
  '🔐 *Conta*: "painel", "assinatura", "conectar"',
].join('\n');

function nameFrom(text) {
  const t = text.trim().replace(/^(meu nome (é|e)|me chamo|sou (o|a)|pode me chamar de|é|e)\s+/i, '').replace(/[.!]+$/, '').trim();
  if (!t || t.split(/\s+/).length > 4 || /\d|@|http/.test(t)) return null;
  return t.split(/\s+/).map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join(' ');
}

const connectLink = (t) => magicLink(t.id, '/app/conectar-google');
const accessNote = () => (config.calendarWrite ? 'eu só mexo nela quando você pedir e confirmar' : 'é só leitura, eu não altero nada');

const PENDING_MIN = 15;   // confirmações de agenda valem 15 min
const UNDO_MIN = 30;      // dá para desfazer a última alteração por 30 min
const YES_NO = [{ id: 'sim', title: '✅ Confirmar' }, { id: 'nao', title: '✖️ Não' }];
const fresh = (iso, now, min) => Boolean(iso) && now - new Date(iso) < min * 60e3;
const reviveDraft = (d) => ({ ...d, start: new Date(d.start), end: new Date(d.end) });

const blockedText = (t, now) => {
  const why = t.status === 'canceled' ? 'Sua assinatura foi cancelada'
    : t.status === 'past_due' ? 'Seu pagamento está pendente'
      : `Seu teste grátis de ${config.trialDays} dias terminou`;
  return `⏸️ ${why}, então pausei seus avisos.\n\nPara continuar com sua secretária, escolha um plano (Pix, cartão ou boleto):\n${magicLink(t.id, '/app#conta')}`;
};

/**
 * Lógica pura da conversa (usa o banco, mas não envia nada).
 * Retorna { messages: [{text, buttons?}], intent, tenant }.
 */
export async function respond(tenant, text, now = new Date(), { type = 'text' } = {}) {
  let t = tenant;
  const ctx = { ...t.ctx };
  const out = [];
  const say = (txt, extra = {}) => out.push({ text: txt, ...extra });
  const save = (patch = {}) => { t = updateTenant(t.id, { ...patch, ctx }); };

  if (type !== 'text' && type !== 'interactive' && type !== 'button') {
    say(type === 'audio' ? '🎙️ Ainda não consigo ouvir áudios. Pode me mandar por texto?' : 'Por enquanto eu só entendo mensagens de texto. 🙂');
    return { messages: out, intent: 'midia', tenant: t };
  }

  const p = parseIntent(text, now);

  // ---------------------------------------------------------------- cadastro
  if (t.onboarding === 'ask_name') {
    let name = null;
    if (p.intent === 'confirmar' && ctx.suggestedName) name = ctx.suggestedName;
    else if (!['saudacao', 'ajuda'].includes(p.intent)) name = nameFrom(text);
    if (!name) {
      say(ctx.suggestedName ? `Posso te chamar de *${ctx.suggestedName}*? Responda SIM ou me diga seu nome.` : 'Para começar, *como você se chama?*');
      return { messages: out, intent: 'cadastro_nome', tenant: t };
    }
    delete ctx.suggestedName;
    save({ name, onboarding: 'connect_google' });
    say(`Prazer, ${first(name)}! 😊\n\nAgora conecte sua Google Agenda — leva 30 segundos e ${accessNote()}:\n${connectLink(t)}\n\nEnquanto isso, já pode me mandar tarefas. Exemplo:\n"tarefa ligar pro contador amanhã 10h"`);
    return { messages: out, intent: 'cadastro_nome', tenant: t };
  }

  // ---------------------------------------------------------------- conta bloqueada
  if (accessState(t, now) === 'blocked' && !['assinatura', 'painel', 'ajuda'].includes(p.intent)) {
    say(blockedText(t, now));
    return { messages: out, intent: 'bloqueado', tenant: t };
  }

  const s = t.settings;
  const events = getEvents(t.id);
  const needCalendar = () => {
    if (t.hasGoogle) return false;
    say(`🔗 Sua Google Agenda ainda não está conectada. Conecte aqui (${accessNote()}):\n${connectLink(t)}`);
    return true;
  };
  const lastNum = () => ctx.lastTaskNum ?? null;

  // ---------------------------------------------------------------- agenda: criar / remarcar / cancelar
  const needWrite = () => {
    if (needCalendar()) return true;
    if (!config.calendarWrite) { say('Por enquanto eu só leio sua agenda. Para marcar ou mudar um compromisso, use o Google Agenda. 🙏'); return true; }
    if (canWrite(t)) return false;
    say(`✍️ Para eu marcar e remarcar compromissos, preciso da sua permissão para editar a agenda (hoje tenho só leitura).\n\nToque para autorizar, leva 30 segundos:\n${connectLink(t)}\n\nEu só altero algo quando você pedir e confirmar.`);
    return true;
  };
  const ask = (pending, txt, buttons) => { ctx.pending = { ...pending, at: now.toISOString() }; say(txt, buttons ? { buttons } : {}); save(); };

  const proposeCreate = (draft) => {
    if (!draft.title || draft.title.length < 2) {
      ask({ type: 'cal_need_title', draft: { ...draft, start: draft.start?.toISOString(), end: draft.end?.toISOString() } }, 'Qual é o compromisso? Ex.: "reunião com João".');
      return;
    }
    if (!draft.start || (!draft.hasTime && !draft.allDay)) {
      ask({ type: 'cal_need_time', title: draft.title, location: draft.location, online: draft.online, durationMin: draft.durationMin, day: draft.start?.toISOString() || null },
        `Que ${draft.start ? 'horas' : 'dia e horário'}${draft.start ? ` (${fmtDay(draft.start)})` : ''} para *${draft.title}*? Ex.: "${draft.start ? '15h' : 'amanhã 15h'}" ou "o dia todo".`);
      return;
    }
    if (draft.end <= now) { say('⏰ Esse horário já passou. Me diga outro dia ou horário.'); return; }
    if (draft.start > addDays(startOfDay(now), 366)) { say('Consigo marcar até 1 ano à frente. 🙂'); return; }
    const clash = draft.allDay ? [] : conflictsFor(events, draft.start, draft.end);
    ask({ type: 'cal_confirm', action: 'create', draft: { ...draft, start: draft.start.toISOString(), end: draft.end.toISOString() } },
      `📅 Vou marcar na sua agenda:\n${eventSummary(draft, now)}${conflictText(clash)}\n\nConfirma?`, YES_NO);
  };

  const proposeMove = (ev, target) => {
    const why = cannotEdit(ev);
    if (why) { say(`🔒 ${why}`); return; }
    if (!target?.found) {
      ask({ type: 'cal_need_target', eventId: ev.id }, `Para quando eu passo *${ev.title}* (${whenText(ev, now)})? Ex.: "sexta 10h" ou "16h".`);
      return;
    }
    const nt = newTimes(ev, target);
    if (nt.start.getTime() === ev.start.getTime()) { say(`*${ev.title}* já está ${whenText(ev, now)}. 🙂`); return; }
    if (nt.end <= now) { say('⏰ Esse horário já passou. Me diga outro dia ou horário.'); return; }
    const clash = nt.allDay ? [] : conflictsFor(events, nt.start, nt.end, ev.id);
    ask({ type: 'cal_confirm', action: 'move', eventId: ev.id, start: nt.start.toISOString(), end: nt.end.toISOString() },
      `🔁 Remarcar *${ev.title}*\nDe: ${whenText(ev, now)}\nPara: ${whenText({ ...ev, ...nt }, now)}${guestsText(ev, 'do novo horário')}${recurringText(ev)}${conflictText(clash)}\n\nConfirma?`, YES_NO);
  };

  const proposeCancel = (ev) => {
    const why = cannotEdit(ev);
    if (why) { say(`🔒 ${why}`); return; }
    ask({ type: 'cal_confirm', action: 'cancel', eventId: ev.id },
      `🗑️ Cancelar este compromisso?\n${eventSummary(ev, now)}${guestsText(ev, 'do cancelamento')}${recurringText(ev)}\n\nConfirma?`, YES_NO);
  };

  /** Acha o compromisso citado; se houver vários, pergunta qual. */
  const withEvent = (action, { query, day, at }, extra, go) => {
    let found = findEvents(editableEvents(t.id, now), query, { day, now });
    if (at && found.some((e) => e.start.getTime() === at.getTime())) found = found.filter((e) => e.start.getTime() === at.getTime());
    if (!found.length) {
      const label = query ? `"${query}"` : 'esse compromisso';
      say(`🔎 Não achei ${label} na sua agenda${day ? ` de ${fmtDay(day)}` : ' dos próximos dias'}.\n\nResponda AGENDA para ver seus compromissos, ou diga o nome como está na agenda.`);
      return;
    }
    if (found.length === 1) { go(found[0]); return; }
    const list = found.slice(0, 5);
    ask({ type: 'cal_pick', action, ids: list.map((e) => e.id), ...extra },
      [`Achei ${found.length > 5 ? 'vários' : list.length} compromissos. Qual deles?`, ...list.map((e, i) => pickLine(e, i, now)), '', 'Responda com o número.'].join('\n'));
  };

  const draftFrom = (txt) => {
    const ev = parseEventText(txt, now, { defaultMin: Number(s.defaultEventMin) || 60 });
    return { title: ev.title, start: ev.start, end: ev.end, allDay: ev.allDay, hasTime: ev.hasTime, location: ev.location, online: ev.online, durationMin: ev.durationMin };
  };

  async function executePending(pd) {
    const findCached = (id) => getEvents(t.id).find((e) => e.id === id);
    let done;
    try {
      if (pd.action === 'create') {
        const e = await doCreate(t, reviveDraft(pd.draft));
        done = { action: 'create', before: null, after: e };
        say(`✅ Marcado!\n${eventSummary(e, now)}\n\nErrou algo? Responda DESFAZER.`);
      } else {
        const ev = findCached(pd.eventId);
        if (!ev) { say('🤔 Esse compromisso não está mais na sua agenda. Responda AGENDA para conferir.'); return; }
        if (pd.action === 'move') {
          const e = await doMove(t, ev, new Date(pd.start), new Date(pd.end));
          done = { action: 'move', before: ev, after: e };
          say(`✅ Remarcado: *${e.title}* agora é ${whenText(e, now)}.${guestsText(ev, 'do novo horário')}\n\nErrou algo? Responda DESFAZER.`);
        } else {
          await doCancel(t, ev);
          done = { action: 'cancel', before: ev, after: null };
          say(`🗑️ Cancelado: *${ev.title}* (${whenText(ev, now)}).${guestsText(ev, 'do cancelamento')}\n\nErrou? Responda DESFAZER.`);
        }
      }
      ctx.lastCal = { ...done, at: now.toISOString() };
    } catch (err) {
      if (err.kind === 'auth' || err.kind === 'forbidden') say(`⚠️ ${err.message}\nAutorize de novo aqui:\n${connectLink(t)}`);
      else say(`⚠️ ${err.message}`);
    }
  }

  // Respostas a perguntas pendentes de agenda (escolha por número, horário que faltou, título que faltou)
  if (ctx.pending?.type?.startsWith('cal_') && !fresh(ctx.pending.at, now, PENDING_MIN)) { delete ctx.pending; save(); }
  const pend = ctx.pending;
  if (pend?.type === 'cal_pick') {
    const pick = normalize(String(text)).trim().match(/^(?:o|a|opcao|numero|n[o.]?)?\s*(\d{1,2})[º°o]?$/);
    if (pick) {
      const ev = getEvents(t.id).find((e) => e.id === pend.ids[Number(pick[1]) - 1]);
      delete ctx.pending;
      if (!ev) { say(`Responda um número de 1 a ${pend.ids.length}.`); ctx.pending = pend; save(); return { messages: out, intent: 'agenda_escolha', tenant: t }; }
      if (pend.action === 'move') proposeMove(ev, pend.target ? parseDateTime(pend.target, now) : null);
      else proposeCancel(ev);
      save();
      return { messages: out, intent: 'agenda_escolha', tenant: t };
    }
  }
  if (['cal_need_time', 'cal_need_target', 'cal_need_title'].includes(pend?.type) && !['negar', 'ajuda', 'confirmar'].includes(p.intent)) {
    if (pend.type === 'cal_need_title' && p.intent === 'nao_entendido') {
      delete ctx.pending;
      const d = reviveDraft(pend.draft);
      proposeCreate({ ...d, start: pend.draft.start ? d.start : null, end: pend.draft.end ? d.end : null, title: String(text).trim().replace(/^./, (c) => c.toUpperCase()) });
      save();
      return { messages: out, intent: 'marcar_evento', tenant: t };
    }
    const w = parseDateTime(text, now);
    const allDay = /\bdia (todo|inteiro)\b/.test(normalize(String(text)));
    if (w.found || allDay) {
      delete ctx.pending;
      if (pend.type === 'cal_need_target') {
        const ev = getEvents(t.id).find((e) => e.id === pend.eventId);
        if (ev) proposeMove(ev, w); else say('🤔 Esse compromisso não está mais na sua agenda.');
      } else {
        // Ex.: pediu "marcar dentista sexta" → perguntei a hora → respondeu "10h por 40 min"
        const ev = parseEventText(text, now, { defaultMin: Number(s.defaultEventMin) || 60 });
        const isAllDay = allDay || ev.allDay;
        let start = ev.start || w.date;
        if (pend.day && !w.hasDay) {
          const time = start;
          start = new Date(pend.day);
          if (time && !isAllDay) start.setHours(time.getHours(), time.getMinutes(), 0, 0);
        }
        if (!start) { ask(pend, `Qual dia? Ex.: "amanhã" ou "sexta o dia todo".`); return { messages: out, intent: 'marcar_evento', tenant: t }; }
        if (isAllDay) start = startOfDay(start);
        const durMin = ev.durationMin ?? pend.durationMin ?? (ev.end && ev.start ? (ev.end - ev.start) / 60e3 : Number(s.defaultEventMin) || 60);
        proposeCreate({
          title: pend.title, location: ev.location || pend.location, online: ev.online || pend.online, durationMin: durMin,
          start, end: isAllDay ? addDays(start, 1) : addMinutes(start, durMin), allDay: isAllDay, hasTime: !isAllDay && w.hasTime,
        });
      }
      save();
      return { messages: out, intent: pend.type === 'cal_need_target' ? 'remarcar_evento' : 'marcar_evento', tenant: t };
    }
  }
  // Qualquer outro assunto descarta a pergunta de agenda em aberto (evita confirmar algo antigo sem querer).
  if (ctx.pending?.type?.startsWith('cal_') && !['confirmar', 'negar'].includes(p.intent)) { delete ctx.pending; save(); }

  switch (p.intent) {
    case 'saudacao': {
      const next = events.filter((e) => !e.allDay && e.busy !== false && e.start > now && dayKey(e.start) === dayKey(now)).sort((a, b) => a.start - b.start)[0];
      const open = listTasks(t.id);
      const lines = [`Oi, ${first(t.name)}! 👋`];
      if (t.hasGoogle) lines.push(next ? `📅 Próximo compromisso: *${next.title}* às ${fmtTime(next.start)}.` : '📅 Sem mais compromissos hoje.');
      lines.push(open.length ? `📝 ${open.length} tarefa(s) pendente(s) — responda TAREFAS.` : '📝 Nenhuma tarefa pendente.');
      lines.push('', 'Me mande uma tarefa ou pergunte da agenda. AJUDA mostra tudo que eu entendo.');
      say(lines.join('\n'));
      break;
    }
    case 'ajuda': say(HELP); break;
    case 'agradecimento': say('Por nada! 😊 Estou por aqui.'); break;

    case 'agenda': {
      if (needCalendar()) break;
      const day = p.date ? startOfDay(p.date) : startOfDay(now);
      if (day > addDays(startOfDay(now), 7)) { say('Por enquanto eu enxergo só os próximos 7 dias da agenda.'); break; }
      say(dayAgendaText(analyzeDay(events, day, s), s, { header: `📋 Agenda de ${fmtDayLong(day)}` }));
      break;
    }
    case 'proximo': {
      if (needCalendar()) break;
      const next = events.filter((e) => !e.allDay && e.busy !== false && e.start > now).sort((a, b) => a.start - b.start)[0];
      if (!next) { say('📭 Nenhum compromisso nos próximos dias.'); break; }
      const mins = minutesBetween(now, next.start);
      const when = dayKey(next.start) === dayKey(now) ? `hoje às ${fmtTime(next.start)} (em ${fmtDuration(mins)})` : `${fmtDay(next.start)} às ${fmtTime(next.start)}`;
      say(`➡️ Próximo: *${next.title}* — ${when}${next.location ? `\n📍 ${next.location}` : next.meetLink ? `\n💻 ${next.meetLink}` : ''}`);
      break;
    }
    case 'livre': {
      if (needCalendar()) break;
      const day = p.date ? startOfDay(p.date) : startOfDay(now);
      const isToday = dayKey(day) === dayKey(now);
      const from = isToday && now > atTime(day, s.workStart) ? now : atTime(day, s.workStart);
      const slots = freeSlots(events.filter((e) => !e.allDay), from, atTime(day, s.workEnd), 30);
      const label = isToday ? 'hoje' : fmtDay(day);
      say(slots.length
        ? [`🟢 Horários livres ${label} (expediente ${s.workStart}–${s.workEnd}):`, ...slots.map((x) => `• ${fmtTime(x.start)}–${fmtTime(x.end)} (${fmtDuration(minutesBetween(x.start, x.end))})`)].join('\n')
        : `😅 Sem horários livres de 30 min ou mais ${label} dentro do expediente.`);
      break;
    }
    case 'semana': {
      if (needCalendar()) break;
      const lines = ['🗓 Próximos 7 dias:'];
      for (let i = 0; i < 7; i++) {
        const day = addDays(startOfDay(now), i);
        const a = analyzeDay(events, day, s);
        const flags = [a.conflicts.length && '⚠️ conflito', a.overloaded && '🔥 pesado'].filter(Boolean).join(' ');
        lines.push(`• ${fmtDay(day)}: ${a.timed.length} compromisso(s), ${fmtDuration(a.busyMin)} ${flags}`.trimEnd());
      }
      say(lines.join('\n'));
      break;
    }

    // ---------------------------------------------------------- mexer na agenda
    case 'marcar_evento': {
      if (needWrite()) break;
      if (!p.text) { say('O que eu marco? Ex.: "marcar reunião com João amanhã 15h" ou "agendar dentista sexta 10h por 40 min".'); break; }
      proposeCreate(draftFrom(p.text));
      break;
    }
    case 'remarcar_evento': {
      if (needWrite()) break;
      const target = p.target ? parseDateTime(p.target, now) : null;
      withEvent('move', p, { target: p.target }, (ev) => proposeMove(ev, target));
      break;
    }
    case 'cancelar_evento': {
      if (needWrite()) break;
      if (!p.query && !p.day) { say('Qual compromisso eu desmarco? Ex.: "desmarcar reunião com João" ou "cancelar dentista de sexta".'); break; }
      withEvent('cancel', p, {}, proposeCancel);
      break;
    }
    case 'desfazer': {
      if (!ctx.lastCal || !fresh(ctx.lastCal.at, now, UNDO_MIN)) { say('Não tenho nenhuma alteração recente na agenda para desfazer.'); delete ctx.lastCal; save(); break; }
      if (needWrite()) break;
      try { say(await doUndo(t, ctx.lastCal, now)); delete ctx.lastCal; } catch (err) { say(`⚠️ ${err.message}`); }
      save();
      break;
    }

    // ---------------------------------------------------------- tarefas
    case 'criar_tarefa': {
      if (!p.title || p.title.length < 2) { say('Qual é a tarefa? Ex.: "tarefa pagar fornecedor sexta"'); break; }
      const task = createTask(t.id, { title: p.title, dueAt: p.date, hasTime: p.hasTime });
      ctx.lastTaskNum = task.num;
      delete ctx.pending;
      const follow = task.hasTime ? `⏰ Vou te lembrar ${whenLabel(task.dueAt, true, now)}.`
        : task.dueAt ? `📌 Ela vai aparecer no resumo da manhã de ${dayKey(task.dueAt) === dayKey(now) ? 'hoje' : fmtDay(task.dueAt)}.`
          : `Sem prazo. Para definir: ADIAR ${task.num} PARA SEXTA 10H.`;
      say(`✅ Anotado! Tarefa ${task.num}: *${task.title}*${dueLabel(task, now)}\n${follow}`);
      save();
      break;
    }
    case 'listar_tarefas': {
      const tasks = listTasks(t.id);
      say(tasksText(tasks, now));
      break;
    }
    case 'concluir': {
      const list = p.nums.length ? p.nums : (lastNum() ? [lastNum()] : []);
      if (!list.length) { say(`Qual tarefa? Responda FEITO + número.\n\n${tasksText(listTasks(t.id), now)}`); break; }
      const done = []; const missing = [];
      for (const n of list) {
        const task = findOpenByNum(t.id, n);
        if (task) { completeTask(t.id, task.id, now); done.push(task); } else missing.push(n);
      }
      const left = listTasks(t.id).length;
      const lines = done.map((x) => `✅ Concluída: ${x.title}`);
      if (missing.length) lines.push(`Não achei a(s) tarefa(s) ${missing.join(', ')} em aberto.`);
      if (done.length) lines.push(left ? `Faltam ${left}.` : '🎉 Lista zerada! Bom trabalho.');
      delete ctx.lastTaskNum;
      say(lines.join('\n'));
      save();
      break;
    }
    case 'adiar': {
      const n = p.num ?? lastNum();
      const task = n ? findOpenByNum(t.id, n) : null;
      if (!task) { say(`Qual tarefa? Ex.: ADIAR 2 PARA AMANHÃ 9H.\n\n${tasksText(listTasks(t.id), now)}`); break; }
      let { date, hasTime } = p;
      if (!date) { // padrão: amanhã, mantendo a hora se houver
        date = addDays(task.dueAt && task.dueAt > now ? task.dueAt : now, 1);
        hasTime = task.hasTime;
        if (!hasTime) date = startOfDay(date);
      }
      rescheduleTask(t.id, task.id, date, hasTime);
      ctx.lastTaskNum = task.num;
      say(`⏰ Tarefa ${task.num} (${task.title}) adiada para ${whenLabel(date, hasTime, now)}.`);
      save();
      break;
    }
    case 'apagar': {
      if (!p.nums.length) { say('Qual tarefa? Responda APAGAR + número.'); break; }
      const gone = [];
      for (const n of p.nums) { const task = findOpenByNum(t.id, n); if (task) { deleteTask(t.id, task.id); gone.push(task.title); } }
      say(gone.length ? `🗑️ Apagada(s): ${gone.join(', ')}` : 'Não encontrei essa tarefa em aberto.');
      break;
    }
    case 'botao_done':
    case 'botao_snooze1h':
    case 'botao_tomorrow': {
      const task = getTask(t.id, p.taskId);
      if (!task || task.status !== 'open') { say('Essa tarefa já foi resolvida. 👍'); break; }
      if (p.intent === 'botao_done') {
        completeTask(t.id, task.id, now);
        const left = listTasks(t.id).length;
        say(`✅ Concluída: ${task.title}${left ? `\nFaltam ${left}.` : '\n🎉 Lista zerada!'}`);
      } else {
        const date = p.intent === 'botao_snooze1h' ? new Date(Math.ceil(addMinutes(now, 60).getTime() / 300e3) * 300e3)
          : (() => { const d = addDays(startOfDay(now), 1); const ref = task.hasTime ? task.dueAt : atTime(now, '09:00'); d.setHours(ref.getHours(), ref.getMinutes(), 0, 0); return d; })();
        rescheduleTask(t.id, task.id, date, true);
        say(`⏰ Combinado, te lembro de novo ${whenLabel(date, true, now)}.`);
      }
      break;
    }

    // ---------------------------------------------------------- ajustes
    case 'config': {
      const settings = { ...s };
      if (p.key === 'quiet') [settings.quietStart, settings.quietEnd] = p.value;
      else settings[p.key] = p.value;
      save({ settings });
      const msg = {
        briefingTime: `☀️ Pronto! Seu resumo da manhã agora chega às ${p.value}.`,
        previewTime: `🌙 Pronto! A prévia de amanhã agora chega às ${p.value}.`,
        reminderLeadMin: `⏰ Pronto! Lembretes de compromissos online ${p.value} min antes (presenciais consideram o deslocamento).`,
        quiet: `🌙 "Não perturbe" das ${settings.quietStart} às ${settings.quietEnd}. Lembretes de compromisso ainda passam.`,
      }[p.key];
      say(msg);
      break;
    }
    case 'pausar': save({ settings: { ...s, paused: true } }); say('⏸️ Avisos pausados. Ainda respondo suas mensagens. Para voltar: RETOMAR.'); break;
    case 'retomar': save({ settings: { ...s, paused: false } }); say('▶️ Avisos retomados!'); break;
    case 'painel': say(`🔐 Seu link de acesso ao painel (vale 15 min, uso único):\n${magicLink(t.id, '/app')}`); break;
    case 'conectar_google':
      if (t.hasGoogle && config.calendarWrite && !canWrite(t)) say(`✅ Sua agenda está conectada (${t.googleEmail || 'Google'}), só para leitura.\n\nPara eu também marcar e remarcar compromissos, autorize aqui:\n${connectLink(t)}`);
      else say(t.hasGoogle ? `✅ Sua agenda já está conectada (${t.googleEmail || 'Google'}).` : `🔗 Conecte sua Google Agenda (${accessNote()}):\n${connectLink(t)}`);
      break;
    case 'assinatura': {
      const days = trialDaysLeft(t, now);
      const extra = t.status === 'active' ? 'Para trocar de plano ou cancelar, use o painel:' : 'Para assinar (Pix, cartão ou boleto):';
      say(`💳 Sua conta: ${statusLabel(t, now)}.${days ? ` Seu teste vai até ${fmtDay(new Date(t.trialEndsAt))}.` : ''}\n\n${extra}\n${magicLink(t.id, '/app#conta')}`);
      break;
    }

    // ---------------------------------------------------------- confirmações e fallback
    case 'confirmar': {
      if (ctx.pending?.type === 'cal_confirm') {
        const pd = ctx.pending;
        delete ctx.pending;
        save();
        if (needWrite()) break;
        await executePending(pd);
        save();
      } else if (ctx.pending?.type?.startsWith('cal_')) {
        say('Ainda falta uma informação: responda a pergunta acima, ou NÃO para deixar pra lá.');
      } else if (ctx.pending?.type === 'task_from_text') {
        const parsed = parseDateTime(ctx.pending.text, now);
        const task = createTask(t.id, { title: parsed.rest || ctx.pending.text, dueAt: parsed.date, hasTime: parsed.hasTime });
        ctx.lastTaskNum = task.num;
        delete ctx.pending;
        say(`✅ Anotado! Tarefa ${task.num}: *${task.title}*${dueLabel(task, now)}`);
        save();
      } else say('👍');
      break;
    }
    case 'negar': {
      const wasCal = ctx.pending?.type?.startsWith('cal_');
      delete ctx.pending; save();
      say(wasCal ? 'Ok, não mexi na agenda. 👍' : 'Ok, deixei pra lá. 👍');
      break;
    }
    default: {
      const raw = String(text).trim();
      const words = raw.split(/\s+/).length;
      if (/\?\s*$/.test(raw) || words < 2 || raw.length > 200) {
        say(`🤔 Não entendi. Eu cuido da sua agenda e das suas tarefas. Tente:\n• "agenda amanhã"\n• "tarefa ligar pro João sexta 10h"\n• "tarefas"\n\nAJUDA mostra tudo.`);
        delete ctx.pending;
      } else {
        ctx.pending = { type: 'task_from_text', text: raw };
        say(`🤔 Não entendi direito. Quer que eu anote como tarefa?\n"${raw}"\n\nResponda SIM, ou AJUDA para ver o que eu entendo.`);
      }
      save();
    }
  }

  // Lembrete suave para conectar a agenda (no máximo 1x por dia)
  if (!t.hasGoogle && t.onboarding !== 'ask_name' && ctx.nudgedOn !== dayKey(now) && !['conectar_google', 'agenda', 'proximo', 'livre', 'semana', 'marcar_evento', 'remarcar_evento', 'cancelar_evento', 'desfazer'].includes(p.intent)) {
    ctx.nudgedOn = dayKey(now);
    save();
    out[out.length - 1].text += '\n\n🔗 Falta conectar sua Google Agenda — responda CONECTAR.';
  }

  return { messages: out, intent: p.intent, tenant: t };
}

/** Novo número: cria a conta em teste e dá boas-vindas. */
function welcome(tenant, profileName) {
  const suggested = profileName ? nameFrom(profileName) : null;
  if (suggested) updateTenant(tenant.id, { ctx: { suggestedName: suggested } });
  const ask = suggested ? `Posso te chamar de *${suggested}*? Responda SIM ou me diga seu nome.` : 'Para começar: *como você se chama?*';
  return [{
    text: `👋 Olá! Eu sou a *${P}*, sua secretária no WhatsApp.\n\nEu acompanho sua Google Agenda, aviso dos compromissos com antecedência inteligente (inclusive a hora de sair) e cuido da sua lista de tarefas — tudo por aqui.\n\nVocê tem ${config.trialDays} dias grátis, sem cartão.\n\n${ask}`,
  }];
}

/** Ponto de entrada do webhook (e do simulador): registra, responde e envia. */
export async function handleIncoming({ from, text = '', type = 'text', profileName = null }, now = new Date()) {
  const phone = String(from).replace(/\D/g, '');
  let tenant = getTenantByPhone(phone);
  let messages;
  let intent;
  if (!tenant) {
    tenant = createTenant(phone, now);
    ensureSystemRules(tenant.id);
    tenant = updateTenant(tenant.id, { lastInboundAt: now.toISOString() });
    logMessage({ tenantId: tenant.id, dir: 'in', text, intent: 'novo_cliente' });
    messages = welcome(tenant, profileName);
    intent = 'boas_vindas';
  } else {
    tenant = updateTenant(tenant.id, { lastInboundAt: now.toISOString() });
    const r = await respond(tenant, text, now, { type });
    ({ messages, intent } = r);
    tenant = getTenant(tenant.id);
    logMessage({ tenantId: tenant.id, dir: 'in', text, intent });
  }
  for (const m of messages) await reply(tenant, m, { intent });
  return { tenant, messages, intent };
}
