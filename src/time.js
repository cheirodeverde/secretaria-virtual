// Utilitários de data/hora. O fuso é definido em process.env.TZ (ver config.js),
// então métodos locais de Date (getHours, setHours...) já operam no fuso do empresário.

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const DIAS_LONGOS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

const pad = (n) => String(n).padStart(2, '0');

export const fmtTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const fmtDay = (d) => `${DIAS[d.getDay()]}, ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
export const fmtDayLong = (d) => `${DIAS_LONGOS[d.getDay()]}, ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hhmm = (d) => fmtTime(d);

export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export const addMinutes = (d, n) => new Date(d.getTime() + n * 60000);
export const minutesBetween = (a, b) => Math.round((b.getTime() - a.getTime()) / 60000);

/** Retorna o Date do dia `day` no horário "HH:MM". */
export function atTime(day, hm) {
  const [h, m] = String(hm).split(':').map(Number);
  const x = startOfDay(day);
  x.setHours(h || 0, m || 0, 0, 0);
  return x;
}

/** Minutos desde a meia-noite para "HH:MM". */
export const hmToMinutes = (hm) => {
  const [h, m] = String(hm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

export const minutesOfDay = (d) => d.getHours() * 60 + d.getMinutes();

/** Verdadeiro se `d` estiver dentro da janela [start, end) — aceita janelas que viram a meia-noite (ex.: 22:00–07:00). */
export function inWindow(d, startHm, endHm) {
  const m = minutesOfDay(d);
  const s = hmToMinutes(startHm);
  const e = hmToMinutes(endHm);
  if (s === e) return false;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

export function fmtDuration(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h}h${pad(m)}` : `${h}h`;
}
