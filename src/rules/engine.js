// Motor de avisos: a partir da agenda, das tarefas e das regras do cliente, decide o que enviar agora.
// Funções puras (sem banco nem rede) — testáveis com dados fictícios.
//
// Aviso: { key, kind, text, template: { name, params }, bypassQuiet?, buttons?, taskId? }
//   key      → chave única (o mesmo aviso nunca sai duas vezes)
//   text     → mensagem completa (janela de 24h aberta)
//   template → modelo aprovado pela Meta (fora da janela)
import {
  addDays, addMinutes, atTime, dayKey, fmtDay, fmtDayLong, fmtDuration, fmtTime, minutesBetween, startOfDay,
} from '../time.js';
import {
  analyzeDay, attentionItems, attentionShort, eventLine, findConflicts, findTightTransitions, isPhysical, mapsLink,
  needsPrep, plural, reminderLeadFor, slotLine, where,
} from './analysis.js';
import { render, systemRule } from './scripts.js';
import { taskLine } from '../tasks.js';

const CATCH_UP_MIN = 120; // se o servidor ficou fora do ar, recupera avisos atrasados até 2h
const firstName = (n) => (n || '').trim().split(/\s+/)[0] || '';
const dueWindow = (now, at) => now >= at && now < addMinutes(at, CATCH_UP_MIN);
const busyTimed = (events) => events.filter((e) => !e.allDay && e.busy !== false).sort((a, b) => a.start - b.start);

// ------------------------------------------------------------------ resumo da manhã

function agendaBlock(a, hasCalendar) {
  if (!hasCalendar) return '🔗 Sua Google Agenda ainda não está conectada. Responda CONECTAR para receber o link.';
  if (!a.timed.length && !a.allDay.length) return '📭 Nenhum compromisso marcado.';
  const lines = [];
  if (a.timed.length) lines.push(`📅 ${plural(a.timed.length, 'compromisso', 'compromissos')} · ${fmtDuration(a.busyMin)} ocupadas`);
  for (const e of [...a.allDay, ...a.timed]) lines.push(eventLine(e));
  return lines.join('\n');
}

const attentionBlock = (a, s) => {
  const items = attentionItems(a, s);
  return items.length ? ['⚠️ Pontos de atenção', ...items.map((x) => `• ${x}`)].join('\n') : '';
};

export function buildBriefing({ tenant, rules, events, todayTasks = [], now }) {
  const s = tenant.settings;
  const rule = systemRule(rules, 'resumo_manha');
  const a = analyzeDay(events, now, s);
  const first = a.timed[0];
  const vars = {
    nome: firstName(tenant.name),
    data: fmtDayLong(now),
    agenda: agendaBlock(a, tenant.hasGoogle),
    atencao: attentionBlock(a, s),
    tarefas: todayTasks.length ? [`📝 Tarefas para hoje (${todayTasks.length}):`, ...todayTasks.map((t) => taskLine(t, now))].join('\n') : '',
    foco: a.focus.length && a.timed.length ? ['🎯 Tempo livre para foco', ...a.focus.map(slotLine)].join('\n') : '',
    qtd: String(a.timed.length),
    primeiro: first ? `${first.title} às ${fmtTime(first.start)}` : 'nenhum compromisso',
  };
  const tasksNote = todayTasks.length ? ` ${plural(todayTasks.length, 'tarefa', 'tarefas')} para hoje.` : '';
  return {
    key: `brief:${dayKey(now)}`,
    kind: 'resumo',
    text: render(rule.script, vars).replace(/^☀️ Bom dia, !/, '☀️ Bom dia!'),
    template: { name: 'sec_resumo_dia', params: [vars.qtd, first ? vars.primeiro : 'agenda livre', `${attentionShort(a)}${tasksNote}`] },
  };
}

// ------------------------------------------------------------------ prévia de amanhã

export function buildPreview({ tenant, rules, events, tomorrowTasks = [], now }) {
  const s = tenant.settings;
  const rule = systemRule(rules, 'previa_amanha');
  const tomorrow = addDays(startOfDay(now), 1);
  const a = analyzeDay(events, tomorrow, s);
  const first = a.timed[0];
  let cedo = '';
  if (first && first.start.getHours() < 9) {
    cedo = isPhysical(first) ? `⏰ Começa cedo: saia até ${fmtTime(addMinutes(first.start, -s.travelBufferMin))}.` : `⏰ Começa cedo: ${fmtTime(first.start)}.`;
  }
  const vars = {
    nome: firstName(tenant.name),
    data: fmtDayLong(tomorrow),
    agenda: [agendaBlock(a, tenant.hasGoogle), attentionBlock(a, s)].filter(Boolean).join('\n\n'),
    cedo,
    preparar: a.prep.length ? ['📝 Vale preparar hoje', ...a.prep.map((e) => `• ${e.title} (${fmtTime(e.start)})`)].join('\n') : '',
    tarefas: tomorrowTasks.length ? [`📌 Tarefas para amanhã (${tomorrowTasks.length}):`, ...tomorrowTasks.map((t) => taskLine(t, now))].join('\n') : '',
    qtd: String(a.timed.length),
    primeiro: first ? `${first.title} às ${fmtTime(first.start)}` : 'agenda livre',
  };
  const extra = cedo.replace(/^⏰ /, '') || (a.prep.length ? `${plural(a.prep.length, 'item', 'itens')} para preparar hoje.` : 'Boa noite e bom descanso.');
  return {
    key: `prev:${dayKey(tomorrow)}`,
    kind: 'previa',
    text: render(rule.script, vars),
    template: { name: 'sec_amanha', params: [vars.qtd, vars.primeiro, extra] },
  };
}

// ------------------------------------------------------------------ lembrete de compromisso

export function buildEventReminder({ event: e, events = [], tenant, rules, now }) {
  const s = tenant.settings;
  const rule = systemRule(rules, 'lembrete_compromisso');
  const leave = addMinutes(e.start, -s.travelBufferMin);
  const next = busyTimed(events).find((x) => x.id !== e.id && x.start >= e.end && dayKey(x.start) === dayKey(e.start));
  let onde = '';
  let extra = 'Sem local ou link definido.';
  if (isPhysical(e)) {
    onde = `📍 ${e.location}\n🚗 Saia até ${fmtTime(leave)} — rota: ${mapsLink(e.location)}`;
    extra = `Saia até ${fmtTime(leave)}. Local: ${e.location}.`;
  } else if (e.meetLink) {
    onde = `💻 Entrar: ${e.meetLink}`;
    extra = `Link: ${e.meetLink}`;
  }
  const vars = {
    minutos: String(Math.max(0, minutesBetween(now, e.start))),
    titulo: e.title,
    hora: fmtTime(e.start),
    onde,
    proximo: next ? `➡️ Na sequência: ${next.title} às ${fmtTime(next.start)}` : '',
    preparo: needsPrep(e) ? '📝 Revise a pauta e os materiais antes de começar.' : '',
    local: e.location || '',
    link: e.meetLink || '',
    saia_ate: isPhysical(e) ? fmtTime(leave) : '',
  };
  return {
    key: `rem:${e.id}:${e.start.toISOString()}`,
    kind: 'lembrete',
    bypassQuiet: true,
    text: render(rule.script, vars),
    template: { name: 'sec_lembrete', params: [e.title, fmtTime(e.start), extra] },
  };
}

export function dueEventReminders({ events, tenant, rules, now }) {
  return busyTimed(events)
    .filter((e) => e.start > now && addMinutes(e.start, -reminderLeadFor(e, tenant.settings)) <= now)
    .map((event) => buildEventReminder({ event, events, tenant, rules, now }));
}

// ------------------------------------------------------------------ alertas de agenda

export function scheduleAlerts({ events, tenant, rules, now }) {
  const s = tenant.settings;
  const horizon = addMinutes(now, 48 * 60);
  const upcoming = events.filter((e) => e.end > now && e.start < horizon);
  const out = [];
  const conf = systemRule(rules, 'alerta_conflito');
  if (conf.enabled) {
    for (const { a, b } of findConflicts(upcoming)) {
      out.push({
        key: `conf:${a.id}:${b.id}:${a.start.toISOString()}:${b.start.toISOString()}`,
        kind: 'alerta',
        text: render(conf.script, { dia: fmtDay(a.start), evento_a: `${fmtTime(a.start)}–${fmtTime(a.end)} ${a.title}`, evento_b: `${fmtTime(b.start)}–${fmtTime(b.end)} ${b.title}` }),
        template: { name: 'sec_alerta', params: [`conflito ${fmtDay(a.start)} entre ${a.title} (${fmtTime(a.start)}) e ${b.title} (${fmtTime(b.start)}).`] },
      });
    }
  }
  const tight = systemRule(rules, 'alerta_deslocamento');
  if (tight.enabled) {
    for (const { a, b, gap } of findTightTransitions(upcoming, s.travelBufferMin)) {
      out.push({
        key: `tight:${a.id}:${b.id}:${a.start.toISOString()}`,
        kind: 'alerta',
        text: render(tight.script, { dia: fmtDay(a.start), titulo_a: a.title, fim_a: fmtTime(a.end), titulo_b: b.title, inicio_b: fmtTime(b.start), intervalo: String(gap), local_b: b.location }),
        template: { name: 'sec_alerta', params: [`só ${gap} min entre ${a.title} e ${b.title} (${fmtDay(a.start)}), em locais diferentes.`] },
      });
    }
  }
  return out;
}

export function changeAlerts({ changes, rules }) {
  const rule = systemRule(rules, 'mudanca_agenda');
  if (!rule.enabled) return [];
  return changes.filter((c) => !c.event.allDay).map(({ type, event: e, prev }) => {
    const quando = `${fmtDay(e.start)} às ${fmtTime(e.start)}`;
    const texts = {
      added: [`Novo compromisso nas próximas 24h:\n${e.title} — ${quando}${where(e)}`, `novo compromisso ${e.title}, ${quando}.`],
      moved: [`Compromisso remarcado:\n${e.title}\nDe ${fmtDay(prev?.start || e.start)} ${fmtTime(prev?.start || e.start)} → para ${quando}`, `${e.title} foi remarcado para ${quando}.`],
      cancelled: [`Compromisso cancelado:\n${e.title} (${quando})\n\n🎯 Você ganhou ${fmtDuration(minutesBetween(e.start, e.end))} livres.`, `${e.title} (${quando}) foi cancelado.`],
    }[type];
    return {
      key: `chg:${type}:${e.id}:${e.start.toISOString()}`,
      kind: 'alerta',
      text: render(rule.script, { mudanca: texts[0], titulo: e.title, quando }),
      template: { name: 'sec_alerta', params: [texts[1]] },
    };
  });
}

// ------------------------------------------------------------------ tarefas

export function taskReminder({ task: t, rules, now }) {
  const rule = systemRule(rules, 'lembrete_tarefa');
  const late = minutesBetween(t.dueAt, now);
  const prazo = late > 5 ? ` (era para ${fmtTime(t.dueAt)})` : '';
  return {
    key: `task:${t.id}:${t.dueAt.toISOString()}`,
    kind: 'tarefa',
    taskId: t.id,
    taskNum: t.num,
    bypassQuiet: true,
    text: render(rule.script, { tarefa: t.title, numero: String(t.num), prazo }),
    buttons: [
      { id: `btn:done:${t.id}`, title: '✅ Feito' },
      { id: `btn:snooze1h:${t.id}`, title: '⏰ Adiar 1h' },
      { id: `btn:tomorrow:${t.id}`, title: '📅 Amanhã' },
    ],
    buttonsFallback: `Responda FEITO ${t.num} ou ADIAR ${t.num} PARA AMANHÃ.`,
    template: { name: 'sec_tarefa', params: [t.title] },
  };
}

// ------------------------------------------------------------------ regras personalizadas

const matchesFilter = (rule, e, day) => {
  const p = rule.params;
  if (p.weekdays?.length && !p.weekdays.includes(day.getDay())) return false;
  if (p.titleContains && !e.title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .includes(p.titleContains.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) return false;
  return true;
};

const customAlert = (rule, key, text) => ({
  key,
  kind: 'personalizada',
  text,
  template: { name: 'sec_personalizado', params: [text] },
});

export function eventVars(tenant, e) {
  return {
    nome: firstName(tenant.name), titulo: e.title, hora: fmtTime(e.start), fim: fmtTime(e.end), data: fmtDay(e.start),
    local: e.location || '', link: e.meetLink || '',
  };
}

export function dailyVars(tenant, events, openTasks, now) {
  const a = analyzeDay(events, now, tenant.settings);
  const first = a.timed.find((e) => e.end > now) || a.timed[0];
  return {
    nome: firstName(tenant.name), data: fmtDayLong(now), qtd: String(a.timed.length),
    primeiro: first ? `${first.title} às ${fmtTime(first.start)}` : 'nenhum compromisso', tarefas_qtd: String(openTasks.length),
  };
}

export function customRuleAlerts({ tenant, rules, events, openTasks = [], now }) {
  const out = [];
  for (const rule of rules) {
    if (rule.systemKey || !rule.enabled) continue;
    const p = rule.params;
    if (rule.trigger === 'daily') {
      if ((p.weekdays?.length && !p.weekdays.includes(now.getDay())) || !dueWindow(now, atTime(now, p.time))) continue;
      out.push(customAlert(rule, `rule:${rule.id}:${dayKey(now)}`, render(rule.script, dailyVars(tenant, events, openTasks, now))));
      continue;
    }
    for (const e of events) {
      if (e.allDay || !matchesFilter(rule, e, e.start)) continue;
      const at = rule.trigger === 'before_event' ? addMinutes(e.start, -p.offsetMin) : addMinutes(e.end, p.offsetMin);
      if (rule.trigger === 'before_event' ? !(now >= at && now < e.start) : !dueWindow(now, at)) continue;
      out.push(customAlert(rule, `rule:${rule.id}:${e.id}:${e.start.toISOString()}`, render(rule.script, eventVars(tenant, e))));
    }
  }
  return out;
}

/** Prévia de uma regra (painel): renderiza com o próximo evento real ou um exemplo. */
export function previewRule({ tenant, rule, events, openTasks = [], now }) {
  if (rule.trigger === 'daily') return render(rule.script, dailyVars(tenant, events, openTasks, now));
  const e = events.filter((x) => !x.allDay && x.end > now && matchesFilter(rule, x, x.start)).sort((a, b) => a.start - b.start)[0]
    || { title: 'Reunião com cliente (exemplo)', start: atTime(addDays(now, 1), '10:00'), end: atTime(addDays(now, 1), '11:00'), location: 'Av. Paulista, 1000', meetLink: null };
  return render(rule.script, eventVars(tenant, e));
}

// ------------------------------------------------------------------ tudo junto

/**
 * Calcula todos os avisos que deveriam sair agora para um cliente.
 * changes = mudanças detectadas na última sincronização (pode ser []).
 */
export function computeAlerts({ tenant, rules, events, openTasks = [], todayTasks = [], tomorrowTasks = [], dueTasks = [], changes = [], now }) {
  const s = tenant.settings;
  const on = (k) => systemRule(rules, k).enabled;
  const out = [];
  if (on('lembrete_compromisso')) out.push(...dueEventReminders({ events, tenant, rules, now }));
  if (on('lembrete_tarefa')) out.push(...dueTasks.map((task) => taskReminder({ task, rules, now })));
  if (on('resumo_manha') && dueWindow(now, atTime(now, s.briefingTime))) out.push(buildBriefing({ tenant, rules, events, todayTasks, now }));
  if (on('previa_amanha') && dueWindow(now, atTime(now, s.previewTime))) out.push(buildPreview({ tenant, rules, events, tomorrowTasks, now }));
  out.push(...changeAlerts({ changes, rules }));
  out.push(...scheduleAlerts({ events, tenant, rules, now }));
  out.push(...customRuleAlerts({ tenant, rules, events, openTasks, now }));
  return out;
}
