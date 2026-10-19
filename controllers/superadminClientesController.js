// controllers/superadminClientesController.js
// Entorno superadmin · Clientes: mensualidad, suspensión por falta de pago y "entrar como cliente"
// (soporte). La suspensión usa el candado que la app ya entiende (maquinas.pago_al_dia = false):
// el cliente ve "Servicio suspendido", pero la máquina SIGUE VENDIENDO y registrando sus ventas,
// así que al reactivarla no se pierde nada.
const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const identidad = require('../services/identidadMaquina');
const auditoria = require('../utils/auditoria');
const resumenVentas = require('../services/resumenVentas');
const tiempo = require('../utils/tiempo');
const { columnaExiste } = require('../utils/esquema');
const { ROLES_SUPERADMIN } = require('../utils/auth');

const invalidarResumen = () => require('./superadminFlotaController').invalidarResumen();
function responderError(res, e, contexto) {
  if (e && e.status) return res.status(e.status).json({ success: false, message: e.message });
  console.error(`[superadmin] ${contexto}:`, e);
  return res.status(500).json({ success: false, message: `Error del servidor (${contexto}): ${e.message}` });
}
const SUSPENDIDA = `lower(COALESCE(m.pago_al_dia::text, 'true')) IN ('false', 'f', '0', 'no')`;
const MENSAJE_DEFECTO = 'Servicio suspendido por falta de pago. Comunícate con Kymez Servitech para reactivarlo.';
const DIAS_AVISO = 5;

async function hayClientes() {
  return (await columnaExiste('usuarios_duenos', 'pagado_hasta')) && (await columnaExiste('maquinas', 'mensaje_bloqueo'));
}
const sinMigracion = (res) => res.status(503).json({ success: false, message: 'La migración de clientes aún no corre. Espera unos segundos y recarga.' });

function estadoPago(c) {
  if (c.pagado_hasta == null) return { estado: 'sin_plan', dias: null };
  const hoy = new Date(new Date().toLocaleString('en-US', { timeZone: tiempo.ZONA }));
  hoy.setHours(0, 0, 0, 0);
  const hasta = new Date(`${String(c.pagado_hasta).slice(0, 10)}T00:00:00`);
  const dias = Math.round((hasta - hoy) / 86400000);
  return { estado: dias < 0 ? 'vencido' : dias <= DIAS_AVISO ? 'por_vencer' : 'al_dia', dias };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/superadmin/clientes
const listarClientes = async (req, res) => {
  try {
    const nuevas = await hayClientes();
    const conResumen = resumenVentas.disponible();
    const { rows } = await pool.query(`
      SELECT u.id, u.nombre, u.email, COALESCE(lower(u.rol), 'dueno') AS rol,
             ${nuevas ? 'u.mensualidad::float AS mensualidad, to_char(u.pagado_hasta, \'YYYY-MM-DD\') AS pagado_hasta,' : 'NULL::float AS mensualidad, NULL::text AS pagado_hasta,'}
             count(m.machine_id)::int AS maquinas,
             count(m.machine_id) FILTER (WHERE ${SUSPENDIDA})::int AS suspendidas,
             ${conResumen ? `COALESCE((SELECT sum(v.monto) FROM ventas_dia_maquina v JOIN maquinas mm ON mm.machine_id = v.machine_id
                                       WHERE mm.id_dueno::text = u.id::text AND v.dia = ${tiempo.HOY}), 0)::float AS ventas_hoy,
                             COALESCE((SELECT sum(v.monto) FROM ventas_mes_maquina v JOIN maquinas mm ON mm.machine_id = v.machine_id
                                       WHERE mm.id_dueno::text = u.id::text AND v.mes = date_trunc('month', ${tiempo.HOY})::date), 0)::float AS ventas_mes`
                          : 'NULL::float AS ventas_hoy, NULL::float AS ventas_mes'}
      FROM usuarios_duenos u LEFT JOIN maquinas m ON m.id_dueno::text = u.id::text
      GROUP BY u.id ORDER BY count(m.machine_id) DESC, u.nombre`);
    const clientes = rows.map((c) => {
      const p = estadoPago(c);
      return { ...c, es_superadmin: ROLES_SUPERADMIN.has(c.rol), estado_pago: p.estado, dias_para_vencer: p.dias,
        estado_servicio: c.maquinas === 0 ? 'sin_maquinas' : c.suspendidas === 0 ? 'activo' : c.suspendidas === c.maquinas ? 'suspendido' : 'parcial' };
    });
    const resumen = {
      clientes: clientes.filter((c) => !c.es_superadmin).length,
      al_dia: clientes.filter((c) => c.estado_pago === 'al_dia').length,
      por_vencer: clientes.filter((c) => c.estado_pago === 'por_vencer').length,
      vencidos: clientes.filter((c) => c.estado_pago === 'vencido').length,
      suspendidos: clientes.filter((c) => c.estado_servicio === 'suspendido' || c.estado_servicio === 'parcial').length,
      mensualidades_mes: clientes.reduce((s, c) => s + (c.mensualidad || 0), 0),
    };
    res.json({ success: true, dias_aviso: DIAS_AVISO, resumen, clientes });
  } catch (e) { responderError(res, e, 'clientes'); }
};

// GET /api/superadmin/clientes/:id  -> el cliente, sus máquinas y su historial de pagos
const fichaCliente = async (req, res) => {
  try {
    const nuevas = await hayClientes();
    const u = await pool.query(`SELECT *${nuevas ? ", to_char(pagado_hasta, 'YYYY-MM-DD') AS pagado_hasta_txt" : ''}
                                FROM usuarios_duenos WHERE id::text = $1`, [String(req.params.id)]);
    if (!u.rowCount) return res.status(404).json({ success: false, message: 'El cliente no existe.' });
    const c = u.rows[0];
    const flota = await require('./superadminFlotaController').consultarFlota();
    const maquinas = flota.filter((m) => String(m.dueno.id) === String(c.id));
    const mensajes = nuevas ? (await pool.query(
      `SELECT machine_id, mensaje_bloqueo, suspendida_en FROM maquinas WHERE id_dueno::text = $1`, [String(c.id)])).rows : [];
    const porId = Object.fromEntries(mensajes.map((x) => [x.machine_id, x]));
    const pagos = nuevas ? (await pool.query(`
      SELECT id, monto::float AS monto, meses, to_char(pagado_desde, 'YYYY-MM-DD') AS pagado_desde,
             to_char(pagado_hasta, 'YYYY-MM-DD') AS pagado_hasta, nota, registrado_por, creado_en
      FROM pagos_mensualidad WHERE id_dueno = $1 ORDER BY creado_en DESC LIMIT 50`, [String(c.id)])).rows : [];
    const cliente = {
      id: c.id, nombre: c.nombre, email: c.email, rol: String(c.rol || 'dueno').toLowerCase(),
      celular: c.celular || null, documento: c.documento || null,
      mensualidad: c.mensualidad != null ? Number(c.mensualidad) : null,
      pagado_hasta: c.pagado_hasta_txt || null,
    };
    const p = estadoPago(cliente);
    res.json({
      success: true,
      cliente: { ...cliente, estado_pago: p.estado, dias_para_vencer: p.dias, es_superadmin: ROLES_SUPERADMIN.has(cliente.rol) },
      maquinas: maquinas.map((m) => ({ ...m, suspendida: !m.pago_al_dia,
        mensaje_bloqueo: porId[m.id] ? porId[m.id].mensaje_bloqueo : null, suspendida_en: porId[m.id] ? porId[m.id].suspendida_en : null })),
      pagos,
    });
  } catch (e) { responderError(res, e, 'ficha del cliente'); }
};

// PUT /api/superadmin/clientes/:id/mensualidad { mensualidad?, pagado_hasta? }
const guardarMensualidad = async (req, res) => {
  try {
    if (!(await hayClientes())) return sinMigracion(res);
    const sets = [], vals = [];
    if (req.body.mensualidad !== undefined) {
      const m = req.body.mensualidad === null || req.body.mensualidad === '' ? null : Number(req.body.mensualidad);
      if (m !== null && (!Number.isFinite(m) || m < 0 || m > 100000)) return res.status(400).json({ success: false, message: 'Monto de mensualidad inválido.' });
      vals.push(m); sets.push(`mensualidad = $${vals.length}`);
    }
    if (req.body.pagado_hasta !== undefined) {
      const f = req.body.pagado_hasta;
      if (f !== null && f !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(f))) return res.status(400).json({ success: false, message: 'Fecha inválida (AAAA-MM-DD).' });
      vals.push(f || null); sets.push(`pagado_hasta = $${vals.length}::date`);
    }
    if (!sets.length) return res.status(400).json({ success: false, message: 'No llegó ningún cambio.' });
    vals.push(String(req.params.id));
    const r = await pool.query(`UPDATE usuarios_duenos SET ${sets.join(', ')} WHERE id::text = $${vals.length} RETURNING id`, vals);
    if (!r.rowCount) return res.status(404).json({ success: false, message: 'El cliente no existe.' });
    await auditoria.registrar({ usuario: req.superadmin.email, accion: 'mensualidad_editada',
      detalle: { id_dueno: req.params.id, mensualidad: req.body.mensualidad, pagado_hasta: req.body.pagado_hasta } });
    res.json({ success: true, message: 'Mensualidad guardada.' });
  } catch (e) { responderError(res, e, 'mensualidad'); }
};

// Suspende o reactiva máquinas (dentro de una transacción o con el pool)
async function cambiarSuspension(q, where, vals, suspender, motivo) {
  const conCols = await hayClientes();
  const sets = [`pago_al_dia = ${suspender ? 'false' : 'true'}`];
  if (conCols) {
    if (suspender) {
      vals.push(motivo || MENSAJE_DEFECTO);
      sets.push(`mensaje_bloqueo = $${vals.length}`, 'suspendida_en = COALESCE(suspendida_en, now())');
    } else {
      sets.push('mensaje_bloqueo = NULL', 'suspendida_en = NULL');
    }
  }
  const r = await q.query(`UPDATE maquinas m SET ${sets.join(', ')} WHERE ${where} RETURNING m.machine_id`, vals);
  return r.rows.map((x) => x.machine_id);
}

// PUT /api/superadmin/clientes/:id/suspension { suspender: true|false, motivo? }
const suspenderCliente = async (req, res) => {
  try {
    invalidarResumen();
    const suspender = req.body.suspender !== false;
    const u = await pool.query('SELECT id, nombre, rol FROM usuarios_duenos WHERE id::text = $1', [String(req.params.id)]);
    if (!u.rowCount) return res.status(404).json({ success: false, message: 'El cliente no existe.' });
    if (suspender && ROLES_SUPERADMIN.has(String(u.rows[0].rol || '').toLowerCase())) {
      return res.status(400).json({ success: false, message: 'No puedes suspender una cuenta superadmin.' });
    }
    const motivo = identidad.limpiar(req.body.motivo).slice(0, 200);
    // Suspender: todas sus máquinas (las que ya estaban suspendidas toman el motivo nuevo). Reactivar: solo las suspendidas.
    const ids = await cambiarSuspension(pool, `m.id_dueno::text = $1${suspender ? '' : ` AND (${SUSPENDIDA})`}`, [String(req.params.id)], suspender, motivo);
    await auditoria.registrar({ usuario: req.superadmin.email, accion: suspender ? 'cliente_suspendido' : 'cliente_reactivado',
      detalle: { id_dueno: req.params.id, nombre: u.rows[0].nombre, maquinas: ids, motivo: motivo || null } });
    res.json({ success: true, maquinas: ids,
      message: suspender ? `${ids.length} máquina(s) de ${u.rows[0].nombre || 'el cliente'} suspendida(s). Siguen vendiendo; el cliente no puede entrar a ellas.`
                         : `${ids.length} máquina(s) de ${u.rows[0].nombre || 'el cliente'} reactivada(s).` });
  } catch (e) { responderError(res, e, 'suspender cliente'); }
};

// PUT /api/superadmin/maquinas/:id/suspension { suspender: true|false, motivo? }
const suspenderMaquina = async (req, res) => {
  try {
    invalidarResumen();
    const suspender = req.body.suspender !== false;
    const motivo = identidad.limpiar(req.body.motivo).slice(0, 200);
    const ids = await cambiarSuspension(pool, 'm.machine_id = $1', [req.params.id], suspender, motivo);
    if (!ids.length) return res.status(404).json({ success: false, message: 'La máquina no existe. Recarga la página.' });
    await auditoria.registrar({ usuario: req.superadmin.email, accion: suspender ? 'maquina_suspendida' : 'maquina_reactivada',
      machine_id: req.params.id, detalle: { motivo: motivo || null } });
    res.json({ success: true, message: suspender ? 'Máquina suspendida.' : 'Máquina reactivada.' });
  } catch (e) { responderError(res, e, 'suspender máquina'); }
};

// POST /api/superadmin/clientes/:id/pagos { meses = 1, monto?, nota?, reactivar = true }
// Extiende "pagado hasta" desde hoy (si ya venció) o desde la fecha vigente, y reactiva sus máquinas.
const registrarPago = async (req, res) => {
  if (!(await hayClientes())) return sinMigracion(res);
  const meses = parseInt(req.body.meses, 10) || 1;
  if (meses < 1 || meses > 24) return res.status(400).json({ success: false, message: 'Meses entre 1 y 24.' });
  const monto = req.body.monto === undefined || req.body.monto === null || req.body.monto === '' ? null : Number(req.body.monto);
  if (monto !== null && (!Number.isFinite(monto) || monto < 0)) return res.status(400).json({ success: false, message: 'Monto inválido.' });
  const nota = identidad.limpiar(req.body.nota).slice(0, 200) || null;
  const client = await pool.connect();
  try {
    invalidarResumen();
    await client.query('BEGIN');
    const u = await client.query(
      `SELECT id, nombre, mensualidad, to_char(pagado_hasta, 'YYYY-MM-DD') AS pagado_hasta_txt
       FROM usuarios_duenos WHERE id::text = $1 FOR UPDATE`, [String(req.params.id)]);
    if (!u.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'El cliente no existe.' }); }
    const c = u.rows[0];
    const r = await client.query(`
      SELECT GREATEST(COALESCE($1::date, ${tiempo.HOY}), ${tiempo.HOY}) AS desde,
             (GREATEST(COALESCE($1::date, ${tiempo.HOY}), ${tiempo.HOY}) + make_interval(months => $2))::date AS hasta,
             to_char((GREATEST(COALESCE($1::date, ${tiempo.HOY}), ${tiempo.HOY}) + make_interval(months => $2))::date, 'YYYY-MM-DD') AS hasta_txt`,
      [c.pagado_hasta_txt, meses]);
    const { desde, hasta, hasta_txt: hastaTxt } = r.rows[0];
    const montoFinal = monto !== null ? monto : (c.mensualidad != null ? Number(c.mensualidad) * meses : null);
    await client.query('UPDATE usuarios_duenos SET pagado_hasta = $1 WHERE id = $2', [hasta, c.id]);
    await client.query(`
      INSERT INTO pagos_mensualidad (id_dueno, monto, meses, pagado_desde, pagado_hasta, nota, registrado_por)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`, [String(c.id), montoFinal, meses, desde, hasta, nota, req.superadmin.email]);
    let reactivadas = [];
    if (req.body.reactivar !== false) {
      reactivadas = await cambiarSuspension(client, `m.id_dueno::text = $1 AND ${SUSPENDIDA}`, [String(c.id)], false);
    }
    await client.query('COMMIT');
    await auditoria.registrar({ usuario: req.superadmin.email, accion: 'pago_mensualidad',
      detalle: { id_dueno: c.id, nombre: c.nombre, meses, monto: montoFinal, pagado_hasta: hastaTxt, reactivadas } });
    res.json({ success: true, pagado_hasta: hastaTxt, reactivadas,
      message: `Pago registrado: al día hasta el ${hastaTxt}${reactivadas.length ? ` · ${reactivadas.length} máquina(s) reactivada(s)` : ''}.` });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    responderError(res, e, 'registrar pago');
  } finally { client.release(); }
};

// POST /api/superadmin/clientes/:id/entrar  -> sesión del cliente para darle soporte (2 horas)
const entrarComoCliente = async (req, res) => {
  try {
    const secreto = process.env.JWT_SECRET;
    if (!secreto) return res.status(503).json({ success: false, message: 'Falta JWT_SECRET en Render.' });
    const u = await pool.query('SELECT id, nombre, email, rol FROM usuarios_duenos WHERE id::text = $1', [String(req.params.id)]);
    if (!u.rowCount) return res.status(404).json({ success: false, message: 'El cliente no existe.' });
    const c = u.rows[0];
    if (ROLES_SUPERADMIN.has(String(c.rol || '').toLowerCase())) {
      return res.status(400).json({ success: false, message: 'Esa cuenta es superadmin: entra con ella directamente.' });
    }
    const token = jwt.sign({ id: c.id, email: c.email, rol: c.rol, nombre: c.nombre,
      soporte: { por: req.superadmin.email, desde: new Date().toISOString() } }, secreto, { algorithm: 'HS256', expiresIn: '2h' });
    await auditoria.registrar({ usuario: req.superadmin.email, accion: 'entro_como_cliente',
      detalle: { id_dueno: c.id, nombre: c.nombre, email: c.email } });
    console.log(`[soporte] ${req.superadmin.email} entró a la cuenta de ${c.email}`);
    res.json({ success: true, token, expira_en: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
      user: { id: c.id, nombre: c.nombre, email: c.email, rol: c.rol }, soporte: { por: req.superadmin.email } });
  } catch (e) { responderError(res, e, 'entrar como cliente'); }
};

module.exports = {
  listarClientes, fichaCliente, guardarMensualidad, suspenderCliente, suspenderMaquina, registrarPago, entrarComoCliente,
};
