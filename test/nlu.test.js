import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDateTime } from '../src/nlu/datetime.js';
import { parseIntent } from '../src/nlu/intents.js';

const NOW = new Date(2026, 10, 11, 17, 41); // qua, 11/11/2026 17:41
const fmt = (d) => d && `${d.getDate()}/${d.getMonth() + 1} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

test('datas e horários em português', () => {
  const cases = [
    ['ligar pro contador amanhã 10h', '12/11 10:00', true, 'ligar pro contador'],
    ['pagar boleto sexta', '13/11 00:00', false, 'pagar boleto'],
    ['reunião dia 15 às 14h30', '15/11 14:30', true, 'reunião'],
    ['enviar proposta 20/11 de manhã', '20/11 09:00', true, 'enviar proposta'],
    ['retornar cliente daqui a 2 horas', '11/11 19:41', true, 'retornar cliente'],
    ['ver estoque amanhã de manhã', '12/11 09:00', true, 'ver estoque'],
    ['pagar aluguel dia 5', '5/12 00:00', false, 'pagar aluguel'],
    ['revisar contrato à tarde', '12/11 14:00', true, 'revisar contrato'], // 14h de hoje já passou
    ['almoço com fornecedor quinta-feira meio-dia', '12/11 12:00', true, 'almoço com fornecedor'],
    ['ligar 9h da noite', '11/11 21:00', true, 'ligar'],
    ['preparar apresentação segunda que vem 8h', '16/11 08:00', true, 'preparar apresentação'],
    ['emitir nota em 30 minutos', '11/11 18:11', true, 'emitir nota'],
  ];
  for (const [text, when, hasTime, rest] of cases) {
    const r = parseDateTime(text, NOW);
    assert.equal(fmt(r.date), when, text);
    assert.equal(r.hasTime, hasTime, text);
    assert.equal(r.rest, rest, text);
  }
  assert.equal(parseDateTime('comprar embalagens', NOW).date, null);
});

test('intenções', () => {
  const cases = [
    ['Oi!', 'saudacao'], ['agenda', 'agenda'], ['o que tenho amanhã?', 'agenda'], ['tarefas', 'listar_tarefas'],
    ['Tarefa: ligar pro contador amanhã 10h', 'criar_tarefa'], ['me lembra de pagar o boleto dia 15', 'criar_tarefa'],
    ['anota comprar embalagens', 'criar_tarefa'], ['feito 2', 'concluir'], ['concluí 1 e 3', 'concluir'],
    ['adiar 1 para segunda 9h', 'adiar'], ['apagar 3', 'apagar'], ['resumo às 7h', 'config'], ['prévia às 21h', 'config'],
    ['lembrete 15 min antes', 'config'], ['não perturbe das 22h às 7h', 'config'], ['tenho horário livre amanhã?', 'livre'],
    ['qual meu próximo compromisso', 'proximo'], ['semana', 'semana'], ['pausar', 'pausar'], ['retomar', 'retomar'],
    ['painel', 'painel'], ['assinatura', 'assinatura'], ['sim', 'confirmar'], ['valeu!', 'agradecimento'],
    ['qual a capital da França?', 'nao_entendido'], ['btn:done:12', 'botao_done'],
  ];
  for (const [text, intent] of cases) assert.equal(parseIntent(text, NOW).intent, intent, text);

  assert.deepEqual(parseIntent('concluí 1 e 3', NOW).nums, [1, 3]);
  const c = parseIntent('preciso enviar orçamento pro João sexta à tarde', NOW);
  assert.equal(c.title, 'enviar orçamento pro João');
  assert.equal(fmt(c.date), '13/11 14:00');
  assert.deepEqual(parseIntent('não perturbe das 22h às 7h', NOW).value, ['22:00', '07:00']);
  assert.equal(parseIntent('resumo às 6h30', NOW).value, '06:30');
});
