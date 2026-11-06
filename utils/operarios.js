// utils/operarios.js
// v3.6 · Cuentas de OPERARIO: personas que rellenan las máquinas de un dueño.
//  - Se registran solas en QhaPay con usuario y contraseña (sin correo).
//  - Para trabajar, escriben el CÓDIGO que les da el dueño (Perfil → Operarios). Desde ese
//    momento ven solo el Planograma y el Inventario de ese dueño, y pueden rellenar.
//  - El dueño los puede pausar o quitar cuando quiera; se nota en la siguiente petición.
const crypto = require('crypto');
const pool = require('../config/database');

let listo = null;
function asegurarTablas() {
  if (!listo) {
    listo = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS operarios (
          id            SERIAL PRIMARY KEY,
          usuario       TEXT NOT NULL,
          nombre        TEXT,
          password      TEXT NOT NULL,
          id_dueno      TEXT,
          activo        BOOLEAN NOT NULL DEFAULT true,
          creado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
          vinculado_en  TIMESTAMPTZ,
          ultimo_ingreso TIMESTAMPTZ
        )`);
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS operarios_usuario_uk ON operarios (lower(usuario))');
      await pool.query('CREATE INDEX IF NOT EXISTS operarios_dueno_ix ON operarios (id_dueno)');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS operario_codigos (
          id_dueno  TEXT PRIMARY KEY,
          codigo    TEXT NOT NULL UNIQUE,
          creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
    })().catch((e) => { listo = null; throw e; });
  }
  return listo;
}

// ---- Código para vincular (8 caracteres sin letras confusas: sin 0/O ni 1/I) --------------
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function nuevoCodigo() {
  const b = crypto.randomBytes(8);
  let c = '';
  for (let i = 0; i < 8; i++) c += ALFABETO[b[i] % ALFABETO.length];
  return c;
}
const mostrarCodigo = (c) => (c ? `${c.slice(0, 4)}-${c.slice(4)}` : c);
const normalizarCodigo = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ---- Usuario de operario -------------------------------------------------------------------
const USUARIO_OK = /^[a-z0-9._-]{3,30}$/;
const normalizarUsuario = (u) => String(u || '').trim().toLowerCase();

// ---- Caché corta (cada petición de un operario consulta su estado) -------------------------
const cache = new Map();   // id -> { t, op }
const TTL_MS = 30 * 1000;
function olvidarOperario(id) { cache.delete(String(id)); }
function olvidarTodos() { cache.clear(); }

/**
 * Operario con su dueño: { id, usuario, nombre, activo, id_dueno, dueno: { id, email, nombre, rol } | null }
 * El dueño se ignora si ya no existe o su cuenta fue eliminada.
 */
async function buscarOperario(id) {
  const k = String(id);
  const c = cache.get(k);
  if (c && Date.now() - c.t < TTL_MS) return c.op;
  await asegurarTablas();
  const r = await pool.query(
    `SELECT o.id, o.usuario, o.nombre, o.activo, o.id_dueno,
            u.id AS d_id, u.email AS d_email, u.nombre AS d_nombre, u.rol AS d_rol
       FROM operarios o
       LEFT JOIN usuarios_duenos u ON u.id::text = o.id_dueno
      WHERE o.id::text = $1`, [k]);
  const f = r.rows[0];
  const op = f ? {
    id: f.id, usuario: f.usuario, nombre: f.nombre, activo: f.activo, id_dueno: f.id_dueno,
    dueno: f.d_id != null && f.d_rol !== 'eliminado' && f.d_email
      ? { id: String(f.d_id), email: String(f.d_email).toLowerCase(), nombre: f.d_nombre, rol: f.d_rol } : null,
  } : null;
  cache.set(k, { t: Date.now(), op });
  if (cache.size > 5000) cache.clear();
  return op;
}

// Lo que ve la app de la sesión del operario. "email" es el del dueño: la app lo usa en sus
// consultas (el servidor de todas formas responde con los datos del dueño de la sesión).
function usuarioSesion(op) {
  return {
    id: `op-${op.id}`,
    email: op.dueno ? op.dueno.email : '',
    nombre: op.nombre || op.usuario,
    usuario: op.usuario,
    rol: 'operario',
    dueno: op.dueno ? { nombre: op.dueno.nombre || null } : null,
  };
}

module.exports = {
  asegurarTablas, buscarOperario, olvidarOperario, olvidarTodos, usuarioSesion,
  nuevoCodigo, mostrarCodigo, normalizarCodigo, USUARIO_OK, normalizarUsuario,
};
