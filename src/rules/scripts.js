// Regras e roteiros de mensagens.
// - Regras do sistema: os avisos estratégicos. Cada uma tem um roteiro editável e pode ser desligada.
// - Regras personalizadas: criadas pelo cliente (antes/depois de evento, diária), com filtro e roteiro próprios.
import { sql } from '../db.js';

export const SYSTEM_RULES = [
  {
    key: 'resumo_manha',
    name: 'Resumo da manhã',
    description: 'Todo dia no horário do resumo: agenda, pontos de atenção, tarefas e tempo livre.',
    template: 'sec_resumo_dia',
    vars: ['nome', 'data', 'agenda', 'atencao', 'tarefas', 'foco', 'qtd', 'primeiro'],
    script: '☀️ Bom dia, {nome}! Sua agenda de {data}:\n\n{agenda}\n\n{atencao}\n\n{tarefas}\n\n{foco}\n\nResponda AGENDA, TAREFAS ou AJUDA.',
  },
  {
    key: 'previa_amanha',
    name: 'Prévia de amanhã',
    description: 'À noite, no horário da prévia: como começa o dia seguinte e o que preparar.',
    template: 'sec_amanha',
    vars: ['nome', 'data', 'agenda', 'cedo', 'preparar', 'tarefas', 'qtd', 'primeiro'],
    script: '🌙 Prévia de amanhã ({data}):\n\n{agenda}\n\n{cedo}\n\n{preparar}\n\n{tarefas}',
  },
  {
    key: 'lembrete_compromisso',
    name: 'Lembrete de compromisso',
    description: 'Antes de cada compromisso. Presencial: com tempo de deslocamento e rota. Online: com o link.',
    template: 'sec_lembrete',
    vars: ['minutos', 'titulo', 'hora', 'onde', 'proximo', 'preparo', 'local', 'link', 'saia_ate'],
    script: '⏰ Em {minutos} min: *{titulo}* às {hora}\n{onde}\n{proximo}\n{preparo}',
  },
  {
    key: 'alerta_conflito',
    name: 'Conflito de horário',
    description: 'Quando dois compromissos se sobrepõem nas próximas 48h.',
    template: 'sec_alerta',
    vars: ['dia', 'evento_a', 'evento_b'],
    script: '⚠️ Conflito de horário ({dia}):\n• {evento_a}\n• {evento_b}\n\nSugestão: decida a prioridade e remarque o outro com antecedência.',
  },
  {
    key: 'alerta_deslocamento',
    name: 'Deslocamento apertado',
    description: 'Dois compromissos presenciais em locais diferentes sem tempo para ir de um ao outro.',
    template: 'sec_alerta',
    vars: ['dia', 'titulo_a', 'fim_a', 'titulo_b', 'inicio_b', 'intervalo', 'local_b'],
    script: '⚠️ Deslocamento apertado ({dia}): {titulo_a} termina às {fim_a} e {titulo_b} começa às {inicio_b} em outro local (só {intervalo} min).\n📍 {local_b}\n\nSugestão: encurte a primeira ou avise que pode atrasar.',
  },
  {
    key: 'mudanca_agenda',
    name: 'Mudança na agenda',
    description: 'Compromisso novo, remarcado ou cancelado nas próximas 24h.',
    template: 'sec_alerta',
    vars: ['mudanca', 'titulo', 'quando'],
    script: '🔄 {mudanca}',
  },
  {
    key: 'lembrete_tarefa',
    name: 'Lembrete de tarefa',
    description: 'No horário de cada tarefa com hora marcada, com botões Feito / Adiar.',
    template: 'sec_tarefa',
    vars: ['tarefa', 'numero', 'prazo'],
    script: '📌 Lembrete de tarefa {numero}: *{tarefa}*{prazo}',
  },
];

export const CUSTOM_TRIGGERS = {
  before_event: { label: 'Antes de compromissos', vars: ['nome', 'titulo', 'hora', 'data', 'local', 'link'] },
  after_event: { label: 'Depois de compromissos', vars: ['nome', 'titulo', 'hora', 'fim', 'data', 'local'] },
  daily: { label: 'Todo dia em um horário', vars: ['nome', 'data', 'qtd', 'primeiro', 'tarefas_qtd'] },
};

export const SYSTEM_BY_KEY = Object.fromEntries(SYSTEM_RULES.map((r) => [r.key, r]));

/** Substitui {variaveis} e limpa linhas vazias que sobraram de blocos sem conteúdo. */
export function render(script, vars) {
  const out = String(script).replace(/\{([a-z_]+)\}/gi, (_, k) => {
    const v = vars[k.toLowerCase()];
    return v === undefined || v === null ? '' : String(v);
  });
  return out
    .split('\n').map((l) => l.replace(/[ \t]+$/g, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ------------------------------------------------------------------ armazenamento

const parse = (r) => r && ({
  id: r.id,
  systemKey: r.system_key,
  name: r.name,
  trigger: r.trigger,
  params: JSON.parse(r.params || '{}'),
  script: r.script,
  enabled: Boolean(r.enabled),
});

/** Cria as regras do sistema para um cliente novo (idempotente). */
export function ensureSystemRules(tenantId) {
  const ins = sql().prepare("INSERT OR IGNORE INTO rules (tenant_id, system_key, name, trigger, script) VALUES (?, ?, ?, 'system', ?)");
  for (const r of SYSTEM_RULES) ins.run(tenantId, r.key, r.name, r.script);
}

export function listRules(tenantId) {
  ensureSystemRules(tenantId);
  return sql().prepare('SELECT * FROM rules WHERE tenant_id = ? ORDER BY system_key IS NULL, id').all(tenantId).map(parse);
}

export const getRule = (tenantId, id) => parse(sql().prepare('SELECT * FROM rules WHERE tenant_id = ? AND id = ?').get(tenantId, id));

export function systemRule(rules, key) {
  return rules.find((r) => r.systemKey === key) || { ...SYSTEM_BY_KEY[key], systemKey: key, enabled: true };
}

export function validateCustom({ name, trigger, params = {}, script }) {
  if (!CUSTOM_TRIGGERS[trigger]) throw new Error('Gatilho inválido');
  if (!name || !String(name).trim()) throw new Error('Dê um nome para a regra');
  if (!script || !String(script).trim()) throw new Error('Escreva o roteiro da mensagem');
  const p = {};
  if (trigger === 'daily') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(params.time || '')) throw new Error('Horário deve ser HH:MM');
    p.time = params.time;
  } else {
    const off = Number(params.offsetMin);
    if (!Number.isFinite(off) || off < 0 || off > 24 * 60) throw new Error('Minutos devem estar entre 0 e 1440');
    p.offsetMin = off;
    if (params.titleContains) p.titleContains = String(params.titleContains).trim().slice(0, 80);
  }
  if (Array.isArray(params.weekdays) && params.weekdays.length) p.weekdays = params.weekdays.map(Number).filter((d) => d >= 0 && d <= 6);
  return { name: String(name).trim().slice(0, 80), trigger, params: p, script: String(script).slice(0, 1000) };
}

export function createRule(tenantId, data) {
  const v = validateCustom(data);
  const r = sql().prepare('INSERT INTO rules (tenant_id, name, trigger, params, script, enabled) VALUES (?, ?, ?, ?, ?, 1)')
    .run(tenantId, v.name, v.trigger, JSON.stringify(v.params), v.script);
  return getRule(tenantId, Number(r.lastInsertRowid));
}

export function updateRule(tenantId, id, data) {
  const rule = getRule(tenantId, id);
  if (!rule) return null;
  if (rule.systemKey) {
    const script = data.script === undefined ? rule.script : String(data.script).slice(0, 1500) || SYSTEM_BY_KEY[rule.systemKey].script;
    const enabled = data.enabled === undefined ? rule.enabled : Boolean(data.enabled);
    sql().prepare('UPDATE rules SET script = ?, enabled = ? WHERE tenant_id = ? AND id = ?').run(script, enabled ? 1 : 0, tenantId, id);
  } else {
    const v = validateCustom({ ...rule, ...data, params: { ...rule.params, ...(data.params || {}) } });
    const enabled = data.enabled === undefined ? rule.enabled : Boolean(data.enabled);
    sql().prepare('UPDATE rules SET name = ?, trigger = ?, params = ?, script = ?, enabled = ? WHERE tenant_id = ? AND id = ?')
      .run(v.name, v.trigger, JSON.stringify(v.params), v.script, enabled ? 1 : 0, tenantId, id);
  }
  return getRule(tenantId, id);
}

export function resetSystemScript(tenantId, id) {
  const rule = getRule(tenantId, id);
  if (rule?.systemKey) sql().prepare('UPDATE rules SET script = ? WHERE tenant_id = ? AND id = ?').run(SYSTEM_BY_KEY[rule.systemKey].script, tenantId, id);
  return getRule(tenantId, id);
}

export const deleteRule = (tenantId, id) => sql().prepare('DELETE FROM rules WHERE tenant_id = ? AND id = ? AND system_key IS NULL').run(tenantId, id);
export const countCustomRules = (tenantId) => sql().prepare('SELECT COUNT(*) n FROM rules WHERE tenant_id = ? AND system_key IS NULL').get(tenantId).n;
