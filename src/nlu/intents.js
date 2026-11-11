// Reconhecimento de intenções por regras (sem IA). Escopo fechado: agenda, tarefas, configurações e conta.
// Ordem importa: padrões mais específicos primeiro.
import { cleanup, normalize, parseDateTime } from './datetime.js';
import { parseEventText, splitReschedule } from './event.js';

const nums = (s) => (String(s).match(/\d+/g) || []).map(Number);
const onlyNums = (s) => /^[\d\s,e]*$/.test(normalize(s).trim());

/** "o que remarcar" + "para quando" a partir do texto depois do verbo. */
function rescheduleParts(rest, now) {
  const split = splitReschedule(rest, now);
  if (split.target) {
    const src = parseDateTime(split.query, now);
    return { query: src.rest, day: src.hasDay ? src.date : null, target: split.target };
  }
  const w = parseDateTime(rest, now);
  return { query: w.rest, day: null, target: w.found ? rest : null };
}

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
  if (/^(desfazer|desfaz|desfaca|desfaz isso|desfazer isso|voltar atras|volta atras)$/.test(t)) return { intent: 'desfazer' };
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
    const rest = (m[3] || '').trim();
    if (!m[2] && rest && !/^tarefa\b/i.test(rest)) {
      const r = rescheduleParts(rest, now);
      if (r.query) return { intent: 'remarcar_evento', ...r };
    }
    return { intent: 'adiar', num: m[2] ? Number(m[2]) : null, date: when.date, hasTime: when.hasTime };
  }

  // --- agenda: cancelar compromisso ("desmarcar dentista", "cancelar reunião com João de amanhã")
  const nr = normalize(raw);
  m = nr.match(/^\s*(desmarcar|desmarca|desmarque|cancelar|cancela|cancele|apagar|apaga|apague|excluir|exclui|exclua|remover|remove|remova|tirar|tira|tire)\s+/);
  if (m) {
    const rest = raw.slice(m[0].length).trim();
    const taskLike = /^tarefas?\b/i.test(normalize(rest)) || onlyNums(rest);
    const isTirar = /^ti/.test(m[1]);
    if (!taskLike && (!isTirar || /\bda (minha )?agenda\b/.test(normalize(rest))) && !/^(assinatura|plano|avisos?)\b/.test(normalize(rest))) {
      const w = parseDateTime(rest, now);
      return { intent: 'cancelar_evento', query: w.rest, day: w.found ? w.date : null, at: w.hasTime ? w.date : null };
    }
  }
  if (/^(desmarcar|desmarca|desmarque)$/.test(t)) return { intent: 'cancelar_evento', query: '', day: null, at: null };

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

  // --- agenda: mudar horário ("mudar o dentista para 16h", "passa a call com o contador pra amanhã")
  m = nr.match(/^\s*(?:mudar|muda|mude|mover|move|mova|passar|passa|passe|transferir|transfere|transfira|antecipar|antecipa|antecipe|trocar|troca|troque)\s+(?:(?:o|a)\s+)?(?:(?:horario|hora|dia|data)\s+(?:d[aoe]s?\s+)?)?/);
  if (m) {
    const r = rescheduleParts(raw.slice(m[0].length), now);
    if (r.query && r.target) return { intent: 'remarcar_evento', ...r };
  }

  // --- agenda: criar compromisso ("marcar reunião com João amanhã 15h", "agendar dentista sexta 10h")
  m = nr.match(/^\s*(?:marcar|marca|marque|agendar|agende|(?:bota|botar|coloca|colocar|poe|por|adiciona|adicionar|inclui|incluir)\s+(?:na|em)\s+(?:minha\s+)?agenda|cria(?:r)?\s+(?:um\s+)?(?:evento|compromisso)|novo\s+(?:evento|compromisso)|nova(?=\s+reuniao)|novo(?=\s+(?:almoco|cafe|encontro)))(?:\s*[:\-–]\s*|\s+|$)/);
  if (m && !/^\s*(?:marcar|marca|marque)\s+(?:\d|como\b|tarefa)/.test(nr)) return { intent: 'marcar_evento', text: raw.slice(m[0].length).trim() };
  // "agenda reunião com João amanhã 15h" (imperativo) — mas "agenda amanhã" continua sendo consulta
  m = nr.match(/^\s*agenda\s+(?:pra mim\s+|para mim\s+)?/);
  if (m) {
    const ev = parseEventText(raw.slice(m[0].length), now);
    if (ev.hasTime && ev.title && cleanup(ev.title).split(' ').length >= 1 && !/^(de|da|do|pra|para)$/i.test(ev.title)) {
      return { intent: 'marcar_evento', text: raw.slice(m[0].length).trim() };
    }
  }

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
