// Bot de consultas del tablero (oct-2026). El navegador manda la pregunta,
// el historial corto y un "paquete" compacto con los mismos números que
// muestra el tablero; acá se arma el prompt y se llama a Claude con la key
// de la organización de INGECO (ANTHROPIC_API_KEY en Vercel). La respuesta
// vuelve como texto. Exige sesión; lo que el usuario no puede ver en el
// tablero (sueldos, MO) se saca del paquete antes de llamar al modelo.
import Anthropic from '@anthropic-ai/sdk';
import { sessionFromRequestHeaders } from '../lib/session.js';

const MODEL = 'claude-opus-5-5';
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwXe_MLjncMNA4-v8GLfmvhQFZG0cuMeXzSHIBccBIUUTTpXEvJuLhek-mC_S4twVCu9A/exec';
const MAX_VUELTAS = 4;          // llamadas a herramientas por pregunta

// Herramienta: OC de insumos una por una (planilla de Guillermo). Se ejecuta
// acá en el servidor sobre las filas que devuelve Apps Script (action=ocDetalle).
const TOOLS = [{
  name: 'buscar_oc',
  description: 'Busca órdenes de compra (OC) de insumos UNA POR UNA en la planilla de Guillermo (año en curso). Usala para preguntas sobre OC individuales: la OC más grande o más chica, qué se le compró a un proveedor, OC de una obra o de un mes, OC con cierta descripción, cantidad de OC. Devuelve las filas que coinciden ordenadas, la cantidad total de coincidencias y la suma de sus montos. Los filtros de texto son "contiene", sin importar mayúsculas ni acentos. Para totales por obra/mes alcanza con el paquete; usá esta herramienta cuando haga falta el detalle de cada orden.',
  input_schema: {
    type: 'object',
    properties: {
      mes: { type: 'string', enum: ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'], description: 'Mes de la fecha de la OC (opcional).' },
      obra: { type: 'string', description: 'Texto contenido en la obra o el código de obra (opcional).' },
      proveedor: { type: 'string', description: 'Texto contenido en el proveedor (opcional).' },
      texto: { type: 'string', description: 'Texto contenido en la descripción de la OC (opcional), ej. "cemento", "mano de obra".' },
      estado: { type: 'string', description: 'Texto contenido en el estado (opcional), ej. "acept", "pend".' },
      orden: { type: 'string', enum: ['monto_desc', 'monto_asc', 'fecha_desc', 'fecha_asc'], description: 'Orden del resultado. Por defecto monto_desc.' },
      limite: { type: 'integer', minimum: 1, maximum: 50, description: 'Cantidad máxima de filas a devolver (por defecto 15).' },
    },
    additionalProperties: false,
  },
}];

let _ocCache = { t: 0, filas: null };
async function _ocFilas() {
  if (_ocCache.filas && Date.now() - _ocCache.t < 10 * 60 * 1000) return _ocCache.filas;
  const p = new URLSearchParams({ action: 'ocDetalle', key: process.env.APPS_SCRIPT_KEY || '' });
  const r = await fetch(APPS_SCRIPT_URL + '?' + p.toString(), { redirect: 'follow', headers: { 'User-Agent': 'IngecoDashboardProxy/2.0' } });
  if (!r.ok) throw new Error('Apps Script HTTP ' + r.status);
  const j = JSON.parse(await r.text());
  if (j.status !== 'ok' || !Array.isArray(j.ocs)) throw new Error('Respuesta inválida de OC');
  _ocCache = { t: Date.now(), filas: j.ocs };
  return j.ocs;
}
const _norm = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const _fechaNum = f => { const m = String(f || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? +m[3] * 10000 + +m[2] * 100 + +m[1] : 0; };
async function buscarOC(q) {
  const filas = await _ocFilas();
  const f = (campo, txt) => !q[campo] || _norm(txt).includes(_norm(q[campo]));
  const res = filas.filter(r => (!q.mes || r[2] === q.mes) && f('obra', r[4] + ' ' + r[5]) && f('proveedor', r[3]) && f('texto', r[6]) && f('estado', r[8]));
  const orden = q.orden || 'monto_desc';
  res.sort((a, b) => orden === 'monto_asc' ? a[7] - b[7] : orden === 'fecha_desc' ? _fechaNum(b[1]) - _fechaNum(a[1]) : orden === 'fecha_asc' ? _fechaNum(a[1]) - _fechaNum(b[1]) : b[7] - a[7]);
  const limite = Math.min(50, Math.max(1, parseInt(q.limite) || 15));
  return {
    coincidencias: res.length, sumaMontos: res.reduce((s, r) => s + r[7], 0), totalOCdelAnio: filas.length,
    filas: res.slice(0, limite).map(r => ({ orden: r[0], fecha: r[1], proveedor: r[3], obra: r[4] || '(sin obra)', codigo: r[5] || undefined, descripcion: r[6], monto: r[7], estado: r[8] || undefined, filaPlanilla: r[9] })),
  };
}
const MAX_PAQUETE = 900 * 1024; // bytes de JSON
const MAX_HISTORIAL = 12;       // turnos (user+assistant) que se reenvían

const SYSTEM = `Sos INGEBOT, el asistente del Dashboard Ejecutivo de INGECO (constructora vial de Tucumán, Argentina). Respondés preguntas del directorio sobre los números del tablero.

Reglas:
- Usá SOLO los datos del paquete JSON que viene después. Si algo no está, decí "no tengo ese dato en el tablero" y, si corresponde, sugerí dónde podría estar (archivo de Agustín, planilla de Esteban, OC de Guillermo, TANGO de Mauro, libro mayor de Romina, remitos de Roberto).
- Montos en pesos argentinos, formato es-AR con millones: $1.234,5M (un decimal). Toneladas con separador de miles y "tn". Porcentajes con un decimal.
- Nombrá la fuente al final de cada dato relevante, entre paréntesis y corto: (Agustín), (Esteban), (OC Guillermo), (TANGO), (Romina), (remitos).
- Sé breve y directo: una o dos frases, o una lista corta si piden comparar. Sin introducciones ni cierres de cortesía. Español rioplatense, voseo.
- Si la pregunta es ambigua (una obra con varias etapas, un mes no dicho), contestá para lo más probable y aclarálo en media línea. Si no dicen mes, usá el mes seleccionado en el tablero.
- Si piden algo que no es una consulta de datos (cambiar cosas, mandar mails, opiniones sobre personas), decí que solo respondés consultas del tablero.
- Si te preguntan cómo te llamás o quién sos: INGEBOT, el asistente del tablero de INGECO.
- Nunca inventes obras, montos ni meses. Si tenés que sumar o restar, hacelo con cuidado y mostrá la cuenta en una línea cuando sume más de dos cosas.

Glosario del paquete:
- meses: por mes (ene..dic 2026). obras[]: por obra: certificado (lo certificado del período, archivo de Agustín), estadoCert, insumos (OC de insumos, Guillermo, incluye MO tercerizada moHormigon), moPropia (mano de obra propia TANGO), alquiler (alquiler interno de equipos, SIN combustible), combustible (cargas de combustible a equipos y vehículos de la obra: tanque propio de Leandro Casares y estaciones Tiburcio Sanz / Carlos Herrero), asfaltoCalienteTn / asfaltoFrioTn (remitos), costoAsfalto (teórico), margen (contribución marginal = certificado − insumos − moPropia − alquiler − costoAsfalto − combustible).
- ocInsumos: OC de insumos del mes (planilla de Guillermo): total, cantidad de OC y por obra la lista de proveedores con monto y nOC (cantidad de órdenes). Si nOC es 1, ese monto es el de una sola OC; si es mayor, es la suma de varias. Para el detalle orden por orden (número de OC, fecha, descripción, estado) usá la herramienta buscar_oc; las OC no traen fecha de pago (el monto es el de la orden; los pagos están en el libro mayor de Romina). "Obra no disponible" / "Sin clasificar" = OC sin obra asignada.
- provisiones[]: certificación de provisiones de asfalto/pavimax del mes (real de Esteban si la cargó, si no teórica tn × precio).
- totalCertificado: certificado de obras + provisiones del mes (es la tarjeta "Total Certificado").
- cobrosEsteban: por obra, lo cobrado, facturado (sin cobrar), programado (sin fecha) y menosProbable del mes según la planilla de Esteban.
- estructura: gastos de estructura del mes por categoría (libro mayor de Romina; "Sueldos personal mensual" solo si el usuario puede verlo).
- taller / planta: resultado del Taller mecánico y de la Planta de asfalto del mes.
- seguimientoCobros: acumulado por obra de todo el año: cobrado y pendiente según Esteban.
- saldosContrato: por obra, monto de contrato, certificado acumulado y pendiente de certificar.
- stockAsfalto: stock actual de asfalto (materia prima) y de frío terminado, en tn.
- auditorias[]: inconsistencias abiertas entre archivos (título, tipo, monto, responsable).`;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'Método no permitido' });
  try {
    const session = await sessionFromRequestHeaders(req.headers);
    if (!session) return res.status(401).json({ status: 'error', message: 'No autorizado' });
    if (req.headers['x-requested-with'] !== 'ingeco-dashboard') return res.status(403).json({ status: 'error', message: 'Origen no permitido' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ status: 'error', code: 'sin_key', message: 'El bot todavía no está configurado (falta la clave de Anthropic en Vercel).' });

    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const pregunta = String(body.pregunta || '').trim().slice(0, 1500);
    if (!pregunta) return res.status(400).json({ status: 'error', message: 'Falta la pregunta' });

    // Paquete de datos: lo arma el tablero con lo que tiene en pantalla.
    let paquete = body.paquete && typeof body.paquete === 'object' ? body.paquete : {};
    paquete = _recortarPorPermisos(paquete, session);
    const paqueteJson = JSON.stringify(paquete);
    if (paqueteJson.length > MAX_PAQUETE) return res.status(413).json({ status: 'error', message: 'El paquete de datos es demasiado grande' });

    // Historial corto (solo texto), para poder repreguntar.
    const historial = Array.isArray(body.historial) ? body.historial.slice(-MAX_HISTORIAL) : [];
    const messages = [];
    for (const h of historial) {
      if (!h || (h.role !== 'user' && h.role !== 'assistant')) continue;
      const c = String(h.content || '').trim().slice(0, 4000);
      if (!c) continue;
      if (messages.length && messages[messages.length - 1].role === h.role) continue; // alternancia
      messages.push({ role: h.role, content: c });
    }
    if (messages.length && messages[0].role !== 'user') messages.shift();
    if (messages.length && messages[messages.length - 1].role === 'user') messages.pop();
    messages.push({ role: 'user', content: pregunta });

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const system = [
      { type: 'text', text: SYSTEM },
      // El paquete cambia solo cuando se actualizan los datos: cacheable.
      { type: 'text', text: 'Usuario: ' + session.email + ' (rol ' + session.role + ').\n\nPAQUETE DE DATOS DEL TABLERO:\n' + paqueteJson, cache_control: { type: 'ephemeral' } },
    ];
    // Bucle de herramientas: si Claude pide buscar_oc, se ejecuta acá y se le
    // devuelve el resultado; se corta cuando responde el texto final.
    let response;
    const usoTot = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    for (let vuelta = 0; vuelta <= MAX_VUELTAS; vuelta++) {
      response = await client.beta.messages.create({
        model: MODEL, max_tokens: 2000,
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        system, tools: TOOLS, messages,
      });
      const u = response.usage || {};
      usoTot.input += u.input_tokens || 0; usoTot.cacheRead += u.cache_read_input_tokens || 0;
      usoTot.cacheWrite += u.cache_creation_input_tokens || 0; usoTot.output += u.output_tokens || 0;
      if (response.stop_reason !== 'tool_use' || vuelta === MAX_VUELTAS) break;
      messages.push({ role: 'assistant', content: response.content });
      const resultados = [];
      for (const b of response.content) {
        if (b.type !== 'tool_use') continue;
        let out, isError = false;
        try {
          if (b.name !== 'buscar_oc') throw new Error('Herramienta desconocida');
          out = await buscarOC(b.input && typeof b.input === 'object' ? b.input : {});
        } catch (e) { out = { error: 'No se pudo consultar la planilla de OC: ' + (e && e.message || e) }; isError = true; }
        const tr = { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out) };
        if (isError) tr.is_error = true;
        resultados.push(tr);
      }
      messages.push({ role: 'user', content: resultados });
    }

    if (response.stop_reason === 'refusal') {
      return res.status(200).json({ status: 'ok', respuesta: 'No puedo responder eso desde el tablero.', refusal: true });
    }
    const texto = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    res.status(200).json({
      status: 'ok',
      respuesta: texto || 'No obtuve respuesta. Probá de nuevo.',
      usage: usoTot,
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return res.status(503).json({ status: 'error', code: 'key_invalida', message: 'La clave de Anthropic no es válida.' });
    if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ status: 'error', message: 'Demasiadas consultas seguidas. Esperá un momento.' });
    if (err instanceof Anthropic.APIError) return res.status(502).json({ status: 'error', message: 'Error del servicio (' + err.status + '). ' + (err.message || '') });
    res.status(500).json({ status: 'error', message: 'Error interno' });
  }
}

// Saca del paquete lo que el usuario no puede ver en el tablero: sueldos del
// personal mensual (solo VE_SUELDOS) y mano de obra (solo rol directorio).
function _recortarPorPermisos(p, session) {
  const out = JSON.parse(JSON.stringify(p));
  const veSueldos = !!session.veSueldos;
  const veMO = session.role === 'directorio';
  const meses = out.meses && typeof out.meses === 'object' ? out.meses : {};
  for (const m of Object.keys(meses)) {
    const x = meses[m]; if (!x || typeof x !== 'object') continue;
    if (!veSueldos && Array.isArray(x.estructura)) x.estructura = x.estructura.filter(c => !/sueldo/i.test(c.categoria || ''));
    if (!veMO) {
      (x.obras || []).forEach(o => { delete o.moPropia; });
      delete x.moObras; delete x.moTaller; delete x.moPlanta;
      if (x.taller) delete x.taller.mo;
      if (x.planta) delete x.planta.mo;
    }
  }
  if (!veMO) out.notas = (out.notas || []).concat(['Este usuario no ve mano de obra ni sueldos: si preguntan por eso, decí que no está disponible para su usuario.']);
  if (!veSueldos) out.notas = (out.notas || []).concat(['Este usuario no ve sueldos del personal mensual.']);
  return out;
}

export const config = { maxDuration: 60 };
