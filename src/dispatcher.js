// Despachante: único ponto de saída de mensagens.
// Garante: sem duplicidade, respeito ao "não perturbe", pausa, situação da conta e registro de tudo.
import { accessState } from './account.js';
import { enqueue, logMessage, markSent, wasSent } from './db.js';
import { inWindow } from './time.js';
import { deliver } from './whatsapp.js';
import { markReminded } from './tasks.js';

export const isQuiet = (tenant, now) => inWindow(now, tenant.settings.quietStart, tenant.settings.quietEnd);

/**
 * Envia um aviso automático. Retorna 'sent' | 'duplicate' | 'paused' | 'blocked' | 'queued' | 'error'.
 * account=true → aviso de conta/assinatura (passa por cima de pausa e bloqueio).
 */
export async function dispatch(tenant, alert, now = new Date(), { force = false } = {}) {
  if (!force && wasSent(tenant.id, alert.key)) return 'duplicate';
  if (!alert.account && !force) {
    if (accessState(tenant, now) === 'blocked') return 'blocked';
    if (tenant.settings.paused) return 'paused';
    if (!alert.bypassQuiet && isQuiet(tenant, now)) { enqueue(tenant.id, alert); return 'queued'; }
  }
  try {
    const r = await deliver(tenant, alert, now);
    markSent(tenant.id, alert.key, now);
    if (alert.taskId) markReminded(tenant.id, alert.taskId, now);
    logMessage({ tenantId: tenant.id, dir: 'out', kind: alert.kind, via: r.via, text: alert.text, dryRun: r.dryRun });
    return 'sent';
  } catch (err) {
    console.error(`[envio] cliente ${tenant.id} (${alert.kind}):`, err.message);
    logMessage({ tenantId: tenant.id, dir: 'out', kind: alert.kind, text: alert.text, error: err.message });
    return 'error';
  }
}

/** Responde a uma mensagem do cliente (a janela de 24h está aberta, então vai como texto/botões). */
export async function reply(tenant, msg, { intent } = {}) {
  const m = typeof msg === 'string' ? { text: msg } : msg;
  try {
    const r = await deliver(tenant, m);
    logMessage({ tenantId: tenant.id, dir: 'out', kind: 'resposta', via: r.via, text: m.text, intent, dryRun: r.dryRun });
  } catch (err) {
    console.error(`[resposta] cliente ${tenant.id}:`, err.message);
    logMessage({ tenantId: tenant.id, dir: 'out', kind: 'resposta', text: m.text, error: err.message });
  }
}
