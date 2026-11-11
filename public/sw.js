// Service worker mínimo: permite "instalar" o painel na tela inicial do celular.
// Os dados vêm sempre da rede (a agenda precisa estar atualizada).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
