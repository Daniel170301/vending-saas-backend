// utils/auth.js
// Verifica el token de sesión (Authorization: Bearer <token>) que la app ya manda en cada petición.
// Lo usan el entorno superadmin (/api/superadmin) y la creación de máquinas (solo el superadmin
// puede ponerles su equipo y su código KMT).
const jwt = require('jsonwebtoken');
const { usuarioPorEmail } = require('./usuarios');

const SECRETO = process.env.JWT_SECRET || null;
const ROLES_SUPERADMIN = new Set(['superadmin', 'super_admin', 'creador']);

if (SECRETO) {
  console.log('[auth] JWT_SECRET configurado: el entorno superadmin está protegido');
} else {
  console.warn('[auth] Falta JWT_SECRET en las variables de entorno: nadie podrá entrar al entorno superadmin ' +
    'hasta que lo configures en Render (Environment -> JWT_SECRET)');
}

const MENSAJES = {
  sin_configurar: 'Falta configurar JWT_SECRET en Render. Agrégalo y vuelve a iniciar sesión.',
  sin_token: 'Inicia sesión para hacer esta acción.',
  vencido: 'Tu sesión venció. Cierra sesión y vuelve a entrar.',
  invalido: 'Tu sesión no es válida. Cierra sesión y vuelve a entrar.',
  no_superadmin: 'Solo el superadmin de Qhapay puede hacer esto.',
};

// Lee y verifica el token. Devuelve { datos } o { motivo }.
function leerToken(req) {
  if (!SECRETO) return { motivo: 'sin_configurar' };
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.get('authorization') || '').trim());
  if (!m) return { motivo: 'sin_token' };
  try {
    return { datos: jwt.verify(m[1], SECRETO, { algorithms: ['HS256'] }) };
  } catch (e) {
    return { motivo: e && e.name === 'TokenExpiredError' ? 'vencido' : 'invalido' };
  }
}

// ¿La petición viene del superadmin? Además del token, revisa el rol ACTUAL en la base de datos
// (si le quitas el rol a alguien, deja de valer en menos de 60 s aunque su token siga vigente).
async function verificarSuperadmin(req) {
  const t = leerToken(req);
  if (!t.datos) return { ok: false, motivo: t.motivo };
  const email = t.datos.email;
  const u = email ? await usuarioPorEmail(email) : null;
  if (!u || !ROLES_SUPERADMIN.has(u.rol)) return { ok: false, motivo: 'no_superadmin' };
  return { ok: true, email: String(email).toLowerCase(), id: u.id };
}

// Middleware para rutas que solo puede usar el superadmin
async function soloSuperadmin(req, res, next) {
  try {
    const r = await verificarSuperadmin(req);
    if (!r.ok) {
      const status = r.motivo === 'no_superadmin' ? 403 : 401;
      return res.status(status).json({ success: false, codigo: r.motivo, message: MENSAJES[r.motivo] });
    }
    req.superadmin = r;
    next();
  } catch (e) {
    console.error('[auth] error verificando superadmin:', e.message);
    res.status(500).json({ success: false, message: 'Error del servidor' });
  }
}

module.exports = { verificarSuperadmin, soloSuperadmin, MENSAJES, ROLES_SUPERADMIN };
