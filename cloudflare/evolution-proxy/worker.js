// Cloudflare Worker: ponte segura entre a Secretária e a sua Evolution API.
//
// A chave da Evolution (AUTHENTICATION_API_KEY) fica SÓ aqui, como segredo do Worker.
// A Secretária fala com este Worker usando outro token (PROXY_TOKEN) e só consegue:
//   • ver o status, pedir o QR Code, desconectar e (re)configurar o webhook das instâncias liberadas em INSTANCE;
//   • criar essas instâncias (se ainda não existirem);
//   • enviar texto por elas.
// Qualquer outra rota, ou outra instância, é recusada (403).
//
// INSTANCE aceita vários nomes separados por vírgula e "*" no fim como curinga:
//   "secretaria"                → só essa
//   "secretaria,secretaria-2"   → essas duas
//   "secretaria*"               → todas que começam com "secretaria" (secretaria, secretaria-padaria…)
//
// Configuração do Worker (Cloudflare → Workers → seu worker → Settings → Variables and Secrets):
//   EVOLUTION_URL      texto   ex.: https://evoapi.agentenpe.com.br
//   INSTANCE           texto   ex.: secretaria*
//   EVOLUTION_API_KEY  SEGREDO a AUTHENTICATION_API_KEY da sua Evolution
//   PROXY_TOKEN        SEGREDO um texto longo e aleatório (o mesmo vai no campo "Chave" do número, no /admin da Secretária)

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function sameSecret(a, b) {
  const x = new TextEncoder().encode(String(a || ''));
  const y = new TextEncoder().encode(String(b || ''));
  if (!x.length || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** A instância está liberada pela lista INSTANCE? */
export function instanceAllowed(name, patterns) {
  if (!name) return false;
  return String(patterns).split(',').map((s) => s.trim()).filter(Boolean)
    .some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
}

const ROUTES = [
  ['GET', /^\/instance\/connectionState\/([^/]+)$/],
  ['GET', /^\/instance\/connect\/([^/]+)$/],
  ['DELETE', /^\/instance\/logout\/([^/]+)$/],
  ['POST', /^\/webhook\/set\/([^/]+)$/],
  ['POST', /^\/message\/sendText\/([^/]+)$/],
];

/** Rotas liberadas (método + caminho) para as instâncias configuradas. */
function allowed(method, url, patterns) {
  const p = url.pathname;
  for (const [m, re] of ROUTES) {
    const hit = method === m && p.match(re);
    if (hit) { try { return instanceAllowed(decodeURIComponent(hit[1]), patterns); } catch { return false; } }
  }
  if (method === 'GET' && p === '/instance/fetchInstances') return instanceAllowed(url.searchParams.get('instanceName'), patterns);
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
      if (!instanceAllowed(data.instanceName, env.INSTANCE)) return json(403, { message: `Só é permitido criar instâncias de: ${env.INSTANCE}` });
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
