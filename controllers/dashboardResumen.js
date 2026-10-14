// controllers/dashboardResumen.js
// GET /api/dashboard/resumen?email=...&tz=America/Lima&umbral=5
// Todo lo que muestra el Inicio de Qhapay en UNA respuesta pequeña, calculado en la BD.
// Antes el navegador descargaba TODO el historial de ventas y sumaba él mismo.
const pool = require('../config/database');
const { usuarioPorEmail } = require('../utils/usuarios');
const resumenVentas = require('../services/resumenVentas');

const cacheResumen = new Map();   // clave -> { cuerpo, vence }

const ALERTAS = `
  'alertas', (
    SELECT COALESCE(json_agg(z ORDER BY z.stock, z.maquina), '[]'::json) FROM (
      SELECT i.machine_id, m.name AS maquina, i.codigo_motor, i.nombre_producto AS producto,
             i.stock, i.capacidad,
             CASE WHEN i.stock <= 0 THEN 'agotado' WHEN i.stock <= 2 THEN 'critico' ELSE 'bajo' END AS nivel
      FROM inventario i JOIN mis m ON m.machine_id = i.machine_id
      WHERE COALESCE(i.nombre_producto, '') <> '' AND COALESCE(i.stock, 0) <= $4
      ORDER BY i.stock LIMIT 100) z),
  'maquinas', (
    SELECT json_build_object(
      'total', COUNT(*),
      'activas', COUNT(*) FILTER (WHERE COALESCE(lower(pago_al_dia::text), '') NOT IN ('false', 'f', '0', 'no')),
      'monedas', COALESCE(SUM(NULLIF(coin_current::text, '')::numeric), 0))
    FROM mis)`;

const MIS = `
  mis AS (
    SELECT machine_id, COALESCE(name, machine_id) AS name, id_dueno, pago_al_dia, coin_current
    FROM maquinas WHERE $1::boolean OR id_dueno::text = $2::text
  )`;

// Versión rápida: lee las tablas de totales por día (services/resumenVentas.js).
// Con 1000 máquinas y un año de ventas responde en milisegundos.
const SQL_RAPIDO = `
  WITH ${MIS},
  lim AS (
    SELECT d, date_trunc('week', d)::date AS sem, date_trunc('month', d)::date AS mes, date_trunc('year', d)::date AS anio
    FROM (SELECT (now() AT TIME ZONE $3)::date AS d) x
  ),
  -- por producto y día del dueño: a lo más 365 x productos filas
  vp_raw AS (
    SELECT v.dia, v.producto, v.id_dueno, v.unidades, v.monto
    FROM ventas_dia_producto v, lim
    WHERE ($1::boolean OR v.id_dueno = $2::text) AND v.dia >= LEAST(lim.anio, lim.d - 13)
  ),
  por_dia AS (SELECT dia, SUM(unidades) AS u, SUM(monto) AS t FROM vp_raw GROUP BY dia),
  vp AS (
    SELECT producto, id_dueno, SUM(unidades) AS u, SUM(monto) AS t
    FROM vp_raw, lim WHERE vp_raw.dia >= lim.anio GROUP BY 1, 2
  ),
  costo AS (
    SELECT vp.*, COALESCE((
      SELECT pa.unit_cost FROM productos_almacen pa
      WHERE pa.name = vp.producto AND (vp.id_dueno = '' OR pa.id_dueno::text = vp.id_dueno)
      ORDER BY pa.id DESC LIMIT 1), 0) AS c
    FROM vp
  )
  SELECT json_build_object(
    'totales', (
      SELECT json_build_object(
        'hoy',    COALESCE(SUM(t) FILTER (WHERE dia >= l.d), 0),
        'semana', COALESCE(SUM(t) FILTER (WHERE dia >= l.sem), 0),
        'mes',    COALESCE(SUM(t) FILTER (WHERE dia >= l.mes), 0),
        'anio',   COALESCE(SUM(t) FILTER (WHERE dia >= l.anio), 0),
        'ganancia_anio', (SELECT COALESCE(SUM(t - u * c), 0) FROM costo),
        'ventas_hoy',  COALESCE(SUM(u) FILTER (WHERE dia >= l.d), 0),
        'ventas_anio', COALESCE(SUM(u) FILTER (WHERE dia >= l.anio), 0))
      FROM lim l LEFT JOIN por_dia ON true),
    'diario', (
      SELECT json_agg(json_build_object('dia', to_char(g.dia, 'YYYY-MM-DD'), 'total', COALESCE(x.t, 0)) ORDER BY g.dia)
      FROM (SELECT generate_series(l.d - 13, l.d, interval '1 day')::date AS dia FROM lim l) g
      LEFT JOIN por_dia x ON x.dia = g.dia),
    'por_maquina', (
      SELECT COALESCE(json_agg(z ORDER BY z.total DESC), '[]'::json) FROM (
        SELECT v.machine_id, m.name AS nombre, SUM(v.monto) AS total, SUM(v.unidades) AS ventas
        FROM ventas_mes_maquina v JOIN mis m ON m.machine_id = v.machine_id, lim
        WHERE v.mes >= lim.anio
        GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 50) z),
    'top_productos', (
      SELECT COALESCE(json_agg(z ORDER BY z.unidades DESC, z.total DESC), '[]'::json) FROM (
        SELECT producto AS nombre, SUM(u) AS unidades, SUM(t) AS total
        FROM vp GROUP BY 1 ORDER BY 2 DESC, 3 DESC LIMIT 10) z),
    ${ALERTAS}
  ) AS r`;

const ZONA_VALIDA = /^[A-Za-z][A-Za-z0-9_+\-/]{0,40}$/;

// Si historial_ventas.fecha NO tiene zona horaria, DEFAULT now() guarda la hora en la zona de
// la BD (en Render: UTC). Se detecta sola; VENTAS_FECHA_ZONA la fuerza si hiciera falta.
let esquemaFecha = null;
async function zonaFechas() {
  if (esquemaFecha) return esquemaFecha;
  const r = await pool.query(
    `SELECT (SELECT data_type FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'historial_ventas' AND column_name = 'fecha') AS tipo,
            current_setting('TimeZone') AS zona_bd`);
  const forzada = process.env.VENTAS_FECHA_ZONA;
  esquemaFecha = {
    conZona: (r.rows[0].tipo || 'timestamp with time zone') === 'timestamp with time zone',
    zonaBD: forzada && ZONA_VALIDA.test(forzada) ? forzada : r.rows[0].zona_bd || 'UTC',
  };
  return esquemaFecha;
}

const obtenerResumen = async (req, res) => {
  try {
    const email = req.query.email || req.query.user || req.query.user_id;
    const u = email ? await usuarioPorEmail(email) : null;
    if (!u) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });

    const tz = ZONA_VALIDA.test(req.query.tz || '') ? req.query.tz : 'America/Lima';
    const umbral = Math.max(0, parseInt(req.query.umbral, 10) || 5);
    if (resumenVentas.disponible()) {
      // Si varias personas/celulares del mismo dueño abren Inicio a la vez, se calcula una sola vez cada 15 s
      const clave = `${u.id}|${u.rol}|${umbral}`;
      const hit = cacheResumen.get(clave);
      if (hit && hit.vence > Date.now()) {
        res.set('Cache-Control', 'private, max-age=15');
        return res.json(hit.cuerpo);
      }
      const { rows } = await pool.query(SQL_RAPIDO, [u.rol === 'superadmin', String(u.id), resumenVentas.ZONA, umbral]);
      const cuerpo = { success: true, zona_horaria: resumenVentas.ZONA, generado_en: new Date().toISOString(), ...rows[0].r };
      cacheResumen.set(clave, { cuerpo, vence: Date.now() + 15000 });
      if (cacheResumen.size > 2000) cacheResumen.clear();
      res.set('Cache-Control', 'private, max-age=15');
      return res.json(cuerpo);
    }

    // Respaldo (si las tablas de totales aún no existen): suma directa de historial_ventas
    const { conZona, zonaBD } = await zonaFechas();

    // fecha de la BD -> hora local del negocio, y al revés (para usar el índice)
    const aLocal = conZona ? '(v.fecha AT TIME ZONE $3)' : '((v.fecha AT TIME ZONE $5) AT TIME ZONE $3)';
    const aBD = (x) => (conZona ? `((${x}) AT TIME ZONE $3)` : `(((${x}) AT TIME ZONE $3) AT TIME ZONE $5)`);

    const sql = `
      WITH mis AS (
        SELECT machine_id, COALESCE(name, machine_id) AS name, id_dueno, pago_al_dia, coin_current
        FROM maquinas WHERE $1::boolean OR id_dueno::text = $2::text
      ),
      lim AS (SELECT (now() AT TIME ZONE $3) AS ahora),
      ventas AS (
        SELECT ${aLocal} AS f,
               COALESCE(NULLIF(v.precio::text, '')::numeric, 0) AS monto,
               COALESCE(p.unit_cost, 0) AS costo,
               v.machine_id, m.name AS maquina,
               COALESCE(NULLIF(v.nombre_producto, ''), 'Venta libre') AS producto
        FROM historial_ventas v
        JOIN mis m ON m.machine_id = v.machine_id
        LEFT JOIN LATERAL (
          SELECT pa.unit_cost FROM productos_almacen pa
          WHERE pa.name = v.nombre_producto AND (m.id_dueno IS NULL OR pa.id_dueno::text = m.id_dueno::text)
          ORDER BY pa.id DESC LIMIT 1
        ) p ON true
        WHERE v.fecha >= ${aBD("LEAST(date_trunc('year', (SELECT ahora FROM lim)), date_trunc('day', (SELECT ahora FROM lim)) - interval '13 days')")}
      )
      SELECT json_build_object(
        'totales', (
          SELECT json_build_object(
            'hoy',    COALESCE(SUM(monto) FILTER (WHERE f >= date_trunc('day',   l.ahora)), 0),
            'semana', COALESCE(SUM(monto) FILTER (WHERE f >= date_trunc('week',  l.ahora)), 0),
            'mes',    COALESCE(SUM(monto) FILTER (WHERE f >= date_trunc('month', l.ahora)), 0),
            'anio',   COALESCE(SUM(monto) FILTER (WHERE f >= date_trunc('year',  l.ahora)), 0),
            'ganancia_anio', COALESCE(SUM(monto - costo) FILTER (WHERE f >= date_trunc('year', l.ahora)), 0),
            'ventas_hoy',  COUNT(*) FILTER (WHERE f >= date_trunc('day',  l.ahora)),
            'ventas_anio', COUNT(*) FILTER (WHERE f >= date_trunc('year', l.ahora)))
          FROM lim l LEFT JOIN ventas ON true),
        'diario', (
          SELECT json_agg(json_build_object('dia', to_char(d.dia, 'YYYY-MM-DD'), 'total', COALESCE(x.total, 0)) ORDER BY d.dia)
          FROM (SELECT gs::date AS dia FROM lim,
                  generate_series(date_trunc('day', ahora) - interval '13 days', date_trunc('day', ahora), interval '1 day') gs) d
          LEFT JOIN (SELECT f::date AS dia, SUM(monto) AS total FROM ventas GROUP BY 1) x ON x.dia = d.dia),
        'por_maquina', (
          SELECT COALESCE(json_agg(z ORDER BY z.total DESC), '[]'::json) FROM (
            SELECT machine_id, maquina AS nombre, SUM(monto) AS total, COUNT(*) AS ventas
            FROM ventas, lim WHERE f >= date_trunc('year', ahora) GROUP BY 1, 2) z),
        'top_productos', (
          SELECT COALESCE(json_agg(z ORDER BY z.unidades DESC, z.total DESC), '[]'::json) FROM (
            SELECT producto AS nombre, COUNT(*) AS unidades, SUM(monto) AS total
            FROM ventas, lim WHERE f >= date_trunc('year', ahora)
            GROUP BY 1 ORDER BY 2 DESC, 3 DESC LIMIT 10) z),
        'alertas', (
          SELECT COALESCE(json_agg(z ORDER BY z.stock, z.maquina), '[]'::json) FROM (
            SELECT i.machine_id, m.name AS maquina, i.codigo_motor, i.nombre_producto AS producto,
                   i.stock, i.capacidad,
                   CASE WHEN i.stock <= 0 THEN 'agotado' WHEN i.stock <= 2 THEN 'critico' ELSE 'bajo' END AS nivel
            FROM inventario i JOIN mis m ON m.machine_id = i.machine_id
            WHERE COALESCE(i.nombre_producto, '') <> '' AND COALESCE(i.stock, 0) <= $4
            LIMIT 100) z),
        'maquinas', (
          SELECT json_build_object(
            'total', COUNT(*),
            'activas', COUNT(*) FILTER (WHERE COALESCE(lower(pago_al_dia::text), '') NOT IN ('false', 'f', '0', 'no')),
            'monedas', COALESCE(SUM(NULLIF(coin_current::text, '')::numeric), 0))
          FROM mis)
      ) AS r`;

    const { rows } = await pool.query(sql, [u.rol === 'superadmin', String(u.id), tz, umbral, ...(conZona ? [] : [zonaBD])]);
    res.set('Cache-Control', 'private, max-age=15');
    res.json({ success: true, zona_horaria: tz, generado_en: new Date().toISOString(), ...rows[0].r });
  } catch (error) {
    console.error('Error en resumen del dashboard:', error);
    res.status(500).json({ success: false, message: 'Error del servidor' });
  }
};

module.exports = { obtenerResumen };
