// Edge Middleware de Vercel: corre ANTES de servir cualquier archivo o función.
// Sin una sesión válida no se sirve nada (ni el HTML del tablero, ni los datos,
// ni archivos sueltos del repo). Solo quedan públicos el login y sus recursos.
import { sessionFromRequestHeaders } from './lib/session.js';

const PUBLIC = new Set(['/login.html', '/Logo.png', '/favicon.ico', '/robots.txt']);

export const config = {
  matcher: ['/((?!api/auth/).*)'],
};

export default async function middleware(req) {
  const url = new URL(req.url);
  const path = url.pathname;
  if (PUBLIC.has(path)) return;

  // Entrada desde la App INGECO con ticket: siempre se canjea (aunque haya sesión,
  // puede ser otra persona en el mismo navegador).
  const tk = url.searchParams.get('tk');
  if (tk && !path.startsWith('/api/')) {
    url.searchParams.delete('tk');
    const canje = new URL('/api/auth/ticket', req.url);
    canje.searchParams.set('tk', tk);
    canje.searchParams.set('next', path + url.search);
    return Response.redirect(canje.toString(), 302);
  }

  const session = await sessionFromRequestHeaders(req.headers);
  if (session) return; // sigue al recurso pedido

  if (path.startsWith('/api/')) {
    return new Response(JSON.stringify({ status: 'error', message: 'No autorizado' }), {
      status: 401,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  // Solo se permite volver a rutas internas (nunca a otro dominio)
  const next = path.startsWith('/') && !path.startsWith('//') ? path + url.search : '/';
  const login = new URL('/login.html', req.url);
  if (next !== '/' && next !== '/index.html') login.searchParams.set('next', next);
  return Response.redirect(login.toString(), 302);
}
