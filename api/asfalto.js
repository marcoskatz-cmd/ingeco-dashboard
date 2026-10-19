// Ingreso de asfalto (materia prima) desde el tablero (oct-2026): mismo dato
// que el formulario de Google de Agustín. Agrega una fila a "Respuestas de
// formulario 1" de la planilla del formulario vía Apps Script (doPost
// action=ingresoAsfalto). Solo CARGA_ASFALTO; el usuario lo pone la sesión.
import { sessionFromRequestHeaders } from '../lib/session.js';

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwXe_MLjncMNA4-v8GLfmvhQFZG0cuMeXzSHIBccBIUUTTpXEvJuLhek-mC_S4twVCu9A/exec';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  try {
    const session = await sessionFromRequestHeaders(req.headers);
    if (!session) return res.status(401).json({ status: 'error', message: 'No autorizado' });
    if (!session.cargaAsfalto) return res.status(403).json({ status: 'error', message: 'Tu usuario no puede cargar ingresos de asfalto' });
    if (req.headers['x-requested-with'] !== 'ingeco-dashboard') return res.status(403).json({ status: 'error', message: 'Origen no permitido' });

    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    const fecha = String(b.fecha || '').trim();
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(fecha)) return res.status(400).json({ status: 'error', message: 'Fecha inválida' });
    const kg = Number(b.kg);
    if (!isFinite(kg) || kg <= 0 || kg > 100000) return res.status(400).json({ status: 'error', message: 'Cantidad inválida (kg)' });
    const condicion = b.condicion === 'Pagado' ? 'Pagado' : 'No pagado';
    const costo = b.costo === '' || b.costo == null ? '' : Number(b.costo);
    if (costo !== '' && (!isFinite(costo) || costo < 0)) return res.status(400).json({ status: 'error', message: 'Costo inválido' });

    const upstream = await fetch(APPS_SCRIPT_URL, {
      method: 'POST', redirect: 'follow',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'IngecoDashboardProxy/2.0' },
      body: JSON.stringify({ action: 'ingresoAsfalto', key: process.env.APPS_SCRIPT_KEY || '', usuario: session.email,
        fecha, remito: String(b.remito || '').trim().slice(0, 40), kg: Math.round(kg), condicion, costo }),
    });
    if (!upstream.ok) return res.status(502).json({ status: 'error', message: 'Apps Script HTTP ' + upstream.status });
    let data;
    try { data = JSON.parse(await upstream.text()); }
    catch { return res.status(502).json({ status: 'error', message: 'Apps Script no devolvió JSON' }); }
    res.status(data.status === 'ok' ? 200 : 400).json(data);
  } catch (err) {
    res.status(500).json({ status: 'error', message: 'Error interno' });
  }
}

export const config = { maxDuration: 60 };
