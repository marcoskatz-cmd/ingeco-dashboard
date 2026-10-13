// Pestaña Accesos del tablero (oct-2026): solo Adrián y María (ADMIN_ACCESOS).
// GET  → lista de usuarios (semilla + planilla) con estado y permisos.
// POST → { mail, nombre, rol, editaObras, veSueldos, estado } guarda en la
//        planilla "Ajustes del tablero" (pestaña Accesos) vía Apps Script.
import { sessionFromRequestHeaders, ADMIN_ACCESOS } from '../lib/session.js';
import { listarAccesos, operarAccesos } from '../lib/accesos.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const session = await sessionFromRequestHeaders(req.headers);
    if (!session) return res.status(401).json({ status: 'error', message: 'No autorizado' });
    if (!ADMIN_ACCESOS.has(session.email)) return res.status(403).json({ status: 'error', message: 'Solo Adrián y María administran accesos' });

    if (req.method === 'GET') {
      const lista = await listarAccesos();
      return res.status(200).json({ status: 'ok', accesos: lista });
    }
    if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
    if (req.headers['x-requested-with'] !== 'ingeco-dashboard') return res.status(403).json({ status: 'error', message: 'Origen no permitido' });

    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    const mail = String(b.mail || '').trim().toLowerCase();
    if (!mail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return res.status(400).json({ status: 'error', message: 'Mail inválido' });
    if (ADMIN_ACCESOS.has(mail) && b.estado !== 'aprobado') return res.status(400).json({ status: 'error', message: 'Los administradores de accesos no se pueden bloquear desde acá' });
    const estado = ['pendiente', 'aprobado', 'bloqueado'].includes(b.estado) ? b.estado : null;
    const rol = ['directorio', 'administracion'].includes(b.rol) ? b.rol : '';
    if (!estado) return res.status(400).json({ status: 'error', message: 'Estado inválido' });
    if (estado === 'aprobado' && !rol) return res.status(400).json({ status: 'error', message: 'Elegí un rol' });

    const r = await operarAccesos({
      op: 'guardar', mail, nombre: String(b.nombre || '').slice(0, 80), rol, estado,
      editaObras: b.editaObras === true, veSueldos: b.veSueldos === true, usuario: session.email,
    });
    if (r.status !== 'ok') return res.status(502).json(r);
    const lista = await listarAccesos();
    res.status(200).json({ status: 'ok', accesos: lista });
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Error interno: ' + (err && err.message || '') });
  }
}

export const config = { maxDuration: 60 };
