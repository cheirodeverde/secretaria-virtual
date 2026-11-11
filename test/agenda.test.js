// Criar, remarcar e cancelar compromissos pelo WhatsApp (agenda demo, banco em memória, WhatsApp simulado).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleIncoming } from '../src/conversation.js';
import { getEvents, getTenant, getTenantByPhone, listCalendarLog, openDb, setEvents, updateTenant } from '../src/db.js';
import { connectDemo } from '../src/google.js';
import { processTenant, syncTenant } from '../src/scheduler.js';
import { addDays, atTime } from '../src/time.js';
import { outbox } from '../src/whatsapp.js';

openDb(':memory:');
const D0 = new Date(2026, 10, 11); // qua, 11/11/2026
const at = (hm, d = D0) => atTime(d, hm);
const lastMsg = () => outbox.at(-1);
const lastText = () => { const m = lastMsg(); return m.text?.body || m.interactive?.body?.text || m.template?.name; };

async function newClient(phone, name) {
  await handleIncoming({ from: phone, text: 'oi' }, at('07:50'));
  await handleIncoming({ from: phone, text: name }, at('07:51'));
  const t = getTenantByPhone(phone);
  connectDemo(t.id);
  updateTenant(t.id, { onboarding: 'done' });
  await syncTenant(getTenant(t.id), at('07:52'));
  return t.id;
}

test('marcar, remarcar, desfazer e desmarcar pelo WhatsApp', async () => {
  const PHONE = '5511911112222';
  const id = await newClient(PHONE, 'Carla');
  const say = async (text, now) => { await handleIncoming({ from: PHONE, text }, now); return lastText(); };

  // 1. Pedido de marcação → confirmação com botões e aviso de conflito (o dentista de amanhã é 15:00–15:30)
  const ask = await say('marcar reunião com João amanhã 15h', at('09:00'));
  assert.match(ask, /Vou marcar[\s\S]*\*Reunião com João\*[\s\S]*amanhã, 15:00–16:00[\s\S]*Choca com: Dentista/);
  assert.deepEqual(lastMsg().interactive.action.buttons.map((b) => b.reply.id), ['sim', 'nao']);
  assert.equal(getEvents(id).some((e) => e.title === 'Reunião com João'), false, 'nada muda antes de confirmar');

  // 2. Confirma (o botão chega como "sim")
  assert.match(await say('sim', at('09:01')), /Marcado![\s\S]*DESFAZER/);
  const created = getEvents(id).find((e) => e.title === 'Reunião com João');
  assert.ok(created);
  assert.equal(created.start.getTime(), at('15:00', addDays(D0, 1)).getTime());
  assert.equal(listCalendarLog(id)[0].action, 'create');

  // 3. A próxima sincronização NÃO avisa "novo compromisso" (foi a própria Secretária que criou)
  const sent = await processTenant(getTenant(id), at('09:10'), { forceSync: true });
  assert.equal(sent.filter((a) => a.key.startsWith('chg:')).length, 0);
  assert.ok(getEvents(id).some((e) => e.id === created.id), 'evento continua na agenda depois da sincronização');

  // 4. Remarcar para outro dia mantendo a duração
  assert.match(await say('remarcar reunião com João pra sexta 10h', at('09:15')), /De: amanhã, 15:00–16:00\nPara: sex, 13\/11, 10:00–11:00/);
  assert.match(await say('sim', at('09:16')), /Remarcado: \*Reunião com João\* agora é sex, 13\/11, 10:00–11:00/);

  // 5. Desfazer devolve ao horário anterior
  assert.match(await say('desfazer', at('09:17')), /Desfeito[\s\S]*amanhã, 15:00–16:00/);
  assert.equal(getEvents(id).find((e) => e.id === created.id).start.getTime(), at('15:00', addDays(D0, 1)).getTime());

  // 6. Só o horário: mesmo dia
  await say('mudar a reunião com João para 17h', at('09:20'));
  assert.match(lastText(), /Para: amanhã, 17:00–18:00/);
  await say('sim', at('09:21'));

  // 7. Desmarcar com nome ambíguo → lista para escolher pelo número
  const pick = await say('desmarcar reunião', at('09:25'));
  assert.match(pick, /Qual deles\?\n1\. Reunião com cliente Padaria Sol[\s\S]*2\. Reunião com João/);
  assert.match(await say('2', at('09:26')), /Cancelar este compromisso\?[\s\S]*Reunião com João/);
  assert.match(await say('sim', at('09:27')), /Cancelado: \*Reunião com João\*/);
  assert.equal(getEvents(id).some((e) => e.id === created.id), false);
  const sent2 = await processTenant(getTenant(id), at('09:30'), { forceSync: true });
  assert.equal(sent2.filter((a) => a.key.startsWith('chg:')).length, 0, 'cancelamento feito aqui não vira alerta');

  // 8. Desfazer o cancelamento recria o compromisso
  assert.match(await say('desfazer', at('09:31')), /voltou para a agenda/);
  assert.ok(getEvents(id).some((e) => e.title === 'Reunião com João'));
  assert.match(await say('desfazer', at('09:32')), /Não tenho nenhuma alteração recente/);
});

test('pergunta o que falta, recusa o passado e expira confirmações antigas', async () => {
  const PHONE = '5511933334444';
  const id = await newClient(PHONE, 'Davi');
  const say = async (text, now) => { await handleIncoming({ from: PHONE, text }, now); return lastText(); };

  // Faltou o horário → pergunta → resposta com duração
  assert.match(await say('agendar dentista sexta', at('09:00')), /Que horas \(sex, 13\/11\) para \*Dentista\*/);
  assert.match(await say('10h por 40 min', at('09:01')), /\*Dentista\*\n🗓 sex, 13\/11, 10:00–10:40/);
  assert.match(await say('não', at('09:02')), /não mexi na agenda/);

  // Online cria link do Meet, local por logradouro
  assert.match(await say('marcar call com contador amanhã 9h online', at('09:03')), /💻 com link do Google Meet/);
  assert.match(await say('sim', at('09:04')), /💻 https:\/\/meet\.google\.com\//);
  assert.match(await say('agendar visita ao cliente sexta 14h na Rua Augusta 100', at('09:05')), /📍 Rua Augusta 100/);

  // Confirmação de 20 min atrás não vale mais
  assert.equal(await say('sim', at('09:25')), '👍');
  assert.equal(getEvents(id).some((e) => e.title === 'Visita ao cliente'), false);

  // Outro assunto no meio descarta a confirmação
  await say('agendar almoço com Pedro amanhã meio-dia', at('09:30'));
  await say('tarefas', at('09:31'));
  assert.equal(await say('sim', at('09:32')), '👍');

  // Horário no passado
  assert.match(await say('marcar reunião hoje 8h', at('09:40')), /já passou/);
  // Não acha o compromisso
  assert.match(await say('desmarcar aniversário da tia', at('09:41')), /Não achei "aniversário da tia"/);
});

test('sem permissão de edição pede autorização; convites de outros não podem ser mudados', async () => {
  const PHONE = '5511955556666';
  const id = await newClient(PHONE, 'Eva');
  const say = async (text, now) => { await handleIncoming({ from: PHONE, text }, now); return lastText(); };

  // Convite de outra pessoa
  const ev = { id: 'conv1', title: 'Board com investidores', start: at('16:00'), end: at('17:00'), allDay: false, busy: true, attendees: 4, mine: false, organizer: 'Marcos' };
  setEvents(id, [...getEvents(id), ev]);
  assert.match(await say('desmarcar board com investidores', at('09:00')), /convite de Marcos/);

  // Quem conectou só com leitura (v0.2) precisa autorizar de novo
  updateTenant(id, { googleTokens: { access_token: 'x', refresh_token: 'y', scope: 'https://www.googleapis.com/auth/calendar.readonly openid email' } });
  assert.match(await say('marcar reunião amanhã 10h', at('09:05')), /preciso da sua permissão para editar[\s\S]*\/entrar\?t=/);
  assert.match(await say('conectar', at('09:06')), /só para leitura[\s\S]*autorize/);
});
