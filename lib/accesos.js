// Accesos dinámicos (oct-2026): la lista de usuarios vive en la pestaña
// "Accesos" de la planilla "Ajustes del tablero" (Apps Script) y la editan
// Adrián y María desde la pestaña Accesos del tablero. Los mails de
// lib/session.js (ALLOWED_USERS) quedan como semilla: valen si la planilla
// no dice otra cosa. Una fila de la planilla manda sobre la semilla.
// Solo para funciones Node (no para el middleware Edge): usa fetch con la
// clave secreta y cachea la lista unos segundos por instancia.
import { ALLOWED_USERS, OBRAS_EDITORES, VE_SUELDOS, ADMIN_ACCESOS, NOMBRES } from './session.js';

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwXe_MLjncMNA4-v8GLfmvhQFZG0cuMeXzSHIBccBIUUTTpXEvJuLhek-mC_S4twVCu9A/exec';
const CACHE_MS = 30 * 1000;
let _cache = { t: 0, lista: null };

export async function leerAccesos(force) {
  if (!force && _cache.lista && Date.now() - _cache.t < CACHE_MS) return _cache.lista;
  const p = new URLSearchParams({ action: 'accesos', key: process.env.APPS_SCRIPT_KEY || '' });
  const r = await fetch(APPS_SCRIPT_URL + '?' + p.toString(), { redirect: 'follow', headers: { 'User-Agent': 'IngecoDashboardProxy/2.0' } });
  if (!r.ok) throw new Error('Apps Script HTTP ' + r.status);
  const j = JSON.parse(await r.text());
  if (j.status !== 'ok' || !Array.isArray(j.accesos)) throw new Error('Respuesta inválida de accesos');
  _cache = { t: Date.now(), lista: j.accesos };
  return j.accesos;
}

export async function operarAccesos(body) {
  const r = await fetch(APPS_SCRIPT_URL, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'IngecoDashboardProxy/2.0' },
    body: JSON.stringify({ action: 'accesos', key: process.env.APPS_SCRIPT_KEY || '', ...body }),
  });
  if (!r.ok) throw new Error('Apps Script HTTP ' + r.status);
  const j = JSON.parse(await r.text());
  _cache = { t: 0, lista: null };
  return j;
}

// Usuario según semilla + planilla. Devuelve null si no puede entrar.
// { email, role, editaObras, veSueldos, adminAccesos, nombre, estado, origen }
export function resolverDesdeLista(email, lista) {
  const e = String(email || '').trim().toLowerCase();
  const semilla = Object.prototype.hasOwnProperty.call(ALLOWED_USERS, e) ? ALLOWED_USERS[e] : null;
  const fila = (lista || []).find(a => a.mail === e);
  const admin = ADMIN_ACCESOS.has(e);
  if (fila && fila.estado === 'bloqueado' && !admin) return { email: e, estado: 'bloqueado' };
  if (fila && fila.estado === 'aprobado') {
    return { email: e, role: fila.rol === 'administracion' ? 'administracion' : 'directorio',
      editaObras: !!fila.editaObras || admin, veSueldos: !!fila.veSueldos || admin, adminAccesos: admin,
      nombre: fila.nombre || NOMBRES[e] || e.split('@')[0], estado: 'aprobado', origen: 'planilla' };
  }
  if (semilla) {
    return { email: e, role: semilla, editaObras: OBRAS_EDITORES.has(e) || admin, veSueldos: VE_SUELDOS.has(e) || admin,
      adminAccesos: admin, nombre: NOMBRES[e] || e.split('@')[0], estado: 'aprobado', origen: 'semilla' };
  }
  if (fila) return { email: e, estado: fila.estado || 'pendiente' };
  return null;
}

export async function resolverUsuario(email) {
  let lista = [];
  try { lista = await leerAccesos(); } catch (e) { lista = []; } // si la planilla no responde, vale la semilla
  return resolverDesdeLista(email, lista);
}

// Lista completa para la pestaña Accesos: semilla + planilla, una fila por mail.
// Contactos para el atajo de WhatsApp del bot (cualquier usuario con sesión):
// solo nombre y celular de las cuentas aprobadas que tengan celular cargado.
export async function listarContactos() {
  const lista = await listarAccesos();
  return lista.filter(a => a.estado === 'aprobado' && a.celular).map(a => ({ nombre: a.nombre || a.mail.split('@')[0], celular: a.celular }));
}

export async function listarAccesos() {
  const lista = await leerAccesos(true);
  const mails = new Set([...Object.keys(ALLOWED_USERS), ...lista.map(a => a.mail)]);
  const out = [];
  for (const m of mails) {
    const u = resolverDesdeLista(m, lista);
    const fila = lista.find(a => a.mail === m);
    out.push({
      mail: m, nombre: (u && u.nombre) || (fila && fila.nombre) || NOMBRES[m] || '',
      rol: u && u.role ? u.role : (fila && fila.rol) || '',
      editaObras: !!(u && u.editaObras), veSueldos: !!(u && u.veSueldos),
      estado: u ? u.estado : 'pendiente', adminAccesos: ADMIN_ACCESOS.has(m),
      origen: u && u.origen ? u.origen : 'planilla', solicitado: fila ? fila.solicitado : '', actualizado: fila ? fila.actualizado : '', por: fila ? fila.por : '',
      celular: fila && fila.celular ? fila.celular : '',
    });
  }
  const orden = { pendiente: 0, aprobado: 1, bloqueado: 2 };
  out.sort((a, b) => (orden[a.estado] ?? 3) - (orden[b.estado] ?? 3) || a.mail.localeCompare(b.mail));
  return out;
}
