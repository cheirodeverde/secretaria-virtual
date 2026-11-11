// Extrai datas e horários de frases em português ("amanhã 10h", "sexta à tarde", "dia 15", "daqui a 2 horas").
// Devolve a data encontrada e o texto SEM as expressões de data (vira o título da tarefa).
import { addDays, addMinutes, startOfDay } from '../time.js';

const WEEKDAYS = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 };
const NUM_WORDS = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, meia: 0.5 };

/** Minúsculas e sem acento, mantendo o mesmo comprimento do original (para recortar o texto original). */
export const normalize = (s) => [...s].map((c) => c.normalize('NFD')[0].toLowerCase()).join('');

function findAll(norm, re) {
  const out = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let m;
  while ((m = g.exec(norm))) { out.push(m); if (m[0] === '') g.lastIndex++; }
  return out;
}

export function parseDateTime(text, now = new Date()) {
  const original = String(text);
  const norm = normalize(original);
  const cuts = [];
  const take = (m) => cuts.push([m.index, m.index + m[0].length]);

  let day = null;      // Date (início do dia)
  let time = null;     // { h, m }
  let exact = null;    // Date exata (relativos em minutos/horas)
  let period = null;   // 'manha' | 'tarde' | 'noite' | 'fim'

  // --- relativos: "daqui a 2 horas", "em 30 minutos", "daqui a 3 dias"
  for (const m of findAll(norm, /\b(?:daqui a|daqui|em|dentro de)\s+(\d+|um|uma|dois|duas|tres|quatro|cinco|seis|meia)\s+(minutos?|min|horas?|h|dias?|semanas?)\b/)) {
    const n = NUM_WORDS[m[1]] ?? Number(m[1]);
    const unit = m[2];
    if (/^min/.test(unit)) exact = addMinutes(now, n);
    else if (/^h/.test(unit)) exact = addMinutes(now, n * 60);
    else if (/^dia/.test(unit)) day = addDays(startOfDay(now), n);
    else day = addDays(startOfDay(now), n * 7);
    take(m);
  }

  // --- dias nomeados
  const named = [
    [/\bdepois de amanha\b/, 2],
    [/\bamanha\b/, 1],
    [/\bhoje\b/, 0],
  ];
  for (const [re, n] of named) {
    const m = norm.match(re);
    if (m && day === null) {
      day = addDays(startOfDay(now), n);
      take({ index: m.index, 0: m[0] });
    }
  }

  // --- dia da semana: "sexta", "na segunda-feira", "quarta que vem", "próximo sábado"
  if (day === null) {
    const m = norm.match(/\b(?:(?:na|no|nesta|neste|nessa|nesse|esta|este|essa|esse|proxima|proximo)\s+)?(segunda|terca|quarta|quinta|sexta|sabado|domingo)(?:\s*-?\s*feira)?(\s+que\s+vem)?\b/);
    if (m) {
      const target = WEEKDAYS[m[1]];
      let diff = (target - now.getDay() + 7) % 7;
      if (diff === 0) diff = 7;
      day = addDays(startOfDay(now), diff);
      take(m);
    }
  }

  // --- "semana que vem" / "próxima semana" → próxima segunda
  if (day === null) {
    const m = norm.match(/\b(?:na\s+)?(?:semana\s+que\s+vem|proxima\s+semana)\b/);
    if (m) { day = addDays(startOfDay(now), ((1 - now.getDay() + 7) % 7) || 7); take(m); }
  }

  // --- datas: "15/11", "15/11/2026", "dia 15", "dia 15/11"
  if (day === null) {
    const m = norm.match(/\b(?:dia\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (m) {
      const d = Number(m[1]); const mo = Number(m[2]) - 1;
      let y = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : now.getFullYear();
      let date = new Date(y, mo, d);
      if (!m[3] && date < startOfDay(now)) date = new Date(y + 1, mo, d);
      if (date.getDate() === d) { day = date; take(m); }
    }
  }
  if (day === null) {
    const m = norm.match(/\bdia\s+(\d{1,2})\b/);
    if (m) {
      const d = Number(m[1]);
      let date = new Date(now.getFullYear(), now.getMonth(), d);
      if (date < startOfDay(now)) date = new Date(now.getFullYear(), now.getMonth() + 1, d);
      if (d >= 1 && d <= 31) { day = date; take(m); }
    }
  }

  // --- horários: "10h", "10h30", "10:30", "às 10", "meio-dia", "15 horas"
  if (!exact) {
    const m = norm.match(/\b(?:as\s+|a\s+|ate\s+as\s+|pelas\s+)?(\d{1,2})\s*(?:h|:|horas?)\s*(\d{2})?(?:\s*(?:min|hs))?\b/)
      || norm.match(/\b(?:as|pelas)\s+(\d{1,2})(?!\s*\/|\d)\b/);
    if (m) {
      let h = Number(m[1]);
      const mi = Number(m[2] || 0);
      const after = norm.slice(m.index + m[0].length);
      const pm = after.match(/^\s*(?:da|de)\s+(tarde|noite)\b/);
      if (pm && h < 12) { h += 12; take({ index: m.index + m[0].length, 0: pm[0] }); }
      if (h <= 23 && mi <= 59) { time = { h, m: mi }; take(m); }
    }
    const md = norm.match(/\b(?:ao\s+|as\s+)?(meio\s*-?\s*dia|meia\s*-?\s*noite)\b/);
    if (!time && md) { time = { h: md[1].startsWith('meio') ? 12 : 0, m: 0 }; take(md); }
  }

  // --- períodos: "de manhã", "à tarde", "à noite", "fim do dia"
  if (!time) {
    const m = norm.match(/(?:\b(?:de|pela|a|na|no|ao)\s+|\b)(manha|tarde|noite|fim do dia|final do dia|fim da tarde)\b/);
    if (m && !exact) {
      period = m[1];
      take(m);
    }
  }
  if (period && !time) {
    time = { manha: { h: 9, m: 0 }, tarde: { h: 14, m: 0 }, noite: { h: 19, m: 0 }, 'fim do dia': { h: 18, m: 0 }, 'final do dia': { h: 18, m: 0 }, 'fim da tarde': { h: 17, m: 0 } }[period];
  }

  // --- compõe a data final
  let date = null;
  let hasTime = false;
  if (exact) { date = exact; hasTime = true; }
  else if (day && time) { date = new Date(day); date.setHours(time.h, time.m, 0, 0); hasTime = true; }
  else if (day) { date = day; }
  else if (time) {
    date = startOfDay(now); date.setHours(time.h, time.m, 0, 0); hasTime = true;
    if (date <= now) date = addDays(date, 1);
  }

  return { date, hasTime, found: Boolean(date), rest: cleanup(cutRanges(original, cuts)) };
}

function cutRanges(s, ranges) {
  const merged = [];
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  let out = s;
  for (const [a, b] of merged.reverse()) out = `${out.slice(0, a)} ${out.slice(b)}`;
  return out;
}

const DANGLING = /^(?:para|pra|pro|no|na|em|de|do|da|ate|às|as|a|o|e|,|-|:)$/i;

function cleanup(s) {
  const words = s.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  while (words.length && DANGLING.test(normalize(words.at(-1)))) words.pop();
  while (words.length && /^(?:,|-|:)$/.test(words[0])) words.shift();
  return words.join(' ').replace(/\s+([,.!?])/g, '$1').trim();
}
