// Reconhecimento de intenções por regras (sem IA). Escopo fechado: agenda, tarefas, configurações e conta.
// Ordem importa: padrões mais específicos primeiro.
import { normalize, parseDateTime } from './datetime.js';

const nums = (s) => (String(s).match(/\d+/g) || []).map(Number);

export function parseIntent(text, now = new Date()) {
  const raw = String(text ?? '').trim();
  const t = normalize(raw).replace(/[!?.]+$/g, '').replace(/\s+/g, ' ').trim();

  // Botões interativos chegam como "btn:<acao>:<id da tarefa>"
  const btn = raw.match(/^btn:(done|snooze1h|tomorrow):(\d+)$/);
  if (btn) return { intent: `botao_${btn[1]}`, taskId: Number(btn[2]) };

  if (!t) return { intent: 'ajuda' };
  if (/^(sim|s|isso|pode|pode sim|claro|confirmo|confirma|ok pode|beleza|isso mesmo)$/.test(t)) return { intent: 'confirmar' };
  if (/^(nao|n|nao precisa|deixa|deixa pra la|esquece|cancela)$/.test(t)) return { intent: 'negar' };
  if (/^(ajuda|menu|comandos|help|opcoes|\?|o que voce faz|como funciona)/.test(t)) return { intent: 'ajuda' };

  if (/^(pausar|pausa|parar avisos|pare|silenciar|silencio)( avisos)?$/.test(t)) return { intent: 'pausar' };
  if (/^(retomar|voltar|reativar|ativar)( os)?( avisos)?$/.test(t)) return { intent: 'retomar' };
  if (/^(painel|acessar painel|abrir painel|link do painel|configuracoes|ajustes|entrar)$/.test(t)) return { intent: 'painel' };
  if (/^(assinatura|assinar|meu plano|plano|planos|pagar|pagamento|mensalidade|boleto da assinatura|cancelar assinatura)$/.test(t)) return { intent: 'assinatura' };
  if (/^(conectar|conectar agenda|conectar google|google|agenda google)$/.test(t)) return { intent: 'conectar_google' };

  // --- tarefas: concluir / adiar / apagar
  let m = t.match(/^(feito|feita|feitos|conclui|concluido|concluida|concluir|terminei|finalizei|fiz)\b(.*)$/);
  if (m) return { intent: 'concluir', nums: nums(m[2]) };

  m = raw.match(/^\s*(adiar|adia|adie|remarcar|remarca|empurrar|empurra|postergar|posterga)\b\s*(?:a\s+|tarefa\s+)?(\d+)?\s*(.*)$/i);
  if (m) {
    const when = parseDateTime(m[3] || '', now);
    return { intent: 'adiar', num: m[2] ? Number(m[2]) : null, date: when.date, hasTime: when.hasTime };
  }

  m = t.match(/^(apagar|apaga|apague|excluir|exclui|remover|remove|deletar|deleta|cancelar tarefa|cancela tarefa)\b(.*)$/);
  if (m) return { intent: 'apagar', nums: nums(m[2]) };

  if (/^(tarefas|tarefa|pendencias|pendentes|minhas tarefas|lista|listar tarefas|ver tarefas|to.?do|afazeres)$/.test(t)
    || /\bo que (eu )?(tenho|falta|preciso) (pra|para) fazer\b/.test(t)) return { intent: 'listar_tarefas' };

  // --- configurações por frase
  m = t.match(/\b(resumo|briefing)( da manha)?\s*(as|para|pras|pra)?\s*(\d{1,2})(?:\s*(?:h|:)\s*(\d{2})?)?/);
  if (m && !/previa|noite/.test(t)) return { intent: 'config', key: 'briefingTime', value: hm(m[4], m[5]) };
  m = t.match(/\b(previa|resumo da noite|aviso da noite)\s*(de amanha)?\s*(as|para|pra)?\s*(\d{1,2})(?:\s*(?:h|:)\s*(\d{2})?)?/);
  if (m) return { intent: 'config', key: 'previewTime', value: hm(m[4], m[5]) };
  m = t.match(/\blembretes?\s*(com|de)?\s*(\d{1,3})\s*min/);
  if (m) return { intent: 'config', key: 'reminderLeadMin', value: Number(m[2]) };
  m = t.match(/\bnao perturbe\s*(das|de)?\s*(\d{1,2})\s*h?\s*(as|a|ate)\s*(\d{1,2})\s*h?/);
  if (m) return { intent: 'config', key: 'quiet', value: [hm(m[2]), hm(m[4])] };

  // --- tarefas: criar
  m = raw.match(/^\s*(?:tarefa|nova tarefa|anota(?:r|e)?(?:\s+a[ií])?|lembrete|me\s+lembr(?:a|e|ar)(?:\s+de)?|lembr(?:a|ar|e)(?:\s+de)?|n[aã]o\s+(?:me\s+)?deix(?:a|e)\s+esquecer(?:\s+de)?|preciso|tenho\s+que)\s*[:\-–]?\s+(.+)$/i);
  if (m && !/\b(minha agenda|meus compromissos)\b/.test(t)) {
    const when = parseDateTime(m[1], now);
    return { intent: 'criar_tarefa', title: when.rest || m[1].trim(), date: when.date, hasTime: when.hasTime };
  }

  // --- agenda
  if (/\b(proximo|proxima)\s+(compromisso|evento|reuniao|agenda)|\bqual (e )?(o )?meu proximo\b/.test(t)) return { intent: 'proximo' };
  if (/\b(livre|livres|vago|vagos|disponivel|disponiveis|encaixe|encaixar|folga)\b|tenho tempo/.test(t)) {
    const d = parseDateTime(raw, now);
    return { intent: 'livre', date: d.date };
  }
  if (/\bsemana\b/.test(t) && !/\bque vem\b|\bproxima semana\b/.test(t)) return { intent: 'semana' };
  if (/\b(agenda|compromissos?|reunio(es)?|reuniao|eventos?|meu dia|o que (eu )?tenho|tenho algo|tenho alguma coisa|como (esta|e|ta) (o )?(meu )?dia)\b/.test(t)
    || /^(hoje|amanha|depois de amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo)(-feira)?$/.test(t)) {
    const d = parseDateTime(raw, now);
    return { intent: 'agenda', date: d.date };
  }

  if (/^(oi|ola|oie|bom dia|boa tarde|boa noite|e ai|opa|hey|alo|salve|tudo bem)\b/.test(t) && t.split(' ').length <= 5) return { intent: 'saudacao' };
  if (/^(obrigad[oa]|valeu|vlw|brigad[oa]|show|top|perfeito|otimo|massa)\b/.test(t)) return { intent: 'agradecimento' };

  return { intent: 'nao_entendido', text: raw };
}

function hm(h, m) {
  const hh = Math.min(23, Number(h));
  const mm = Math.min(59, Number(m || 0));
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
