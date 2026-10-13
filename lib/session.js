// Sesión del tablero: cookie HttpOnly con un JWT firmado (HS256) por el
// servidor. La usan las funciones de /api y el middleware (Edge runtime),
// por eso solo depende de `jose` y de APIs web estándar (sin Node-only).
import { SignJWT, jwtVerify } from 'jose';

// Quién puede entrar y con qué rol. Los mails no son secretos: el secreto es
// que Google confirme la identidad (ID token firmado) y la firma de la sesión.
export const ALLOWED_USERS = {
  'marcoskatz@grupoingeco.com.ar': 'directorio',
  'adriankoss@grupoingeco.com.ar': 'directorio',
  'mariacaram94@gmail.com':        'directorio',
  'adegregorio@grupoingeco.com.ar': 'directorio',      // Agustín — Obras a cobrar, Maestro, precios
  'sergiocangemi@grupoingeco.com.ar': 'directorio',    // Sergio — Obras a cobrar, Maestro
  'mantenimiento@grupoingeco.com.ar': 'administracion', // Mantenimiento (Nico) — Partes diarios, Repuestos (no ve sueldos)
  'cpngonzalo@gmail.com':           'administracion',  // Gonzalo — coordinador (única cuenta fuera de grupoingeco, junto con María)
  'deposito@grupoingeco.com.ar':    'administracion',  // Roberto — Remitos oficiales (no ve sueldos)
  'compras1@grupoingeco.com.ar':    'administracion',  // Guillermo — OC de insumos
  'contabilidad2@grupoingeco.com.ar': 'administracion', // Romina — Gastos de estructura (no ve sueldos)
  'sueldos01@grupoingeco.com.ar':   'directorio',      // Mauro — Quincenas TANGO (ve sueldos)
  'esaguir@grupoingeco.com.ar':     'administracion',  // Esteban — Cobros
  'mindloopia.auth@gmail.com':      'administracion',  // María — cuenta de prueba para ver el rol Administración
};

// Nombre de pila para el saludo del tablero ("Hola, María"). Si falta, se
// usa la parte del mail antes de la @.
export const NOMBRES = {
  'marcoskatz@grupoingeco.com.ar': 'Marcos',
  'adriankoss@grupoingeco.com.ar': 'Adrián',
  'mariacaram94@gmail.com': 'María',
  'adegregorio@grupoingeco.com.ar': 'Agustín',
  'sergiocangemi@grupoingeco.com.ar': 'Sergio',
  'mantenimiento@grupoingeco.com.ar': 'Nico',
  'cpngonzalo@gmail.com': 'Gonzalo',
  'deposito@grupoingeco.com.ar': 'Roberto',
  'compras1@grupoingeco.com.ar': 'Guillermo',
  'contabilidad2@grupoingeco.com.ar': 'Romina',
  'sueldos01@grupoingeco.com.ar': 'Mauro',
  'esaguir@grupoingeco.com.ar': 'Esteban',
  'mindloopia.auth@gmail.com': 'María (prueba)',
};
export const nombreDe = email => NOMBRES[email] || String(email || '').split('@')[0];

// Quién puede dar de alta obras y cargar certificados desde el tablero
// (formulario "Nueva obra"). El resto solo mira. El historial queda en la
// pestaña "Historial" de Obras a cobrar.
// Sueldos del personal mensual (hoja Mensuales de TANGO → Gastos de
// Estructura): solo Adrián y María. El proxy los saca del JSON para el resto
// y el front oculta la categoría (clase ve-sueldos en body).
export const VE_SUELDOS = new Set(['adriankoss@grupoingeco.com.ar', 'mariacaram94@gmail.com']);

// Quién administra accesos desde la pestaña Accesos del tablero (aprobar,
// bloquear, rol y permisos). No se pueden bloquear a sí mismos.
export const ADMIN_ACCESOS = new Set(['adriankoss@grupoingeco.com.ar', 'mariacaram94@gmail.com']);

export const OBRAS_EDITORES = new Set([
  'adegregorio@grupoingeco.com.ar',   // Agustín
  'sergiocangemi@grupoingeco.com.ar', // Sergio
  'adriankoss@grupoingeco.com.ar',    // Adrián
  'cpngonzalo@gmail.com',             // Gonzalo
  'mariacaram94@gmail.com',           // María
]);

export const COOKIE_NAME = '__Host-ingeco_session'; // prefijo __Host-: solo https, Path=/, sin Domain
export const SESSION_HOURS = 12;
const ISSUER = 'ingeco-dashboard';

function secretKey() {
  const s = process.env.SESSION_SECRET || '';
  if (s.length < 32) throw new Error('SESSION_SECRET no configurado (mínimo 32 caracteres)');
  return new TextEncoder().encode(s);
}

export function roleFor(email) {
  const e = String(email || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ALLOWED_USERS, e) ? ALLOWED_USERS[e] : null;
}

// Permisos que viajan en la sesión (se resuelven al iniciar sesión con la
// semilla + la planilla de Accesos): rol, edita obras, ve sueldos, nombre y
// si el mail entró por la planilla (dyn) y no por la semilla del código.
export async function signSession(email, role, extra) {
  const x = extra || {};
  return new SignJWT({ role, ed: !!x.editaObras, vs: !!x.veSueldos, nm: String(x.nombre || '').slice(0, 60), dyn: !!x.dyn })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(email)
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setIssuedAt()
    .setExpirationTime(SESSION_HOURS + 'h')
    .sign(secretKey());
}

// Devuelve { email, role, editaObras, veSueldos, adminAccesos, nombre } o null.
// Mails de la semilla: se vuelve a chequear la lista del código (si se saca
// uno, sus sesiones dejan de servir al instante). Mails aprobados desde la
// planilla (dyn): vale la sesión hasta que venza (12 h); un bloqueo en la
// planilla corta el ingreso siguiente.
export async function verifySession(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { issuer: ISSUER, audience: ISSUER, algorithms: ['HS256'] });
    const email = String(payload.sub || '').toLowerCase();
    const semilla = roleFor(email);
    if (!semilla && !payload.dyn) return null;
    const role = payload.role === 'administracion' ? 'administracion' : 'directorio';
    const admin = ADMIN_ACCESOS.has(email);
    return {
      email, role,
      editaObras: !!payload.ed || OBRAS_EDITORES.has(email) && !payload.dyn || admin,
      veSueldos: !!payload.vs || admin,
      adminAccesos: admin,
      nombre: String(payload.nm || '') || NOMBRES[email] || email.split('@')[0],
    };
  } catch {
    return null;
  }
}

export function readCookie(cookieHeader, name) {
  const h = cookieHeader || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(token) {
  const maxAge = SESSION_HOURS * 3600;
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function sessionFromRequestHeaders(headers) {
  const cookie = typeof headers.get === 'function' ? headers.get('cookie') : headers.cookie;
  return verifySession(readCookie(cookie, COOKIE_NAME));
}
