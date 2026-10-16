// controllers/superadminCatalogoController.js
// Entorno superadmin · Regiones del código KMT, dueños y auditoría.
const pool = require('../config/database');
const identidad = require('../services/identidadMaquina');
const auditoria = require('../utils/auditoria');
const resumenVentas = require('../services/resumenVentas');
const tiempo = require('../utils/tiempo');
const { columnaExiste } = require('../utils/esquema');

function responderError(res, e, contexto) {
  if (e && e.status) return res.status(e.status).json({ success: false, message: e.message, ...(e.extra || {}) });
  if (e && e.code === '23505') return res.status(409).json({ success: false, message: 'Ya existe una región con ese número o ese nombre.' });
  console.error(`[superadmin] ${contexto}:`, e);
  return res.status(500).json({ success: false, message: `Error del servidor (${contexto}): ${e.message}` });
}
const sinMigracion = (res) => res.status(503).json({ success: false, message: 'La migración de regiones aún no corre. Espera unos segundos y recarga.' });

// ─────────────────────────────────────────────────────────────────────────────
//  Regiones (el número que va en el código: KMT-<región>-0003)
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/superadmin/regiones
const listarRegiones = async (req, res) => {
  try {
    if (!(await identidad.hayKMT())) return sinMigracion(res);
    const { rows } = await pool.query(`
      SELECT r.id, r.nombre, r.activa, r.creado_en,
             count(m.machine_id)::int AS maquinas,
             (COALESCE(max(m.numero_kmt), 0) + 1)::int AS siguiente_numero
      FROM regiones r LEFT JOIN maquinas m ON m.region_id = r.id
      GROUP BY r.id ORDER BY r.id`);
    res.json({
      success: true,
      prefijo: identidad.PREFIJO,
      empresa: identidad.EMPRESA,
      regiones: rows.map((r) => ({ ...r,
        ejemplo: identidad.formatearKMT(r.id, Math.min(r.siguiente_numero, identidad.NUMERO_MAX)),
        siguiente_codigo: identidad.formatearKMT(r.id, Math.min(r.siguiente_numero, identidad.NUMERO_MAX)),
        descripcion: identidad.describirKMT(r.nombre, Math.min(r.siguiente_numero, identidad.NUMERO_MAX)) })),
    });
  } catch (e) { responderError(res, e, 'regiones'); }
};

// POST /api/superadmin/regiones { id?, nombre }
const crearRegion = async (req, res) => {
  try {
    if (!(await identidad.hayKMT())) return sinMigracion(res);
    const nombre = identidad.limpiar(req.body.nombre);
    if (nombre.length < 2 || nombre.length > 40) return res.status(400).json({ success: false, message: 'El nombre debe tener entre 2 y 40 caracteres.' });
    let id = req.body.id === undefined || req.body.id === null || req.body.id === '' ? null : Number(req.body.id);
    if (id === null) id = Number((await pool.query('SELECT COALESCE(max(id), 0) + 1 AS n FROM regiones')).rows[0].n);
    if (!Number.isInteger(id) || id < 1 || id > 99) return res.status(400).json({ success: false, message: 'El número de región debe estar entre 1 y 99.' });
    const r = await pool.query(
      'INSERT INTO regiones (id, nombre) VALUES ($1, $2) RETURNING id, nombre, activa', [id, nombre]);
    await auditoria.registrar({ usuario: req.superadmin.email, accion: 'region_creada', detalle: r.rows[0] });
    res.status(201).json({ success: true, message: `Región ${id} · ${nombre} creada. Sus códigos serán ${identidad.formatearKMT(id, 1)}, ${identidad.formatearKMT(id, 2)}…`,
      region: r.rows[0] });
  } catch (e) { responderError(res, e, 'crear región'); }
};

// PUT /api/superadmin/regiones/:id { nombre?, activa? }
const editarRegion = async (req, res) => {
  try {
    if (!(await identidad.hayKMT())) return sinMigracion(res);
    const id = Number(req.params.id);
    const antes = await pool.query('SELECT id, nombre, activa FROM regiones WHERE id = $1', [id]);
    if (!antes.rowCount) return res.status(404).json({ success: false, message: 'La región no existe.' });
    const sets = [], vals = [];
    if (req.body.nombre !== undefined) {
      const n = identidad.limpiar(req.body.nombre);
      if (n.length < 2 || n.length > 40) return res.status(400).json({ success: false, message: 'El nombre debe tener entre 2 y 40 caracteres.' });
      vals.push(n); sets.push(`nombre = $${vals.length}`);
    }
    if (req.body.activa !== undefined) { vals.push(req.body.activa !== false); sets.push(`activa = $${vals.length}`); }
    if (!sets.length) return res.status(400).json({ success: false, message: 'No llegó ningún cambio.' });
    vals.push(id);
    const r = await pool.query(`UPDATE regiones SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id, nombre, activa`, vals);
    await auditoria.registrar({ usuario: req.superadmin.email, accion: 'region_editada', detalle: { antes: antes.rows[0], despues: r.rows[0] } });
    res.json({ success: true, message: 'Región actualizada. Los códigos KMT no cambian (usan el número de la región).', region: r.rows[0] });
  } catch (e) { responderError(res, e, 'editar región'); }
};

// DELETE /api/superadmin/regiones/:id  (solo si no tiene máquinas)
const eliminarRegion = async (req, res) => {
  try {
    if (!(await identidad.hayKMT())) return sinMigracion(res);
    const id = Number(req.params.id);
    const usadas = await pool.query('SELECT count(*)::int AS n FROM maquinas WHERE region_id = $1', [id]);
    if (usadas.rows[0].n > 0) {
      return res.status(409).json({ success: false, message: `La región tiene ${usadas.rows[0].n} máquina(s). Desactívala en lugar de eliminarla.` });
    }
    const r = await pool.query('DELETE FROM regiones WHERE id = $1 RETURNING id, nombre', [id]);
    if (!r.rowCount) return res.status(404).json({ success: false, message: 'La región no existe.' });
    await auditoria.registrar({ usuario: req.superadmin.email, accion: 'region_eliminada', detalle: r.rows[0] });
    res.json({ success: true, message: `Región ${r.rows[0].nombre} eliminada.` });
  } catch (e) { responderError(res, e, 'eliminar región'); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Dueños (clientes de Qhapay)
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/superadmin/duenos
const listarDuenos = async (req, res) => {
  try {
    const conResumen = resumenVentas.disponible();
    const { rows } = await pool.query(`
      SELECT u.id, u.nombre, u.email, COALESCE(lower(u.rol), 'dueno') AS rol,
             count(m.machine_id)::int AS maquinas,
             count(m.machine_id) FILTER (WHERE lower(COALESCE(m.pago_al_dia::text, 'true')) IN ('false', 'f', '0', 'no'))::int AS bloqueadas,
             ${conResumen ? `COALESCE((SELECT sum(v.monto) FROM ventas_mes_maquina v JOIN maquinas mm ON mm.machine_id = v.machine_id
                                       WHERE mm.id_dueno::text = u.id::text AND v.mes = date_trunc('month', ${tiempo.HOY})::date), 0)::float`
                          : 'NULL::float'} AS ventas_mes
      FROM usuarios_duenos u LEFT JOIN maquinas m ON m.id_dueno::text = u.id::text
      GROUP BY u.id ORDER BY count(m.machine_id) DESC, u.nombre`);
    res.json({ success: true, duenos: rows });
  } catch (e) { responderError(res, e, 'dueños'); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Auditoría
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/superadmin/auditoria?machine_id=&accion=&limite=200
const listarAuditoria = async (req, res) => {
  try {
    if (!(await columnaExiste('auditoria_superadmin', 'accion'))) return sinMigracion(res);
    const limite = Math.min(1000, Math.max(1, parseInt(req.query.limite, 10) || 200));
    const where = [], vals = [];
    if (req.query.machine_id) { vals.push(String(req.query.machine_id)); where.push(`a.machine_id = $${vals.length}`); }
    if (req.query.accion) { vals.push(String(req.query.accion)); where.push(`a.accion = $${vals.length}`); }
    const { rows } = await pool.query(`
      SELECT a.id, a.usuario, a.accion, a.machine_id, a.detalle, a.creado_en,
             ${await identidad.sqlNombre('m')} AS maquina_nombre,
             ${(await identidad.hayKMT()) ? 'm.codigo_kmt' : 'NULL::text'} AS maquina_codigo
      FROM auditoria_superadmin a LEFT JOIN maquinas m ON m.machine_id = a.machine_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY a.creado_en DESC LIMIT ${limite}`, vals);
    res.json({ success: true, registros: rows.map((x) => ({ ...x, accion_texto: auditoria.ACCIONES[x.accion] || x.accion })) });
  } catch (e) { responderError(res, e, 'auditoría'); }
};

module.exports = { listarRegiones, crearRegion, editarRegion, eliminarRegion, listarDuenos, listarAuditoria };
