// Cloudflare Worker: ponte segura entre a Secretária e a sua Evolution API.
//
// A chave da Evolution (AUTHENTICATION_API_KEY) fica SÓ aqui, como segredo do Worker.
// A Secretária fala com este Worker usando outro token (PROXY_TOKEN) e só consegue:
//   • ver o status, pedir o QR Code, desconectar e (re)configurar o webhook da instância INSTANCE;
//   • criar essa instância (se ainda não existir);
//   • enviar texto por ela.
// Qualquer outra rota, ou outra instância, é recusada (403).
//
// Configuração do Worker (Cloudflare → Workers → seu worker → Settings → Variables and Secrets):
//   EVOLUTION_URL      texto   ex.: https://evoapi.agentenpe.com.br
//   INSTANCE           texto   ex.: secretaria
//   EVOLUTION_API_KEY  SEGREDO a AUTHENTICATION_API_KEY da sua Evolution
//   PROXY_TOKEN        SEGREDO um texto longo e aleatório (o mesmo vai em EVOLUTION_API_KEY da Secretária)

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function sameSecret(a, b) {
  const x = new TextEncoder().encode(String(a || ''));
  const y = new TextEncoder().encode(String(b || ''));
  if (!x.length || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** Rotas liberadas (método + caminho) para a instância configurada. */
function allowed(method, url, inst) {
  const p = url.pathname;
  const i = encodeURIComponent(inst);
  if (method === 'GET' && p === `/instance/connectionState/${i}`) return true;
  if (method === 'GET' && p === `/instance/connect/${i}`) return true;
  if (method === 'GET' && p === '/instance/fetchInstances') return url.searchParams.get('instanceName') === inst;
  if (method === 'DELETE' && p === `/instance/logout/${i}`) return true;
  if (method === 'POST' && p === `/webhook/set/${i}`) return true;
  if (method === 'POST' && p === `/message/sendText/${i}`) return true;
  if (method === 'POST' && p === '/instance/create') return 'create';
  return false;
}

export default {
  async fetch(request, env) {
    const missing = ['EVOLUTION_URL', 'INSTANCE', 'EVOLUTION_API_KEY', 'PROXY_TOKEN'].filter((k) => !env[k]);
    if (missing.length) return json(500, { message: `Worker sem configuração: ${missing.join(', ')}` });

    const url = new URL(request.url);
    if (url.pathname === '/' && request.method === 'GET') return json(200, { ok: true, service: 'evolution-proxy', instance: env.INSTANCE });

    if (!sameSecret(request.headers.get('apikey'), env.PROXY_TOKEN)) return json(401, { message: 'Token inválido' });

    const rule = allowed(request.method, url, env.INSTANCE);
    if (!rule) return json(403, { message: `Rota não permitida por este proxy: ${request.method} ${url.pathname}` });

    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text();
    if (body && body.length > 64 * 1024) return json(413, { message: 'Corpo grande demais' });
    if (rule === 'create') {
      let data;
      try { data = JSON.parse(body || '{}'); } catch { return json(400, { message: 'JSON inválido' }); }
      if (data.instanceName !== env.INSTANCE) return json(403, { message: `Só é permitido criar a instância ${env.INSTANCE}` });
    }

    const target = `${String(env.EVOLUTION_URL).replace(/\/$/, '')}${url.pathname}${url.search}`;
    let res;
    try {
      res = await fetch(target, {
        method: request.method,
        headers: { apikey: env.EVOLUTION_API_KEY, 'Content-Type': 'application/json' },
        body,
      });
    } catch (err) {
      return json(502, { message: `Evolution API inacessível: ${err.message}` });
    }
    return new Response(res.body, { status: res.status, headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json' } });
  },
};
