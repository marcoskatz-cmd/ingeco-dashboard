// Bot de consultas del tablero (oct-2026). El navegador manda la pregunta,
// el historial corto y un "paquete" compacto con los mismos números que
// muestra el tablero; acá se arma el prompt y se llama a Claude con la key
// de la organización de INGECO (ANTHROPIC_API_KEY en Vercel). La respuesta
// vuelve como texto. Exige sesión; lo que el usuario no puede ver en el
// tablero (sueldos, MO) se saca del paquete antes de llamar al modelo.
import Anthropic from '@anthropic-ai/sdk';
import { sessionFromRequestHeaders, VE_SUELDOS } from '../lib/session.js';

const MODEL = 'claude-opus-5-5';
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
- meses: por mes (ene..dic 2026). obras[]: por obra: certificado (lo certificado del período, archivo de Agustín), estadoCert, insumos (OC de insumos, Guillermo, incluye MO tercerizada moHormigon), moPropia (mano de obra propia TANGO), alquiler (alquiler interno de equipos), asfaltoCalienteTn / asfaltoFrioTn (remitos), costoAsfalto (teórico), margen (contribución marginal = certificado − insumos − moPropia − alquiler − costoAsfalto).
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
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 1500,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [
        { type: 'text', text: SYSTEM },
        // El paquete cambia solo cuando se actualizan los datos: cacheable.
        { type: 'text', text: 'Usuario: ' + session.email + ' (rol ' + session.role + ').\n\nPAQUETE DE DATOS DEL TABLERO:\n' + paqueteJson, cache_control: { type: 'ephemeral' } },
      ],
      messages,
    });

    if (response.stop_reason === 'refusal') {
      return res.status(200).json({ status: 'ok', respuesta: 'No puedo responder eso desde el tablero.', refusal: true });
    }
    const texto = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    res.status(200).json({
      status: 'ok',
      respuesta: texto || 'No obtuve respuesta. Probá de nuevo.',
      usage: { input: response.usage.input_tokens, cacheRead: response.usage.cache_read_input_tokens || 0, cacheWrite: response.usage.cache_creation_input_tokens || 0, output: response.usage.output_tokens },
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
  const veSueldos = VE_SUELDOS.has(session.email);
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
