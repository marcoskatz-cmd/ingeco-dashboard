// Entrada desde la App INGECO (marcoskatz-cmd.github.io/app-ingeco): la app abre
// el tablero con ?tk=<ticket de un solo uso, 5 min>. El middleware deriva acá,
// el ticket se canjea contra el backend común de la app (que ya validó la cuenta
// Google de la persona) y, si el mail tiene acceso al tablero, se emite la sesión.
// El allowlist / planilla de accesos de este tablero sigue mandando.
import { signSession, sessionCookieEmbebible } from '../../lib/session.js';
import { resolverUsuario } from '../../lib/accesos.js';

const APP_INGECO_BACKEND = 'https://script.google.com/macros/s/AKfycbx9NN1FfOQjUjfymLXrMyd2QM6l96HP0lxY6RC7_xKsbDlO0PnwdHbaMtag54VYFor0/exec';
const MODULO = 'DASHBOARD';

function volverALogin(res, motivo) {
  res.setHeader('Location', '/login.html?shell=' + encodeURIComponent(motivo));
  return res.status(302).end();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).end();

  const tk = String(req.query.tk || '');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(tk)) return volverALogin(res, 'ticket');
  const n = String(req.query.next || '/');
  const next = (n.startsWith('/') && !n.startsWith('//') && !n.includes('\\')) ? n : '/';

  let r;
  try {
    const resp = await fetch(APP_INGECO_BACKEND, {
      method: 'POST', redirect: 'follow',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ accion: 'validar_ticket', payload: { ticket: tk, modulo: MODULO } }),
    });
    r = await resp.json();
  } catch (e) { return volverALogin(res, 'conexion'); }
  if (!r || !r.ok || !r.email) return volverALogin(res, 'ticket');

  const email = String(r.email).trim().toLowerCase();
  const u = await resolverUsuario(email);
  if (!u || u.estado !== 'aprobado') return volverALogin(res, 'sin_acceso');

  const token = await signSession(email, u.role, { editaObras: u.editaObras, veSueldos: u.veSueldos, nombre: u.nombre, dyn: u.origen === 'planilla' });
  res.setHeader('Set-Cookie', sessionCookieEmbebible(token));
  res.setHeader('Location', next);
  return res.status(302).end();
}
