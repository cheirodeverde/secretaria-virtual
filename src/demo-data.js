// Agenda fictícia para testar o produto sem conectar o Google (DEMO_MODE=true).
import { addDays, atTime, startOfDay } from './time.js';

export function demoEvents(ref = new Date()) {
  const today = startOfDay(ref);
  const tomorrow = addDays(today, 1);
  const ev = (id, day, start, end, title, extra = {}) => ({
    id, title, start: atTime(day, start), end: atTime(day, end), allDay: false,
    location: null, meetLink: null, attendees: 0, busy: true, description: '', htmlLink: null, ...extra,
  });
  return [
    ev('d1', today, '08:30', '09:30', 'Reunião com cliente Padaria Sol', { location: 'Av. Paulista, 1000 - São Paulo', attendees: 2 }),
    ev('d2', today, '09:45', '10:30', 'Visita ao fornecedor de embalagens', { location: 'Rua Vergueiro, 3000 - São Paulo' }),
    ev('d3', today, '10:00', '10:30', 'Call com contador', { meetLink: 'https://meet.google.com/abc-defg-hij' }),
    ev('d4', today, '11:30', '13:00', 'Treinamento da equipe de vendas', { attendees: 5 }),
    ev('d5', today, '13:00', '14:30', 'Almoço de negócios com investidor', { location: 'Restaurante Figueira, Rua Haddock Lobo 100' }),
    ev('d6', today, '17:00', '18:00', 'Revisar fluxo de caixa'),
    ev('d7', tomorrow, '07:30', '08:30', 'Café com fornecedor de farinha', { location: 'Padaria Bella Paulista' }),
    ev('d8', tomorrow, '10:00', '11:00', 'Apresentação de proposta — Rede Mercado Bom', { meetLink: 'https://meet.google.com/xyz-abcd-efg', attendees: 3 }),
    ev('d9', tomorrow, '15:00', '15:30', 'Dentista'),
  ];
}
