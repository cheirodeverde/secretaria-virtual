// Envia os modelos de mensagem para aprovação da Meta.
// Uso: WHATSAPP_TOKEN=... WHATSAPP_WABA_ID=... node scripts/criar-templates.js
import 'dotenv/config';
import fs from 'node:fs';

const { WHATSAPP_TOKEN, WHATSAPP_WABA_ID, WHATSAPP_API_VERSION = 'v23.0' } = process.env;
if (!WHATSAPP_TOKEN || !WHATSAPP_WABA_ID) {
  console.error('Defina WHATSAPP_TOKEN e WHATSAPP_WABA_ID (ID da conta do WhatsApp Business) no .env');
  process.exit(1);
}

const { templates } = JSON.parse(fs.readFileSync(new URL('../templates/whatsapp-templates.json', import.meta.url)));

for (const t of templates) {
  const res = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_WABA_ID}/message_templates`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(t),
  });
  const body = await res.json();
  console.log(res.ok ? `✅ ${t.name}: ${body.status} (id ${body.id})` : `❌ ${t.name}: ${body.error?.message}`);
}
console.log('\nAcompanhe a aprovação no WhatsApp Manager → Modelos de mensagem.');
