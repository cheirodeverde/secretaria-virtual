// Mostra no terminal uma conversa completa com a Secretária (banco em memória, WhatsApp simulado, agenda demo).
// Uso: npm run demo:conversa
process.env.NODE_ENV = 'test';
process.env.DB_FILE = ':memory:';
process.env.WHATSAPP_TOKEN = '';
const { handleIncoming } = await import('../src/conversation.js');
const { getTenantByPhone, getTenant, openDb, updateTenant } = await import('../src/db.js');
const { connectDemo } = await import('../src/google.js');
const { processTenant, syncTenant } = await import('../src/scheduler.js');
const { outbox } = await import('../src/whatsapp.js');
const { atTime, addDays } = await import('../src/time.js');

openDb(':memory:');
const PHONE = '5511988887777';
const today = new Date();
const at = (hm, d = today) => atTime(d, hm);
const show = (from) => {
  for (const m of outbox.splice(0)) {
    const body = m.text?.body || (m.interactive ? `${m.interactive.body.text}\n   [${m.interactive.action.buttons.map((b) => b.reply.title).join('] [')}]` : `(modelo ${m.template.name})`);
    console.log(`\n🤖 Secretária${from ? ` (${from})` : ''}:\n${body.replace(/^/gm, '   ')}`);
  }
};
const user = async (text, now, extra = {}) => {
  console.log(`\n\n👤 Cliente (${now.toTimeString().slice(0, 5)}): ${text}`);
  await handleIncoming({ from: PHONE, text, ...extra }, now);
  show();
};

await user('Oi, vi o anúncio', at('08:00'), { profileName: 'Ana Souza' });
await user('sim', at('08:01'));
await user('me lembra de ligar pro contador hoje às 15h', at('08:02'));
console.log('\n\n— (cliente toca no link e conecta a Google Agenda) —');
const t = getTenantByPhone(PHONE);
connectDemo(t.id); updateTenant(t.id, { onboarding: 'done' });
await syncTenant(getTenant(t.id), at('08:03'));
await user('o que tenho hoje?', at('08:04'));
await user('tenho horário livre?', at('10:35'));
await user('preciso enviar orçamento pro Mercado Bom sexta à tarde', at('10:36'));
await user('tarefas', at('10:37'));
console.log('\n\n— (15:00: o agendador dispara o lembrete da tarefa) —');
await processTenant(getTenant(t.id), at('15:00'), { forceSync: true });
show('automático');
await user('btn:snooze1h:1', at('15:01'));
await user('resumo às 7h', at('15:02'));
console.log('\n\n— (20:00: prévia de amanhã) —');
await processTenant(getTenant(t.id), at('20:00'));
show('automático');
await user('qual a capital da França?', at('20:05'));
