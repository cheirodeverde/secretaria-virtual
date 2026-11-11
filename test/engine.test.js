import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoEvents } from '../src/demo-data.js';
import { analyzeDay, DEFAULT_SETTINGS, findConflicts } from '../src/rules/analysis.js';
import { buildBriefing, buildPreview, computeAlerts, customRuleAlerts, dueEventReminders, taskReminder } from '../src/rules/engine.js';
import { render, SYSTEM_RULES } from '../src/rules/scripts.js';
import { atTime } from '../src/time.js';
import { cleanParam } from '../src/whatsapp.js';

const DAY = new Date(2026, 10, 11);
const at = (hm, d = DAY) => atTime(d, hm);
const events = demoEvents(DAY);
const tenant = { id: 1, name: 'Ana Souza', hasGoogle: true, settings: { ...DEFAULT_SETTINGS } };
const sys = SYSTEM_RULES.map((r, i) => ({ id: i + 1, systemKey: r.key, name: r.name, trigger: 'system', params: {}, script: r.script, enabled: true }));

test('análise: conflito, deslocamento apertado, almoço em risco', () => {
  const a = analyzeDay(events, DAY, DEFAULT_SETTINGS);
  assert.equal(findConflicts(events).length, 1);
  assert.equal(a.tight.length, 1);
  assert.equal(a.lunchAtRisk, true);
  assert.equal(a.busyMin, 345);
});

test('roteiro: variáveis vazias não deixam buracos', () => {
  assert.equal(render('Oi {nome}!\n\n{vazio}\n\n{x}\nFim', { nome: 'Ana', x: 'ok' }), 'Oi Ana!\n\nok\nFim');
});

test('resumo da manhã usa o roteiro (padrão e editado) e inclui tarefas', () => {
  const todayTasks = [{ id: 9, num: 1, title: 'Pagar fornecedor', dueAt: at('00:00'), hasTime: false }];
  const b = buildBriefing({ tenant, rules: sys, events, todayTasks, now: at('07:30') });
  assert.match(b.text, /Bom dia, Ana!/);
  assert.match(b.text, /Conflito: Visita ao fornecedor/);
  assert.match(b.text, /Tarefas para hoje \(1\):\n1\. Pagar fornecedor — hoje/);
  assert.match(b.text, /Tempo livre para foco/);
  assert.deepEqual(b.template.params.slice(0, 1), ['6']);
  for (const p of b.template.params) assert.ok(!/\n/.test(cleanParam(p)));

  const edited = sys.map((r) => (r.systemKey === 'resumo_manha' ? { ...r, script: 'Bom dia, {nome}. Hoje: {qtd} compromissos. Primeiro: {primeiro}.' } : r));
  assert.equal(buildBriefing({ tenant, rules: edited, events, now: at('07:30') }).text, 'Bom dia, Ana. Hoje: 6 compromissos. Primeiro: Reunião com cliente Padaria Sol às 08:30.');
});

test('prévia de amanhã: começa cedo e itens para preparar', () => {
  const p = buildPreview({ tenant, rules: sys, events, now: at('20:00') });
  assert.match(p.text, /saia até 07:00/);
  assert.match(p.text, /Apresentação de proposta/);
});

test('lembrete presencial com "saia até" e rota; online com link', () => {
  assert.equal(dueEventReminders({ events, tenant, rules: sys, now: at('07:40') }).length, 0);
  const [r] = dueEventReminders({ events, tenant, rules: sys, now: at('07:46') });
  assert.match(r.text, /Saia até 08:00/);
  assert.match(r.text, /google\.com\/maps/);
  const online = dueEventReminders({ events, tenant, rules: sys, now: at('09:31') }).find((x) => x.key.startsWith('rem:d3'));
  assert.match(online.text, /meet\.google\.com/);
});

test('regra desligada não gera aviso', () => {
  const off = sys.map((r) => (r.systemKey === 'alerta_conflito' ? { ...r, enabled: false } : r));
  const keys = computeAlerts({ tenant, rules: off, events, now: at('06:00') }).map((a) => a.key);
  assert.ok(!keys.some((k) => k.startsWith('conf:')));
  assert.ok(keys.some((k) => k.startsWith('tight:')));
});

test('regras personalizadas: depois de evento com filtro, antes de evento e diária', () => {
  const rules = [
    { id: 50, systemKey: null, trigger: 'after_event', params: { offsetMin: 30, titleContains: 'cliente' }, script: 'Como foi {titulo}? Mande TAREFA para registrar o follow-up.', enabled: true },
    { id: 51, systemKey: null, trigger: 'before_event', params: { offsetMin: 60, titleContains: 'investidor' }, script: 'Leve os números do mês para {titulo} às {hora}.', enabled: true },
    { id: 52, systemKey: null, trigger: 'daily', params: { time: '18:00', weekdays: [1, 2, 3, 4, 5] }, script: '{nome}, hora de fechar o caixa. Você tem {tarefas_qtd} tarefas abertas.', enabled: true },
  ];
  const after = customRuleAlerts({ tenant, rules, events, now: at('10:01') });
  assert.equal(after.length, 1);
  assert.equal(after[0].text, 'Como foi Reunião com cliente Padaria Sol? Mande TAREFA para registrar o follow-up.');
  assert.equal(customRuleAlerts({ tenant, rules, events, now: at('12:05') })[0].text, 'Leve os números do mês para Almoço de negócios com investidor às 13:00.');
  const daily = customRuleAlerts({ tenant, rules, events, openTasks: [1, 2], now: at('18:00') });
  assert.equal(daily[0].text, 'Ana, hora de fechar o caixa. Você tem 2 tarefas abertas.');
  assert.equal(daily[0].template.name, 'sec_personalizado');
});

test('lembrete de tarefa tem botões e chave estável', () => {
  const r = taskReminder({ task: { id: 7, num: 2, title: 'Ligar pro contador', dueAt: at('10:00'), hasTime: true }, rules: sys, now: at('10:00') });
  assert.equal(r.buttons.length, 3);
  assert.equal(r.buttons[0].id, 'btn:done:7');
  assert.equal(r.key, `task:7:${at('10:00').toISOString()}`);
  assert.match(r.text, /Lembrete de tarefa 2: \*Ligar pro contador\*/);
});
