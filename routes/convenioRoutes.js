// routes/convenioRoutes.js
// ============================================================================
//  QhaPay · Convenios de subsidio y ventas de prueba
// ----------------------------------------------------------------------------
//  1) PRECIOS REGULARES por máquina (convenio: el colaborador paga lo que cobra la
//     máquina y la empresa cliente asume la diferencia hasta el precio regular).
//       GET /api/convenio/:machine_id/precios
//       PUT /api/convenio/:machine_id/precios   { items: [{ codigo_motor, precio_regular }] }
//           precio_regular vacío o null = ese producto sin precio regular (se borra)
//
//  2) VENTAS DE PRUEBA (Yapes de demostración que no deben contar en los reportes)
//       PATCH /api/convenio/ventas/prueba        { ids: [123, 124], es_prueba: true }
//     La lista de ventas (/api/ventas) ya devuelve la columna es_prueba (usa v.*).
//
//  Seguridad: TODAS las rutas exigen la sesión (Authorization: Bearer <token>) y solo
//  dejan tocar máquinas del dueño de esa sesión (el superadmin puede todas).
//
//  En app.js:  app.use('/api/convenio', require('./routes/convenioRoutes'));
// ============================================================================
const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const { usuarioPorEmail } = require('../utils/usuarios');
const { ROLES_SUPERADMIN, MENSAJES } = require('../utils/auth');
const { columnaExiste } = require('../utils/esquema');

const router = express.Router();
const SECRETO = process.env.JWT_SECRET || null;

// ---------- Esquema (se crea solo la primera vez; no borra ni cambia datos) ----------
let esquemaListo = false;
async function asegurarEsquema() {
  if (esquemaListo) return;
  if (!(await columnaExiste('historial_ventas', 'es_prueba'))) {
    await pool.query(`ALTER TABLE historial_ventas ADD COLUMN IF NOT EXISTS es_prueba BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE historial_ventas ADD COLUMN IF NOT EXISTS prueba_marcada_por VARCHAR(100)`);
    await pool.query(`ALTER TABLE historial_ventas ADD COLUMN IF NOT EXISTS prueba_marcada_en TIMESTAMP`);
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS precios_regulares (
      machine_id      VARCHAR(50)   NOT NULL,
      codigo_motor    VARCHAR(10)   NOT NULL,
      precio_regular  NUMERIC(10,2) NOT NULL CHECK (precio_regular > 0),
      actualizado_por VARCHAR(100),
      actualizado_en  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (machine_id, codigo_motor)
    )`);
  esquemaListo = true;
}

// ---------- Sesión y permisos ----------
async function sesion(req) {
  if (!SECRETO) return { status: 503, message: MENSAJES.sin_configurar };
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.get('authorization') || '').trim());
  if (!m) return { status: 401, message: MENSAJES.sin_token };
  let datos;
  try {
    datos = jwt.verify(m[1], SECRETO, { algorithms: ['HS256'] });
  } catch (e) {
    return { status: 401, message: e && e.name === 'TokenExpiredError' ? MENSAJES.vencido : MENSAJES.invalido };
  }
  const email = String((datos && datos.email) || '').trim().toLowerCase();
  const u = email ? await usuarioPorEmail(email) : null;
  if (!u) return { status: 401, message: MENSAJES.invalido };
  return { email, id: u.id, superadmin: ROLES_SUPERADMIN.has(u.rol) };
}

// Máquinas (de la lista) que esta sesión puede tocar
async function maquinasPermitidas(usr, machineIds) {
  if (!machineIds.length) return new Set();
  if (usr.superadmin) {
    const r = await pool.query('SELECT machine_id FROM maquinas WHERE machine_id = ANY($1)', [machineIds]);
    return new Set(r.rows.map((x) => x.machine_id));
  }
  const r = await pool.query(
    `SELECT m.machine_id FROM maquinas m
       JOIN usuarios_duenos u ON m.id_dueno::text = u.id::text
      WHERE m.machine_id = ANY($1) AND lower(u.email) = $2`, [machineIds, usr.email]);
  return new Set(r.rows.map((x) => x.machine_id));
}

// Envuelve cada ruta: esquema + sesión + errores
const ruta = (fn) => async (req, res) => {
  try {
    await asegurarEsquema();
    const usr = await sesion(req);
    if (usr.status) return res.status(usr.status).json({ success: false, message: usr.message });
    await fn(req, res, usr);
  } catch (e) {
    console.error('[convenio]', e.message);
    res.status(500).json({ success: false, message: 'Error del servidor' });
  }
};

const machineValido = (id) => typeof id === 'string' && /^[A-Za-z0-9:_\-.]{1,50}$/.test(id);

// ---------- 1) Precios regulares ----------
router.get('/:machine_id/precios', ruta(async (req, res, usr) => {
  const id = req.params.machine_id;
  if (!machineValido(id)) return res.status(400).json({ success: false, message: 'Máquina no válida' });
  if (!(await maquinasPermitidas(usr, [id])).has(id)) {
    return res.status(403).json({ success: false, message: 'No tienes acceso a esta máquina' });
  }
  // Todas las selecciones del planograma, con su precio regular si ya tiene
  const r = await pool.query(
    `SELECT i.codigo_motor, i.nombre_producto, i.precio AS precio_maquina, pr.precio_regular, pr.actualizado_en
       FROM inventario i
       LEFT JOIN precios_regulares pr ON pr.machine_id = i.machine_id AND pr.codigo_motor = i.codigo_motor
      WHERE i.machine_id = $1
      ORDER BY CASE WHEN i.codigo_motor ~ '^[0-9]+$' THEN i.codigo_motor::int ELSE 999999 END, i.codigo_motor`, [id]);
  const items = r.rows.map((x) => ({
    codigo_motor: x.codigo_motor,
    nombre_producto: x.nombre_producto,
    precio_maquina: x.precio_maquina === null ? null : Number(x.precio_maquina),
    precio_regular: x.precio_regular === null ? null : Number(x.precio_regular),
    actualizado_en: x.actualizado_en,
  }));
  res.json({ machine_id: id, convenio_activo: items.some((x) => x.precio_regular !== null), items });
}));

router.put('/:machine_id/precios', ruta(async (req, res, usr) => {
  const id = req.params.machine_id;
  if (!machineValido(id)) return res.status(400).json({ success: false, message: 'Máquina no válida' });
  if (!(await maquinasPermitidas(usr, [id])).has(id)) {
    return res.status(403).json({ success: false, message: 'No tienes acceso a esta máquina' });
  }
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : null;
  if (!items || items.length > 300) return res.status(400).json({ success: false, message: 'Lista de precios no válida' });

  const guardar = [], borrar = [];
  for (const it of items) {
    const motor = String((it && it.codigo_motor) ?? '').trim();
    if (!motor || motor.length > 10) return res.status(400).json({ success: false, message: 'Selección no válida' });
    const v = it.precio_regular;
    if (v === null || v === undefined || v === '') { borrar.push(motor); continue; }
    const p = Math.round(Number(v) * 100) / 100;
    if (!Number.isFinite(p) || p <= 0 || p > 1000) {
      return res.status(400).json({ success: false, message: `Precio no válido en la selección ${motor}` });
    }
    guardar.push([motor, p]);
  }

  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    for (const [motor, p] of guardar) {
      await cli.query(
        `INSERT INTO precios_regulares (machine_id, codigo_motor, precio_regular, actualizado_por, actualizado_en)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (machine_id, codigo_motor) DO UPDATE
           SET precio_regular = EXCLUDED.precio_regular, actualizado_por = EXCLUDED.actualizado_por, actualizado_en = now()`,
        [id, motor, p, usr.email]);
    }
    if (borrar.length) {
      await cli.query('DELETE FROM precios_regulares WHERE machine_id = $1 AND codigo_motor = ANY($2)', [id, borrar]);
    }
    await cli.query('COMMIT');
  } catch (e) {
    await cli.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cli.release();
  }
  res.json({ success: true, message: 'Precios regulares guardados', guardados: guardar.length, quitados: borrar.length });
}));

// ---------- 2) Ventas de prueba ----------
router.patch('/ventas/prueba', ruta(async (req, res, usr) => {
  const b = req.body || {};
  const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map((x) => parseInt(x, 10)).filter((x) => x > 0))] : [];
  if (!ids.length || ids.length > 500) return res.status(400).json({ success: false, message: 'Elige entre 1 y 500 ventas' });
  if (typeof b.es_prueba !== 'boolean') return res.status(400).json({ success: false, message: 'Falta es_prueba (true o false)' });

  const v = await pool.query('SELECT id, machine_id FROM historial_ventas WHERE id = ANY($1)', [ids]);
  if (v.rowCount !== ids.length) return res.status(404).json({ success: false, message: 'Alguna venta no existe' });
  const permitidas = await maquinasPermitidas(usr, [...new Set(v.rows.map((x) => x.machine_id))]);
  if (v.rows.some((x) => !permitidas.has(x.machine_id))) {
    return res.status(403).json({ success: false, message: 'Alguna venta es de una máquina que no es tuya' });
  }
  const r = await pool.query(
    `UPDATE historial_ventas
        SET es_prueba = $2,
            prueba_marcada_por = CASE WHEN $2 THEN $3 ELSE NULL END,
            prueba_marcada_en  = CASE WHEN $2 THEN now() ELSE NULL END
      WHERE id = ANY($1)
      RETURNING id, es_prueba`, [ids, b.es_prueba, usr.email]);
  res.json({ success: true, message: b.es_prueba ? 'Marcadas como prueba' : 'Ya no son de prueba', actualizadas: r.rowCount, ventas: r.rows });
}));

module.exports = router;