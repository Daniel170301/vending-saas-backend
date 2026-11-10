// utils/usuarios.js
// Casi todas las rutas preguntan primero "¿qué rol tiene este correo?". Se guarda la
// respuesta 60 s en memoria para no repetir esa consulta en cada petición.
const pool = require('../config/database');

const TTL_MS = 60 * 1000;
const cache = new Map();   // email -> { valor, vence }

async function usuarioPorEmail(email) {
  const clave = String(email || '').trim().toLowerCase();
  if (!clave) return null;
  const hit = cache.get(clave);
  if (hit && hit.vence > Date.now()) return hit.valor;
  // v3.6.4: to_jsonb lee sesiones_desde aunque la columna todavía no exista (primeros segundos tras subir)
  const { rows } = await pool.query(
    "SELECT u.id, u.rol, (to_jsonb(u) ->> 'sesiones_desde') AS sesiones_desde FROM usuarios_duenos u WHERE lower(u.email) = $1 ORDER BY u.id LIMIT 1",
    [clave]);
  const valor = rows[0] ? {
    id: rows[0].id,
    rol: String(rows[0].rol || 'dueno').toLowerCase(),
    sesionesDesde: rows[0].sesiones_desde ? Date.parse(rows[0].sesiones_desde) : null,
  } : null;
  cache.set(clave, { valor, vence: Date.now() + TTL_MS });
  if (cache.size > 5000) cache.clear();
  return valor;
}

async function rolDe(email) {
  const u = await usuarioPorEmail(email);
  return u ? u.rol : 'dueno';
}

const olvidar = (email) => cache.delete(String(email || '').trim().toLowerCase());

// v3.6.4 · "Cerrar sesión en todos los dispositivos": los tokens emitidos antes de esta hora dejan
// de valer. Se usa al cambiar o restablecer la contraseña y desde Perfil.
async function asegurarColumna() {
  await pool.query('ALTER TABLE usuarios_duenos ADD COLUMN IF NOT EXISTS sesiones_desde TIMESTAMPTZ');
}

async function cerrarSesiones(id, email) {
  const sql = "UPDATE usuarios_duenos SET sesiones_desde = date_trunc('second', now()) WHERE id = $1";
  try {
    await pool.query(sql, [id]);
  } catch (e) {
    if (e.code !== '42703') throw e;   // la columna aún no existe (arranque reciente): se crea y se reintenta
    await asegurarColumna();
    await pool.query(sql, [id]);
  }
  olvidar(email);
}

module.exports = { usuarioPorEmail, rolDe, olvidar, asegurarColumna, cerrarSesiones };
