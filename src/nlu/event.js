// Entende pedidos de compromisso em português:
//   "reunião com João amanhã das 14h às 15h30"      → início, fim
//   "dentista sexta 10h por 40 min"                  → duração
//   "almoço com Pedro dia 20 meio-dia na Rua Augusta 100" → local
//   "call com o contador quinta 9h online"           → cria link do Google Meet
//   "feriado da empresa segunda o dia todo"          → dia inteiro
// Também separa "o que remarcar" de "para quando" ("remarcar dentista de amanhã pra sexta 16h").
import { addDays, addMinutes, startOfDay } from '../time.js';
import { cleanup, normalize, parseDateTime } from './datetime.js';

const NUM = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, meia: 0.5 };

// Onde costuma começar a parte de data/hora numa frase (para o local não "engolir" o horário).
const DATE_START = String.raw`\s+(?:hoje|amanha|depois de amanha|(?:na |no |nesta |neste |proxima |proximo )?(?:segunda|terca|quarta|quinta|sexta|sabado|domingo)|dia\s+\d|\d{1,2}\/\d|\d{1,2}\s*h\b|\d{1,2}\s*h\d{2}|\d{1,2}:\d{2}|as\s+\d|das\s+\d|de\s+\d{1,2}\s*h|ao meio|meio\s*-?\s*dia|de manha|a tarde|a noite|pela manha|daqui|em\s+\d+\s*(?:min|h|dia)|por\s+(?:\d|uma|duas|meia)|online|on-line|com (?:o )?meet|semana que vem|proxima semana|o dia (?:todo|inteiro))`;

/** Recorta o trecho [a, b) de `s` (os índices valem para o texto original e o normalizado, que têm o mesmo tamanho). */
const cutOut = (s, a, b) => `${s.slice(0, a)} ${s.slice(b)}`;

function grab(s, re) {
  const m = normalize(s).match(re);
  if (!m) return { s, m: null };
  return { s: cutOut(s, m.index, m.index + m[0].length), m, raw: s.slice(m.index, m.index + m[0].length) };
}

const hm = (h, mi) => ({ h: Number(h), m: Number(mi || 0) });
const validHm = (t) => t.h >= 0 && t.h <= 23 && t.m >= 0 && t.m <= 59;

/**
 * Lê um pedido de compromisso. Não decide se a data é válida (passado etc.): isso é da conversa.
 * @returns {{ title, start, end, allDay, hasTime, hasDay, location, online, durationMin }}
 */
export function parseEventText(text, now = new Date(), { defaultMin = 60 } = {}) {
  let s = ` ${String(text ?? '').replace(/📍/gu, ' local: ')} `;
  let location = null;
  let online = false;
  let allDay = false;
  let durationMin = null;
  let endHm = null;
  let r;

  // --- local explícito: "local: Padaria Sol", "endereço Rua X, 10"
  r = grab(s, new RegExp(String.raw`\s(?:local|endereco|onde)\s*[:=-]?\s+(.+?)(?=${DATE_START}|\s*$)`));
  if (r.m) { location = r.raw.replace(/^\s*\S+\s*[:=-]?\s*/, ''); s = r.s; }
  // --- local por logradouro: "na Rua Augusta 100", "no Shopping Ibirapuera"
  if (!location) {
    r = grab(s, new RegExp(String.raw`\s(?:na|no|em)\s+((?:rua|r\.|av\.?|avenida|alameda|al\.|praca|rodovia|estrada|travessa|largo|shopping|edificio|condominio)\s.+?)(?=${DATE_START}|\s*$)`));
    if (r.m) { location = r.raw.replace(/^\s*\S+\s+/, ''); s = r.s; }
  }
  if (location) location = location.replace(/[\s,.;-]+$/, '').trim() || null;

  // --- dia inteiro
  r = grab(s, /\s(?:o\s+)?dia\s+(?:todo|inteiro)\b/);
  if (r.m) { allDay = true; s = r.s; }

  // --- online / Meet
  r = grab(s, /\s(?:online|on-line|por video|por videochamada|videochamada|(?:com|no|pelo)\s+(?:o\s+)?(?:google\s+)?meet)\b/);
  if (r.m) { online = true; s = r.s; }

  // --- intervalo: "das 14h às 15h30", "de 9 às 10h", "14h-15h"
  r = grab(s, /\s(?:de|das)\s+(\d{1,2})(?:\s*(?:h|:)\s*(\d{2})?)?\s*(?:as|a|ate)\s+(\d{1,2})(?:\s*(?:h|:|horas?)\s*(\d{2})?)?\b/);
  if (!r.m) r = grab(s, /\s(\d{1,2})\s*(?:h|:)\s*(\d{2})?\s*(?:-|–|as|ate)\s*(\d{1,2})(?:\s*(?:h|:|horas?)\s*(\d{2})?)?\b/);
  if (r.m) {
    const a = hm(r.m[1], r.m[2]);
    const b = hm(r.m[3], r.m[4]);
    if (validHm(a) && validHm(b)) {
      s = `${r.s} ${a.h}h${String(a.m).padStart(2, '0')} `;
      endHm = b;
    }
  }

  // --- duração: "por 2 horas", "por 1h30", "por 40 min", "por meia hora", "durante uma hora"
  r = grab(s, /\s(?:por|durante|com duracao de)\s+(\d{1,2})\s*h\s*(\d{2})\b/);
  if (r.m) { durationMin = Number(r.m[1]) * 60 + Number(r.m[2]); s = r.s; }
  if (durationMin === null) {
    r = grab(s, /\s(?:por|durante|com duracao de)\s+(\d+(?:[.,]\d+)?|uma?|duas|tres|meia)\s*(h|horas?|min|minutos?)\b(?:\s+e\s+(?:meia|(\d+)\s*(?:min|minutos?)))?/);
    if (r.m) {
      const n = NUM[r.m[1]] ?? Number(r.m[1].replace(',', '.'));
      const extra = /e\s+meia/.test(r.m[0]) ? 30 : Number(r.m[3] || 0);
      durationMin = Math.round(/^h/.test(r.m[2]) ? n * 60 + extra : n + extra);
      s = r.s;
    }
  }

  const when = parseDateTime(s, now);
  let start = when.date;
  let end = null;
  if (start && (allDay || !when.hasTime)) {
    start = startOfDay(start);
    if (allDay) end = addDays(start, 1);
  } else if (start) {
    if (endHm) {
      end = new Date(start); end.setHours(endHm.h, endHm.m, 0, 0);
      if (end <= start) end = null; // "das 15h às 14h": ignora o fim
    }
    if (!end) end = addMinutes(start, durationMin ?? defaultMin);
  }

  let title = cleanup(when.rest)
    .replace(/^(?:um|uma|o|a|os|as|meu|minha|pra mim|para mim)\s+/i, '')
    .replace(/^[,:;\-–\s]+|[,:;\-–\s]+$/g, '')
    .trim();
  if (title) title = title.charAt(0).toUpperCase() + title.slice(1);

  return {
    title,
    start,
    end,
    allDay: Boolean(start) && allDay,
    hasTime: Boolean(start) && when.hasTime && !allDay,
    hasDay: when.hasDay,
    wantsAllDay: allDay,
    location,
    online,
    durationMin,
  };
}

/**
 * "reunião com João de amanhã para sexta 10h" → { query: 'reunião com João de amanhã', target: 'sexta 10h' }.
 * Usa o ÚLTIMO "para/pra/pro" que tiver uma data depois dele.
 */
export function splitReschedule(text, now = new Date()) {
  const raw = String(text ?? '');
  const norm = normalize(raw);
  const re = /\s(?:para|pra|pro|p\/)\s+/g;
  let m;
  let best = null;
  while ((m = re.exec(norm))) {
    const target = raw.slice(m.index + m[0].length);
    if (parseDateTime(target, now).found) best = { query: raw.slice(0, m.index), target };
  }
  return best || { query: raw, target: null };
}
