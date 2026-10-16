// controllers/superadminYapeController.js
// Entorno superadmin · Cobros Yape (celulares, pagos, reembolsos), incidencias y sincronización
// de ventas hacia Qhapay. Lee y actualiza el esquema "kymez" de la misma base de datos.
// Reemplaza las consultas que se hacían a mano en DBeaver.
const pool = require('../config/database');
const identidad = require('../services/identidadMaquina');
const kymez = require('../services/kymez');
const tiempo = require('../utils/tiempo');
const auditoria = require('../utils/auditoria');
// El Centro de control se recalcula apenas el superadmin cambia algo
const invalidarResumen = () => require('./superadminFlotaController').invalidarResumen();

function responderError(res, e, contexto) {
  if (e && e.status) return res.status(e.status).json({ success: false, message: e.message, ...(e.extra || {}) });
  console.error(`[superadmin] ${contexto}:`, e);
  return res.status(500).json({ success: false, message: `Error del servidor (${contexto}): ${e.message}` });
}
const sinKymez = (res) => res.status(503).json({ success: false, message: 'Esta base de datos no tiene las tablas de kymez-pagos.' });
const entero = (v, def, min, max) => Math.min(max, Math.max(min, parseInt(v, 10) || def));
const INICIO_HOY_TZ = `(date_trunc('day', now() AT TIME ZONE '${tiempo.ZONA}') AT TIME ZONE '${tiempo.ZONA}')`;
const KYMEZ_PAGOS_URL = String(process.env.KYMEZ_PAGOS_URL || 'https://kymez-pagos.onrender.com').replace(/\/$/, '');

// Columnas opcionales: devuelve "t.col" si existe, o "NULL::tipo AS col"
async function col(tabla, columna, tipo = 'text', alias = 't') {
  return (await kymez.tiene(tabla, columna)) ? `${alias}.${columna}` : `NULL::${tipo} AS ${columna}`;
}
// Nombre y código KMT de la máquina para unir con tablas kymez (alias m)
async function camposMaquina() {
  return `${await identidad.sqlNombre('m')} AS maquina_nombre,
          ${(await identidad.hayKMT()) ? 'm.codigo_kmt' : 'NULL::text'} AS maquina_codigo,
          (m.machine_id IS NOT NULL) AS maquina_existe`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Celulares de cobro (kymez.cuentas_cobro)
// ─────────────────────────────────────────────────────────────────────────────
const LATIDO_MAX_MIN = Number(process.env.CELULAR_LATIDO_MAX_MIN || 12);
function estadoCelular(c) {
  if (c.activa === false) return 'desactivado';
  if (!c.ultimo_latido) return 'sin_latido_configurado';
  return Date.now() - new Date(c.ultimo_latido).getTime() > LATIDO_MAX_MIN * 60000 ? 'sin_latido' : 'en_linea';
}

// GET /api/superadmin/cuentas-yape
const listarCuentas = async (req, res) => {
  try {
    if (!(await kymez.tiene('cuentas_cobro', 'id'))) return sinKymez(res);
    const pagosConCuenta = await kymez.tiene('pagos_yape', 'cuenta_cobro_id');
    const nombre = await identidad.sqlNombre('m');
    const kmt = (await identidad.hayKMT()) ? 'm.codigo_kmt' : 'NULL::text';
    const { rows } = await pool.query(`
      ${pagosConCuenta ? `WITH p AS (
        SELECT cuenta_cobro_id,
               count(*) FILTER (WHERE recibido_en >= ${INICIO_HOY_TZ} AND estado NOT IN ('duplicado_exacto', 'no_parseado'))::int AS pagos_hoy,
               COALESCE(sum(monto_cent) FILTER (WHERE recibido_en >= ${INICIO_HOY_TZ} AND estado = 'entregado'), 0)::int AS entregado_hoy_cent,
               max(recibido_en) AS ultimo_pago
        FROM kymez.pagos_yape WHERE recibido_en > now() - interval '30 days' AND cuenta_cobro_id IS NOT NULL
        GROUP BY 1)` : ''}
      SELECT t.id, ${await col('cuentas_cobro', 'descripcion')}, COALESCE(${await col('cuentas_cobro', 'activa', 'boolean')}, true) AS activa,
             ${await col('cuentas_cobro', 'ultimo_latido', 'timestamptz')}, ${await col('cuentas_cobro', 'ultima_notificacion', 'timestamptz')},
             ${(await kymez.tiene('cuentas_cobro', 'token_sha256')) ? '(t.token_sha256 IS NOT NULL)' : 'false'} AS tiene_token_propio,
             ${(await kymez.tiene('maquinas', 'cuenta_cobro_id')) ? `(
               SELECT COALESCE(json_agg(json_build_object('equipo_id', km.machine_id, 'nombre', ${nombre}, 'codigo_kmt', ${kmt},
                                                          'en_qhapay', m.machine_id IS NOT NULL, 'activa', COALESCE(km.activa, true))
                                        ORDER BY km.machine_id), '[]'::json)
               FROM kymez.maquinas km LEFT JOIN maquinas m ON m.machine_id = km.machine_id
               WHERE km.cuenta_cobro_id = t.id)` : `'[]'::json`} AS maquinas,
             ${pagosConCuenta ? 'COALESCE(p.pagos_hoy, 0)' : '0'} AS pagos_hoy,
             ${pagosConCuenta ? 'COALESCE(p.entregado_hoy_cent, 0)' : '0'} AS entregado_hoy_cent,
             ${pagosConCuenta ? 'p.ultimo_pago' : 'NULL::timestamptz AS ultimo_pago'}
      FROM kymez.cuentas_cobro t ${pagosConCuenta ? 'LEFT JOIN p ON p.cuenta_cobro_id = t.id' : ''}
      ORDER BY t.id`);
    res.json({
      success: true,
      latido_max_min: LATIDO_MAX_MIN,
      cuentas: rows.map((c) => ({ ...c, estado: estadoCelular(c), entregado_hoy: c.entregado_hoy_cent / 100,
        macrodroid: {
          notificacion: `${KYMEZ_PAGOS_URL}/api/yape/notificacion?telefono=${encodeURIComponent(c.id)}`,
          latido: `${KYMEZ_PAGOS_URL}/api/yape/latido?telefono=${encodeURIComponent(c.id)}`,
        } })),
    });
  } catch (e) { responderError(res, e, 'cuentas Yape'); }
};

// POST /api/superadmin/cuentas-yape { id?, descripcion }
const crearCuenta = async (req, res) => {
  invalidarResumen();
  try {
    if (!(await kymez.tiene('cuentas_cobro', 'id'))) return sinKymez(res);
    const descripcion = identidad.limpiar(req.body.descripcion);
    if (descripcion.length < 2 || descripcion.length > 60) return res.status(400).json({ success: false, message: 'Describe la cuenta (2 a 60 caracteres), ej. "Yape Nancy".' });
    let id = identidad.limpiar(req.body.id);
    if (!id) {
      // Siguiente "cel-N" libre
      const { rows } = await pool.query(`SELECT id FROM kymez.cuentas_cobro WHERE id ~ '^cel-[0-9]+$'`);
      const max = rows.reduce((m, r) => Math.max(m, Number(r.id.slice(4)) || 0), 0);
      id = `cel-${max + 1}`;
    }
    if (!kymez.ID_KYMEZ.test(id)) return res.status(400).json({ success: false, message: 'El ID solo puede tener letras, números, - y _ (ej. cel-4).' });
    const conDesc = await kymez.tiene('cuentas_cobro', 'descripcion');
    const r = await pool.query(
      `INSERT INTO kymez.cuentas_cobro (id${conDesc ? ', descripcion' : ''}) VALUES ($1${conDesc ? ', $2' : ''})
       ON CONFLICT (id) DO NOTHING RETURNING id`, conDesc ? [id, descripcion] : [id]);
    if (!r.rowCount) return res.status(409).json({ success: false, message: `Ya existe una cuenta con el ID ${id}.` });
    await auditoria.registrar({ usuario: req.superadmin.email, accion: 'cuenta_yape_creada', detalle: { id, descripcion } });
    res.status(201).json({ success: true, message: `Cuenta ${id} creada.`, id,
      macrodroid: {
        notificacion: `${KYMEZ_PAGOS_URL}/api/yape/notificacion?telefono=${encodeURIComponent(id)}`,
        latido: `${KYMEZ_PAGOS_URL}/api/yape/latido?telefono=${encodeURIComponent(id)}`,
      } });
  } catch (e) { responderError(res, e, 'crear cuenta Yape'); }
};

// PUT /api/superadmin/cuentas-yape/:id { descripcion?, activa? }
const editarCuenta = async (req, res) => {
  invalidarResumen();
  try {
    if (!(await kymez.tiene('cuentas_cobro', 'id'))) return sinKymez(res);
    const sets = [], vals = [];
    if (req.body.descripcion !== undefined && (await kymez.tiene('cuentas_cobro', 'descripcion'))) {
      const d = identidad.limpiar(req.body.descripcion);
      if (d.length < 2 || d.length > 60) return res.status(400).json({ success: false, message: 'La descripción debe tener entre 2 y 60 caracteres.' });
      vals.push(d); sets.push(`descripcion = $${vals.length}`);
    }
    if (req.body.activa !== undefined && (await kymez.tiene('cuentas_cobro', 'activa'))) {
      vals.push(req.body.activa !== false); sets.push(`activa = $${vals.length}`);
    }
    if (!sets.length) return res.status(400).json({ success: false, message: 'No llegó ningún cambio.' });
    vals.push(req.params.id);
    const antes = await pool.query('SELECT * FROM kymez.cuentas_cobro WHERE id = $1', [req.params.id]);
    if (!antes.rowCount) return res.status(404).json({ success: false, message: 'La cuenta no existe.' });
    await pool.query(`UPDATE kymez.cuentas_cobro SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    const a = antes.rows[0];
    await auditoria.registrar({ usuario: req.superadmin.email, accion: 'cuenta_yape_editada',
      detalle: { id: req.params.id, antes: { descripcion: a.descripcion, activa: a.activa },
                 despues: { descripcion: req.body.descripcion, activa: req.body.activa } } });
    res.json({ success: true, message: 'Cuenta actualizada.' });
  } catch (e) { responderError(res, e, 'editar cuenta Yape'); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Pagos Yape
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/superadmin/pagos-yape?grupo=por_reembolsar|todos&estado=&cuenta=&machine_id=&q=&dias=7&limite=200
const listarPagos = async (req, res) => {
  try {
    if (!(await kymez.tiene('pagos_yape', 'estado'))) return sinKymez(res);
    const dias = entero(req.query.dias, 7, 1, 120);
    const limite = entero(req.query.limite, 200, 1, 1000);
    const where = ['t.recibido_en > now() - make_interval(days => $1)'];
    const vals = [dias];
    if (req.query.grupo === 'por_reembolsar') { vals.push(kymez.POR_REEMBOLSAR); where.push(`t.estado = ANY($${vals.length})`); }
    if (req.query.estado) { vals.push(String(req.query.estado)); where.push(`t.estado = $${vals.length}`); }
    if (req.query.cuenta && (await kymez.tiene('pagos_yape', 'cuenta_cobro_id'))) { vals.push(String(req.query.cuenta)); where.push(`t.cuenta_cobro_id = $${vals.length}`); }
    if (req.query.machine_id) { vals.push(String(req.query.machine_id)); where.push(`t.machine_id = $${vals.length}`); }
    if (req.query.q) {
      const q = `%${String(req.query.q).trim()}%`;
      vals.push(q);
      where.push(`(t.pagador ILIKE $${vals.length} OR t.machine_id ILIKE $${vals.length} OR t.id::text = btrim($${vals.length}, '%'))`);
    }
    const base = `FROM kymez.pagos_yape t LEFT JOIN maquinas m ON m.machine_id = t.machine_id WHERE ${where.join(' AND ')}`;
    const lista = await pool.query(`
      SELECT t.id, t.recibido_en, t.estado, t.pagador, t.monto_cent, t.machine_id,
             ${await col('pagos_yape', 'entregado_en', 'timestamptz')}, ${await col('pagos_yape', 'cuenta_cobro_id')},
             ${await col('pagos_yape', 'via')}, ${await col('pagos_yape', 'intentos', 'int')}, ${await col('pagos_yape', 'telefono')},
             ${await col('pagos_yape', 'credito_cent', 'int')}, left(t.texto_crudo, 300) AS texto,
             ${await camposMaquina()}
      ${base} ORDER BY t.id DESC LIMIT ${limite}`, vals);
    const conteo = await pool.query(`
      SELECT t.estado, count(*)::int AS n, COALESCE(sum(t.monto_cent), 0)::int AS cent
      FROM kymez.pagos_yape t WHERE t.recibido_en > now() - make_interval(days => $1) GROUP BY 1 ORDER BY 2 DESC`, [dias]);
    res.json({
      success: true, dias,
      por_estado: conteo.rows.map((x) => ({ estado: x.estado, ...kymez.describirPago(x.estado), cantidad: x.n, monto: x.cent / 100,
        por_reembolsar: kymez.POR_REEMBOLSAR.includes(x.estado) })),
      pagos: lista.rows.map((p) => ({ ...p, monto: (p.monto_cent || 0) / 100, estado_texto: kymez.describirPago(p.estado).texto,
        estado_color: kymez.describirPago(p.estado).color, por_reembolsar: kymez.POR_REEMBOLSAR.includes(p.estado) })),
    });
  } catch (e) { responderError(res, e, 'pagos Yape'); }
};

// POST /api/superadmin/pagos-yape/:id/reembolsado { nota }
const marcarReembolsado = async (req, res) => {
  invalidarResumen();
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'Pago inválido.' });
  const nota = identidad.limpiar(req.body.nota).slice(0, 300);
  if (!(await kymez.tiene('pagos_yape', 'estado'))) return sinKymez(res);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`
      UPDATE kymez.pagos_yape t SET estado = 'reembolsado'
      FROM (SELECT id, estado AS antes FROM kymez.pagos_yape WHERE id = $1 FOR UPDATE) a
      WHERE t.id = a.id AND t.estado = ANY($2) RETURNING a.antes, t.machine_id, t.monto_cent, t.pagador`, [id, kymez.POR_REEMBOLSAR]);
    if (!r.rowCount) {
      await client.query('ROLLBACK');
      const e = await pool.query('SELECT estado FROM kymez.pagos_yape WHERE id = $1', [id]);
      return res.status(e.rowCount ? 409 : 404).json({ success: false,
        message: e.rowCount ? `Ese pago está "${kymez.describirPago(e.rows[0].estado).texto}": no se puede marcar como reembolsado.` : 'El pago no existe.' });
    }
    let resueltas = 0;
    if (await kymez.tiene('incidencias', 'pago_id')) {
      const sets = ['resuelta = true'];
      const vals = [id];
      if (await kymez.tiene('incidencias', 'resuelta_en')) sets.push('resuelta_en = now()');
      if (await kymez.tiene('incidencias', 'resolucion')) { vals.push(`Reembolsado (${req.superadmin.email})${nota ? ': ' + nota : ''}`); sets.push(`resolucion = $${vals.length}`); }
      const inc = await client.query(`UPDATE kymez.incidencias SET ${sets.join(', ')} WHERE pago_id = $1 AND NOT resuelta`, vals);
      resueltas = inc.rowCount;
    }
    await client.query('COMMIT');
    const p = r.rows[0];
    await auditoria.registrar({ usuario: req.superadmin.email, accion: 'pago_reembolsado', machine_id: p.machine_id,
      detalle: { pago_id: id, estado_anterior: p.antes, monto: (p.monto_cent || 0) / 100, pagador: p.pagador, nota, incidencias_resueltas: resueltas } });
    res.json({ success: true, message: `Pago ${id} marcado como reembolsado.`, incidencias_resueltas: resueltas });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    responderError(res, e, 'reembolso');
  } finally { client.release(); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Incidencias
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/superadmin/incidencias?estado=abiertas|resueltas|todas&tipo=&machine_id=&dias=30&limite=200
const listarIncidencias = async (req, res) => {
  try {
    if (!(await kymez.tiene('incidencias', 'resuelta'))) return sinKymez(res);
    const estado = ['abiertas', 'resueltas', 'todas'].includes(req.query.estado) ? req.query.estado : 'abiertas';
    const dias = entero(req.query.dias, 30, 1, 365);
    const limite = entero(req.query.limite, 200, 1, 1000);
    const where = [], vals = [];
    if (estado === 'abiertas') where.push('NOT t.resuelta');
    else {
      vals.push(dias); where.push(`t.creado_en > now() - make_interval(days => $${vals.length})`);
      if (estado === 'resueltas') where.push('t.resuelta');
    }
    if (req.query.tipo) { vals.push(String(req.query.tipo)); where.push(`t.tipo = $${vals.length}`); }
    if (req.query.machine_id) { vals.push(String(req.query.machine_id)); where.push(`t.machine_id = $${vals.length}`); }
    const lista = await pool.query(`
      SELECT t.id, t.machine_id, t.tipo, t.pago_id, t.monto_cent, t.datos, t.resuelta, t.creado_en,
             ${await col('incidencias', 'resuelta_en', 'timestamptz')}, ${await col('incidencias', 'resolucion')},
             ${await camposMaquina()}
      FROM kymez.incidencias t LEFT JOIN maquinas m ON m.machine_id = t.machine_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.resuelta, t.creado_en DESC LIMIT ${limite}`, vals);
    const abiertas = await pool.query(`
      SELECT tipo, count(*)::int AS n, max(creado_en) AS ultima FROM kymez.incidencias WHERE NOT resuelta GROUP BY 1 ORDER BY 2 DESC`);
    res.json({
      success: true,
      abiertas_por_tipo: abiertas.rows.map((x) => ({ tipo: x.tipo, ...kymez.describirIncidencia(x.tipo), cantidad: x.n, ultima: x.ultima })),
      total_abiertas: abiertas.rows.reduce((s, x) => s + x.n, 0),
      incidencias: lista.rows.map((x) => ({ ...x, monto: (x.monto_cent || 0) / 100, ...kymez.describirIncidencia(x.tipo) })),
    });
  } catch (e) { responderError(res, e, 'incidencias'); }
};

// POST /api/superadmin/incidencias/resolver { ids? | tipo?, machine_id?, antes_de?, resolucion }
const resolverIncidencias = async (req, res) => {
  invalidarResumen();
  try {
    if (!(await kymez.tiene('incidencias', 'resuelta'))) return sinKymez(res);
    const resolucion = identidad.limpiar(req.body.resolucion).slice(0, 300);
    if (resolucion.length < 3) return res.status(400).json({ success: false, message: 'Escribe qué se hizo (mínimo 3 caracteres).' });
    const where = ['NOT resuelta'], vals = [];
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map((x) => parseInt(x, 10)).filter(Number.isInteger) : [];
    if (ids.length) { vals.push(ids); where.push(`id = ANY($${vals.length}::bigint[])`); }
    else {
      let filtros = 0;
      if (req.body.tipo) { vals.push(String(req.body.tipo)); where.push(`tipo = $${vals.length}`); filtros++; }
      if (req.body.machine_id) { vals.push(String(req.body.machine_id)); where.push(`machine_id = $${vals.length}`); filtros++; }
      if (req.body.antes_de) {
        if (!/^\d{4}-\d{2}-\d{2}/.test(String(req.body.antes_de))) return res.status(400).json({ success: false, message: 'Fecha inválida (usa AAAA-MM-DD).' });
        vals.push(String(req.body.antes_de)); where.push(`creado_en < ($${vals.length}::date::timestamp AT TIME ZONE '${tiempo.ZONA}')`); filtros++;
      }
      if (!filtros) return res.status(400).json({ success: false, message: 'Elige qué incidencias resolver (por ID, tipo, máquina o fecha).' });
    }
    const sets = ['resuelta = true'];
    if (await kymez.tiene('incidencias', 'resuelta_en')) sets.push('resuelta_en = now()');
    if (await kymez.tiene('incidencias', 'resolucion')) { vals.push(`${resolucion} (${req.superadmin.email})`); sets.push(`resolucion = $${vals.length}`); }
    const r = await pool.query(`UPDATE kymez.incidencias SET ${sets.join(', ')} WHERE ${where.join(' AND ')} RETURNING id, machine_id`, vals);
    await auditoria.registrar({ usuario: req.superadmin.email, accion: 'incidencias_resueltas',
      machine_id: req.body.machine_id || null,
      detalle: { cantidad: r.rowCount, ids: r.rows.slice(0, 200).map((x) => Number(x.id)), filtro: ids.length ? 'ids' : { tipo: req.body.tipo, machine_id: req.body.machine_id, antes_de: req.body.antes_de }, resolucion } });
    res.json({ success: true, message: r.rowCount ? `${r.rowCount} incidencia(s) resuelta(s).` : 'No había incidencias abiertas con ese filtro.', resueltas: r.rowCount });
  } catch (e) { responderError(res, e, 'resolver incidencias'); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Sincronización de ventas Yape/efectivo (kymez.ventas -> historial_ventas de Qhapay)
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/superadmin/sincronizacion
const sincronizacion = async (req, res) => {
  try {
    if (!(await kymez.tiene('ventas', 'qhapay_estado'))) return sinKymez(res);
    const conteo = await pool.query(`
      SELECT qhapay_estado AS estado, count(*)::int AS n, min(creado_en) AS desde, max(creado_en) AS hasta
      FROM kymez.ventas
      WHERE qhapay_estado IN ('pendiente', 'error') OR (qhapay_estado = 'omitida' AND creado_en > now() - interval '30 days')
         OR (qhapay_estado = 'sincronizada' AND creado_en >= ${INICIO_HOY_TZ})
      GROUP BY 1`);
    const porMaquina = await pool.query(`
      SELECT t.machine_id, count(*)::int AS ventas, COALESCE(sum(t.precio_cent), 0)::int AS cent,
             min(t.creado_en) AS desde, max(t.creado_en) AS hasta,
             count(*) FILTER (WHERE t.qhapay_estado = 'omitida')::int AS omitidas,
             count(*) FILTER (WHERE t.qhapay_estado = 'error')::int AS con_error,
             count(*) FILTER (WHERE t.qhapay_estado = 'pendiente')::int AS pendientes,
             max(t.qhapay_error) AS ultimo_error,
             ${await camposMaquina()}
      FROM kymez.ventas t LEFT JOIN maquinas m ON m.machine_id = t.machine_id
      WHERE t.qhapay_estado IN ('pendiente', 'error') OR (t.qhapay_estado = 'omitida' AND t.creado_en > now() - interval '30 days')
      GROUP BY t.machine_id, m.machine_id ORDER BY 2 DESC LIMIT 200`);
    const ventas = await pool.query(`
      SELECT t.id, t.machine_id, t.slot, t.precio_cent, t.metodo, ${await col('ventas', 'fuente')}, t.creado_en,
             t.qhapay_estado, ${await col('ventas', 'qhapay_intentos', 'int')}, ${await col('ventas', 'qhapay_error')},
             (m.machine_id IS NOT NULL) AS maquina_existe
      FROM kymez.ventas t LEFT JOIN maquinas m ON m.machine_id = t.machine_id
      WHERE t.qhapay_estado IN ('pendiente', 'error') OR (t.qhapay_estado = 'omitida' AND t.creado_en > now() - interval '30 days')
      ORDER BY t.id DESC LIMIT 300`);
    const c = Object.fromEntries(conteo.rows.map((x) => [x.estado, x]));
    res.json({
      success: true,
      resumen: {
        pendientes: c.pendiente ? c.pendiente.n : 0,
        error: c.error ? c.error.n : 0,
        omitidas_30d: c.omitida ? c.omitida.n : 0,
        sincronizadas_hoy: c.sincronizada ? c.sincronizada.n : 0,
      },
      por_maquina: porMaquina.rows.map((x) => ({ ...x, monto: x.cent / 100,
        se_puede_reintentar: x.maquina_existe && (x.omitidas + x.con_error) > 0 })),
      ventas: ventas.rows.map((v) => ({ ...v, precio: (v.precio_cent || 0) / 100 })),
      nota: 'Al reintentar, kymez-pagos registra la venta en Qhapay. Con kymez-pagos v2.3 se guarda con la hora real de la venta; con v2.2, con la hora del reintento.',
    });
  } catch (e) { responderError(res, e, 'sincronización'); }
};

// POST /api/superadmin/sincronizacion/reintentar { ids?: number[], machine_id? }
const reintentarSincronizacion = async (req, res) => {
  invalidarResumen();
  try {
    if (!(await kymez.tiene('ventas', 'qhapay_estado'))) return sinKymez(res);
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map((x) => parseInt(x, 10)).filter(Number.isInteger) : [];
    const where = [`v.qhapay_estado IN ('omitida', 'error')`, 'EXISTS (SELECT 1 FROM maquinas m WHERE m.machine_id = v.machine_id)'];
    const vals = [];
    if (ids.length) { vals.push(ids); where.push(`v.id = ANY($${vals.length}::bigint[])`); }
    else if (req.body.machine_id) { vals.push(String(req.body.machine_id)); where.push(`v.machine_id = $${vals.length}`); }
    else return res.status(400).json({ success: false, message: 'Elige las ventas o la máquina a reintentar.' });
    const sets = [`qhapay_estado = 'pendiente'`];
    if (await kymez.tiene('ventas', 'qhapay_intentos')) sets.push('qhapay_intentos = 0');
    if (await kymez.tiene('ventas', 'qhapay_error')) sets.push('qhapay_error = NULL');
    const r = await pool.query(`UPDATE kymez.ventas v SET ${sets.join(', ')} WHERE ${where.join(' AND ')} RETURNING v.id, v.machine_id`, vals);
    await auditoria.registrar({ usuario: req.superadmin.email, accion: 'ventas_reintentadas', machine_id: req.body.machine_id || null,
      detalle: { cantidad: r.rowCount, ids: r.rows.slice(0, 200).map((x) => Number(x.id)) } });
    res.json({ success: true, reintentadas: r.rowCount,
      message: r.rowCount ? `${r.rowCount} venta(s) en cola: kymez-pagos las pasará a Qhapay en unos segundos.`
        : 'No hay ventas para reintentar (la máquina debe existir en Qhapay).' });
  } catch (e) { responderError(res, e, 'reintentar'); }
};

module.exports = {
  listarCuentas, crearCuenta, editarCuenta,
  listarPagos, marcarReembolsado,
  listarIncidencias, resolverIncidencias,
  sincronizacion, reintentarSincronizacion,
};
