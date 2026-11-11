// Fluxo ponta a ponta com banco em memória e WhatsApp simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleBillingEvent } from '../src/billing.js';
import { handleIncoming } from '../src/conversation.js';
import { getTenant, getTenantByPhone, openDb, updateTenant } from '../src/db.js';
import { dispatch } from '../src/dispatcher.js';
import { connectDemo } from '../src/google.js';
import { processTenant, syncTenant } from '../src/scheduler.js';
import { listTasks } from '../src/tasks.js';
import { addDays, atTime } from '../src/time.js';
import { outbox } from '../src/whatsapp.js';

openDb(':memory:');
const PHONE = '5511988887777';
const D0 = new Date(2026, 10, 11);
const at = (hm, d = D0) => atTime(d, hm);
const lastText = () => { const m = outbox.at(-1); return m.text?.body || m.interactive?.body?.text || m.template?.name; };
const say = async (text, now) => { await handleIncoming({ from: PHONE, text }, now); return lastText(); };

test('conversa completa: cadastro, tarefas, agenda, regras, cobrança', async () => {
  // 1. Primeiro contato cria a conta em teste e sugere o nome do perfil
  await handleIncoming({ from: PHONE, text: 'Oi', profileName: 'ana souza' }, at('09:00'));
  assert.match(lastText(), /Posso te chamar de \*Ana Souza\*/);
  assert.equal(getTenantByPhone(PHONE).status, 'trial');

  // 2. Confirma o nome → recebe link para conectar o Google
  assert.match(await say('sim', at('09:01')), /Prazer, Ana![\s\S]*\/entrar\?t=/);

  // 3. Tarefas por mensagem (antes mesmo de conectar a agenda)
  assert.match(await say('tarefa ligar pro contador amanhã 10h', at('09:02')), /Tarefa 1: \*Ligar pro contador\* — amanhã 10:00[\s\S]*Falta conectar/);
  assert.match(await say('anota comprar embalagens', at('09:03')), /Tarefa 2: \*Comprar embalagens\*/);
  assert.match(await say('tarefas', at('09:04')), /Suas tarefas \(2\)/);
  assert.match(await say('agenda', at('09:05')), /ainda não está conectada/);

  // 4. Conecta a agenda (demo) e pergunta da agenda
  const t = getTenantByPhone(PHONE);
  connectDemo(t.id);
  updateTenant(t.id, { onboarding: 'done' });
  await syncTenant(getTenant(t.id), at('09:06'));
  assert.match(await say('o que tenho hoje?', at('09:07')), /6 compromissos[\s\S]*Conflito/);
  assert.match(await say('livre', at('10:35')), /10:35–11:30/);

  // 5. Concluir, mensagem fora do escopo e oferta de anotar como tarefa
  assert.match(await say('feito 2', at('10:40')), /Concluída: Comprar embalagens\nFaltam 1/);
  assert.match(await say('qual a capital da França?', at('10:41')), /Não entendi/);
  assert.match(await say('comprar presente da Maria', at('10:42')), /Quer que eu anote como tarefa/);
  assert.match(await say('sim', at('10:43')), /Tarefa 2: \*Comprar presente da Maria\*/);

  // 6. Ajuste por frase
  await say('resumo às 6h30', at('10:44'));
  assert.equal(getTenant(t.id).settings.briefingTime, '06:30');

  // 7. Lembrete de tarefa no horário, com botões (janela de 24h aberta) → botão "Feito"
  const d1 = addDays(D0, 1);
  const sent = await processTenant(getTenant(t.id), at('10:00', d1));
  const rem = sent.find((a) => a.kind === 'tarefa');
  assert.ok(rem, 'lembrete de tarefa enviado');
  assert.equal(outbox.find((m) => m.type === 'interactive')?.interactive.action.buttons[0].reply.id, `btn:done:${rem.taskId}`);
  assert.match(await say(`btn:done:${rem.taskId}`, at('10:01', d1)), /Concluída: Ligar pro contador/);
  assert.equal(listTasks(t.id).length, 1);

  // 8. Não perturbe: alerta às 23h vai para a fila e sai às 07:00
  const night = await dispatch(getTenant(t.id), { key: 'x1', kind: 'alerta', text: 'teste noturno', template: { name: 'sec_alerta', params: ['x'] } }, at('23:00', d1));
  assert.equal(night, 'queued');
  const morning = await processTenant(getTenant(t.id), at('07:00', addDays(d1, 1)));
  assert.ok(morning.some((a) => a.key === 'x1'));

  // 9. Fim do teste bloqueia avisos e a conversa oferece assinatura
  updateTenant(t.id, { trialEndsAt: at('00:00').toISOString(), asaasSubscriptionId: 'sub_1' });
  assert.match(await say('agenda', at('12:00', addDays(D0, 20))), /teste grátis de 14 dias terminou[\s\S]*\/entrar/);

  // 10. Webhook de pagamento reativa (e é idempotente)
  assert.deepEqual(await handleBillingEvent({ id: 'evt_1', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1', subscription: 'sub_1' } }), { status: 'active' });
  assert.deepEqual(await handleBillingEvent({ id: 'evt_1', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_1', subscription: 'sub_1' } }), { ignored: 'duplicado' });
  assert.equal(getTenant(t.id).status, 'active');
  assert.match(await say('agenda amanhã', at('12:01', addDays(D0, 20))), /Agenda de/);

  // 11. Inadimplência: carência de 3 dias
  await handleBillingEvent({ id: 'evt_2', event: 'PAYMENT_OVERDUE', payment: { id: 'pay_2', subscription: 'sub_1', invoiceUrl: 'https://pagar' } });
  assert.equal(getTenant(t.id).status, 'past_due');
});

test('números diferentes não veem dados um do outro', async () => {
  await handleIncoming({ from: '5521977776666', text: 'oi' }, at('09:00'));
  await handleIncoming({ from: '5521977776666', text: 'Bruno' }, at('09:01'));
  await handleIncoming({ from: '5521977776666', text: 'tarefas' }, at('09:02'));
  assert.match(lastText(), /Nenhuma tarefa pendente/);
});
