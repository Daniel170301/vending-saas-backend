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
  const { rows } = await pool.query('SELECT id, rol FROM usuarios_duenos WHERE lower(email) = $1 LIMIT 1', [clave]);
  const valor = rows[0] ? { id: rows[0].id, rol: String(rows[0].rol || 'dueno').toLowerCase() } : null;
  cache.set(clave, { valor, vence: Date.now() + TTL_MS });
  if (cache.size > 5000) cache.clear();
  return valor;
}

async function rolDe(email) {
  const u = await usuarioPorEmail(email);
  return u ? u.rol : 'dueno';
}

const olvidar = (email) => cache.delete(String(email || '').trim().toLowerCase());

module.exports = { usuarioPorEmail, rolDe, olvidar };
