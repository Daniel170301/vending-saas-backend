// controllers/superadminFlotaController.js
// Entorno superadmin · Centro de control, Flota y Ficha de máquina.
// Todas las rutas pasan por soloSuperadmin (token + rol en la base de datos).
const pool = require('../config/database');
const identidad = require('../services/identidadMaquina');
const kymez = require('../services/kymez');
const tiempo = require('../utils/tiempo');
const resumenVentas = require('../services/resumenVentas');
const auditoria = require('../utils/auditoria');
const { columnaExiste } = require('../utils/esquema');

function responderError(res, e, contexto) {
  if (e && e.status) return res.status(e.status).json({ success: false, message: e.message, ...(e.extra || {}) });
  console.error(`[superadmin] ${contexto}:`, e);
  return res.status(500).json({ success: false, message: `Error del servidor (${contexto}): ${e.message}` });
}

const MONTO = (v = 'v') => `COALESCE(NULLIF(${v}.precio::text, '')::numeric, 0)`;

// Medio de pago, con la misma regla que usa la app: Yape o Efectivo (monedas + billetes)
async function sqlMetodo(v = 'v') {
  const f = (await columnaExiste('historial_ventas', 'fuente')) ? `${v}.fuente` : 'NULL::text';
  const porCliente = `CASE WHEN btrim(COALESCE(${v}.nombre_cliente, '')) ILIKE 'efectivo' THEN 'efectivo' ELSE 'yape' END`;
  return `CASE WHEN ${f} ILIKE '%yape%' THEN 'yape'
               WHEN ${f} ILIKE '%moned%' OR ${f} ILIKE '%billet%' OR ${f} ILIKE '%efectivo%' OR ${f} ILIKE '%cash%' THEN 'efectivo'
               ELSE ${porCliente} END`;
}

// Qué partes del esquema kymez existen en esta base
async function partesKymez() {
  return {
    maq: await kymez.tiene('maquinas', 'cuenta_cobro_id'),
    est: await kymez.tiene('maquinas_estado', 'actualizado_en'),
    cue: await kymez.tiene('cuentas_cobro', 'id'),
    cueDesc: await kymez.tiene('cuentas_cobro', 'descripcion'),
    inc: await kymez.tiene('incidencias', 'resuelta'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  La flota: una fila por máquina con todo lo que necesita el superadmin
// ─────────────────────────────────────────────────────────────────────────────
async function consultarFlota(machineId = null) {
  const kz = await partesKymez();
  const kmt = await identidad.hayKMT();
  const conResumen = resumenVentas.disponible();
  const metodo = await sqlMetodo('v');
  const nombre = await identidad.sqlNombre('m');
  const params = machineId ? [machineId] : [];

  const sql = `
    WITH hoy AS (
      SELECT v.machine_id, count(*)::int AS unidades,
             COALESCE(sum(${MONTO()}), 0)::float AS monto,
             COALESCE(sum(${MONTO()}) FILTER (WHERE ${metodo} = 'yape'), 0)::float AS yape,
             COALESCE(sum(${MONTO()}) FILTER (WHERE ${metodo} = 'efectivo'), 0)::float AS efectivo
      FROM historial_ventas v
      WHERE v.fecha >= ${await tiempo.inicioDia(0)} ${machineId ? 'AND v.machine_id = $1' : ''}
      GROUP BY 1
    )
    SELECT m.machine_id, NULLIF(btrim(m.name), '') AS nombre, ${nombre} AS name,
           ${await identidad.sqlCamposKMT('m')},
           NULLIF(btrim(m.matricula::text), '') AS matricula,
           COALESCE(NULLIF(btrim(m.location), ''), m.ubicacion) AS location,
           m.distrito, m.ciudad, m.referencia, m.brand, m.model, m.pago_al_dia,
           m.id_dueno, u.nombre AS dueno_nombre, u.email AS dueno_email,
           m.id_cliente_punto, c.razon_social AS cliente_nombre,
           ${identidad.SQL_EQUIPO_PENDIENTE('m')} AS equipo_pendiente,
           ${kz.maq ? 'km.machine_id IS NOT NULL AS kz_registrada, km.cuenta_cobro_id, km.activa AS yape_activa,'
                    : 'false AS kz_registrada, NULL::text AS cuenta_cobro_id, NULL::boolean AS yape_activa,'}
           ${kz.maq && kz.cueDesc ? 'cc.descripcion AS cuenta_descripcion,' : 'NULL::text AS cuenta_descripcion,'}
           ${kz.est ? `ke.machine_id IS NOT NULL AS kz_telemetria, ${kymez.SQL_EN_LINEA('ke')} AS en_linea,
                       ke.actualizado_en AS visto_en, ke.datos->>'rssi' AS rssi, ke.datos->>'fw' AS fw,`
                    : `false AS kz_telemetria, false AS en_linea, NULL::timestamptz AS visto_en, NULL::text AS rssi, NULL::text AS fw,`}
           COALESCE(h.unidades, 0) AS hoy_unidades, COALESCE(h.monto, 0) AS hoy_monto,
           COALESCE(h.yape, 0) AS hoy_yape, COALESCE(h.efectivo, 0) AS hoy_efectivo,
           ${conResumen ? 'COALESCE(vm.monto, 0)::float AS mes_monto, COALESCE(vm.unidades, 0)::int AS mes_unidades,'
                        : 'NULL::float AS mes_monto, NULL::int AS mes_unidades,'}
           ${await tiempo.comoInstante('uv.fecha')} AS ultima_venta,
           ${kz.inc ? 'COALESCE(inc.n, 0)::int' : '0'} AS incidencias_abiertas
    FROM maquinas m
    LEFT JOIN usuarios_duenos u ON u.id::text = m.id_dueno::text
    LEFT JOIN LATERAL (SELECT razon_social FROM empresas_clientes c WHERE c.id_usuario = m.id_cliente_punto LIMIT 1) c ON true
    ${kz.maq ? 'LEFT JOIN kymez.maquinas km ON km.machine_id = m.machine_id' : ''}
    ${kz.maq && kz.cueDesc ? 'LEFT JOIN kymez.cuentas_cobro cc ON cc.id = km.cuenta_cobro_id' : ''}
    ${kz.est ? 'LEFT JOIN kymez.maquinas_estado ke ON ke.machine_id = m.machine_id' : ''}
    LEFT JOIN hoy h ON h.machine_id = m.machine_id
    ${conResumen ? `LEFT JOIN ventas_mes_maquina vm ON vm.machine_id = m.machine_id AND vm.mes = date_trunc('month', ${tiempo.HOY})::date` : ''}
    LEFT JOIN LATERAL (SELECT v.fecha FROM historial_ventas v WHERE v.machine_id = m.machine_id ORDER BY v.fecha DESC LIMIT 1) uv ON true
    ${kz.inc ? `LEFT JOIN (SELECT machine_id, count(*) AS n FROM kymez.incidencias
                           WHERE NOT resuelta AND machine_id IS NOT NULL GROUP BY 1) inc ON inc.machine_id = m.machine_id` : ''}
    ${machineId ? 'WHERE m.machine_id = $1' : ''}
    ORDER BY ${kmt ? 'm.region_id NULLS LAST, m.numero_kmt NULLS LAST, ' : ''}lower(${nombre})`;

  const { rows } = await pool.query(sql, params);
  return rows.map(armarMaquina);
}

const HORA = 3600 * 1000;
function armarMaquina(r) {
  const d = identidad.decorar(r);
  const tipo = r.equipo_pendiente ? 'pendiente' : (r.kz_registrada || r.kz_telemetria) ? 'kymez' : 'esp32';
  const conexion = r.equipo_pendiente ? 'sin_equipo'
    : r.kz_telemetria ? (r.en_linea ? 'en_linea' : 'fuera_de_linea')
    : 'sin_telemetria';
  const ultima = r.ultima_venta ? new Date(r.ultima_venta) : null;
  const alertas = [];
  if (!d.codigo_kmt) alertas.push('sin_codigo');
  if (!d.nombre) alertas.push('sin_nombre');
  if (r.equipo_pendiente) alertas.push('equipo_pendiente');
  if (conexion === 'fuera_de_linea') alertas.push('fuera_de_linea');
  if (!r.equipo_pendiente && (!ultima || Date.now() - ultima.getTime() > 24 * HORA)) alertas.push('sin_ventas_24h');
  if (tipo === 'kymez' && !r.cuenta_cobro_id) alertas.push('sin_cuenta_yape');
  if (r.incidencias_abiertas > 0) alertas.push('incidencias');
  if (r.pago_al_dia === false) alertas.push('bloqueada');

  return {
    id: r.machine_id,
    equipo_id: r.machine_id,
    nombre: d.nombre,
    name: r.name,
    codigo_kmt: d.codigo_kmt,
    region_id: r.region_id,
    region_nombre: r.region_nombre,
    numero_kmt: r.numero_kmt,
    codigo_descripcion: d.codigo_descripcion,
    codigo_pendiente: d.codigo_pendiente,
    equipo_pendiente: d.equipo_pendiente,
    matricula: r.matricula,
    location: r.location,
    distrito: r.distrito,
    ciudad: r.ciudad,
    referencia: r.referencia,
    marca: r.brand,
    modelo: r.model,
    pago_al_dia: r.pago_al_dia !== false,
    dueno: { id: r.id_dueno, nombre: r.dueno_nombre, email: r.dueno_email },
    cliente_nombre: r.cliente_nombre,
    tipo_equipo: tipo,
    conexion: { estado: conexion, visto_en: r.visto_en, rssi: r.rssi != null ? Number(r.rssi) : null, fw: r.fw },
    yape: tipo === 'kymez'
      ? { cuenta_cobro_id: r.cuenta_cobro_id, cuenta_descripcion: r.cuenta_descripcion, activa: r.yape_activa !== false }
      : null,
    ventas: {
      hoy_monto: r.hoy_monto, hoy_unidades: r.hoy_unidades, hoy_yape: r.hoy_yape, hoy_efectivo: r.hoy_efectivo,
      mes_monto: r.mes_monto, mes_unidades: r.mes_unidades, ultima_venta: r.ultima_venta,
    },
    incidencias_abiertas: r.incidencias_abiertas,
    alertas,
  };
}

// GET /api/superadmin/maquinas
const listarMaquinas = async (req, res) => {
  try {
    const maquinas = await consultarFlota();
    res.json({ success: true, generado_en: new Date().toISOString(), total: maquinas.length, maquinas });
  } catch (e) { responderError(res, e, 'flota'); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Centro de control
// ─────────────────────────────────────────────────────────────────────────────
let cacheResumen = null;   // { vence, cuerpo }
const invalidarResumen = () => { cacheResumen = null; };

// Inicio del día de hoy (Lima) como instante, para columnas timestamptz (kymez.*)
const INICIO_HOY_TZ = `(date_trunc('day', now() AT TIME ZONE '${tiempo.ZONA}') AT TIME ZONE '${tiempo.ZONA}')`;

async function ventasPorDia(dias) {
  if (resumenVentas.disponible()) {
    const { rows } = await pool.query(`
      SELECT to_char(g.dia, 'YYYY-MM-DD') AS dia, COALESCE(sum(v.unidades), 0)::int AS unidades,
             COALESCE(sum(v.monto), 0)::float AS monto
      FROM generate_series(${tiempo.HOY} - ${dias - 1}, ${tiempo.HOY}, interval '1 day') g(dia)
      LEFT JOIN ventas_dia_maquina v ON v.dia = g.dia::date
      GROUP BY g.dia ORDER BY g.dia`);
    return rows;
  }
  const dia = await tiempo.diaLocal('v.fecha');
  const { rows } = await pool.query(`
    SELECT to_char(g.dia, 'YYYY-MM-DD') AS dia, COALESCE(x.unidades, 0)::int AS unidades, COALESCE(x.monto, 0)::float AS monto
    FROM generate_series(${tiempo.HOY} - ${dias - 1}, ${tiempo.HOY}, interval '1 day') g(dia)
    LEFT JOIN (SELECT ${dia} AS dia, count(*) AS unidades, sum(${MONTO()}) AS monto
               FROM historial_ventas v WHERE v.fecha >= ${await tiempo.inicioDia(dias - 1)} GROUP BY 1) x ON x.dia = g.dia::date
    ORDER BY g.dia`);
  return rows;
}

async function ventasMes() {
  if (resumenVentas.disponible()) {
    const { rows } = await pool.query(`
      SELECT COALESCE(sum(unidades), 0)::int AS unidades, COALESCE(sum(monto), 0)::float AS monto
      FROM ventas_mes_maquina WHERE mes = date_trunc('month', ${tiempo.HOY})::date`);
    return rows[0];
  }
  return null;
}

async function resumenYape() {
  const r = { pagos_hoy: 0, monto_hoy: 0, entregados_hoy: 0, por_reembolsar: 0, monto_por_reembolsar: 0, estados_hoy: [], celulares: [] };
  if (await kymez.tiene('pagos_yape', 'estado')) {
    const hoy = await pool.query(`
      SELECT estado, count(*)::int AS n, COALESCE(sum(monto_cent), 0)::int AS cent
      FROM kymez.pagos_yape WHERE recibido_en >= ${INICIO_HOY_TZ} GROUP BY 1 ORDER BY 2 DESC`);
    r.estados_hoy = hoy.rows.map((x) => ({ estado: x.estado, ...kymez.describirPago(x.estado), cantidad: x.n, monto: x.cent / 100 }));
    for (const x of hoy.rows) {
      if (x.estado === 'duplicado_exacto' || x.estado === 'no_parseado') continue;
      r.pagos_hoy += x.n; r.monto_hoy += x.cent / 100;
      if (x.estado === 'entregado') r.entregados_hoy += x.n;
    }
    const pend = await pool.query(`
      SELECT count(*)::int AS n, COALESCE(sum(monto_cent), 0)::int AS cent
      FROM kymez.pagos_yape WHERE estado = ANY($1) AND recibido_en > now() - interval '30 days'`, [kymez.POR_REEMBOLSAR]);
    r.por_reembolsar = pend.rows[0].n; r.monto_por_reembolsar = pend.rows[0].cent / 100;
  }
  if (await kymez.tiene('cuentas_cobro', 'ultimo_latido')) {
    const desc = (await kymez.tiene('cuentas_cobro', 'descripcion')) ? 'descripcion' : 'NULL::text AS descripcion';
    const { rows } = await pool.query(`
      SELECT id, ${desc}, COALESCE(activa, true) AS activa, ultimo_latido,
             ${(await kymez.tiene('cuentas_cobro', 'ultima_notificacion')) ? 'ultima_notificacion' : 'NULL::timestamptz AS ultima_notificacion'}
      FROM kymez.cuentas_cobro ORDER BY id`);
    r.celulares = rows.map((c) => ({ ...c, estado: estadoCelular(c) }));
  }
  return r;
}

const LATIDO_MAX_MIN = Number(process.env.CELULAR_LATIDO_MAX_MIN || 12);
function estadoCelular(c) {
  if (c.activa === false) return 'desactivado';
  if (!c.ultimo_latido) return 'sin_latido_configurado';
  return Date.now() - new Date(c.ultimo_latido).getTime() > LATIDO_MAX_MIN * 60000 ? 'sin_latido' : 'en_linea';
}

async function resumenSincronizacion() {
  const r = { pendientes: 0, error: 0, omitidas: 0, sincronizadas_hoy: 0 };
  if (!(await kymez.tiene('ventas', 'qhapay_estado'))) return r;
  const { rows } = await pool.query(`
    SELECT qhapay_estado AS estado, count(*)::int AS n FROM kymez.ventas
    WHERE (qhapay_estado IN ('pendiente', 'error'))
       OR (qhapay_estado = 'omitida' AND creado_en > now() - interval '30 days')
       OR (qhapay_estado = 'sincronizada' AND creado_en >= ${INICIO_HOY_TZ})
    GROUP BY 1`);
  for (const x of rows) {
    if (x.estado === 'pendiente') r.pendientes = x.n;
    else if (x.estado === 'error') r.error = x.n;
    else if (x.estado === 'omitida') r.omitidas = x.n;
    else if (x.estado === 'sincronizada') r.sincronizadas_hoy = x.n;
  }
  return r;
}

async function resumenIncidencias() {
  if (!(await kymez.tiene('incidencias', 'resuelta'))) return { abiertas: 0, por_tipo: [], recientes: [] };
  const nombre = await identidad.sqlNombre('m');
  const porTipo = await pool.query(`
    SELECT tipo, count(*)::int AS n, max(creado_en) AS ultima FROM kymez.incidencias
    WHERE NOT resuelta GROUP BY 1 ORDER BY 2 DESC`);
  const recientes = await pool.query(`
    SELECT i.id, i.tipo, i.machine_id, i.monto_cent, i.creado_en, ${nombre} AS maquina,
           ${(await identidad.hayKMT()) ? 'm.codigo_kmt' : 'NULL::text'} AS codigo_kmt
    FROM kymez.incidencias i LEFT JOIN maquinas m ON m.machine_id = i.machine_id
    WHERE NOT i.resuelta ORDER BY i.creado_en DESC LIMIT 8`);
  return {
    abiertas: porTipo.rows.reduce((s, x) => s + x.n, 0),
    por_tipo: porTipo.rows.map((x) => ({ tipo: x.tipo, ...kymez.describirIncidencia(x.tipo), cantidad: x.n, ultima: x.ultima })),
    recientes: recientes.rows.map((x) => ({ ...x, monto: (x.monto_cent || 0) / 100, ...kymez.describirIncidencia(x.tipo) })),
  };
}

const PRIORIDAD = { alta: 0, media: 1, baja: 2 };
// Si muchas máquinas tienen el mismo problema (ej. se cayó el internet de una zona), va UNA línea
// con la lista, en vez de decenas de avisos.
function porMaquina(a, lista, { prioridad, tipo, uno, varios, detalle, desde }) {
  if (!lista.length) return;
  if (lista.length <= 3) {
    for (const m of lista) a.push({ prioridad, tipo, machine_id: m.id, titulo: uno(m), detalle, desde: desde(m) });
  } else {
    a.push({ prioridad, tipo, titulo: varios(lista.length), detalle, cantidad: lista.length,
      maquinas: lista.slice(0, 50).map((m) => ({ id: m.id, name: m.name, codigo_kmt: m.codigo_kmt })) });
  }
}

function listaAtencion(flota, yape, sinc, inc) {
  const a = [];
  porMaquina(a, flota.filter((x) => x.conexion.estado === 'fuera_de_linea'), {
    prioridad: 'alta', tipo: 'fuera_de_linea', uno: (m) => `${m.name} está fuera de línea`,
    varios: (n) => `${n} máquinas fuera de línea`, detalle: 'La placa no reporta: revisa luz e internet en el punto.',
    desde: (m) => m.conexion.visto_en });
  const celulares = yape.celulares.filter((x) => x.estado === 'sin_latido');
  if (celulares.length <= 3) {
    for (const c of celulares) {
      a.push({ prioridad: 'alta', tipo: 'celular_sin_latido', cuenta_cobro_id: c.id,
        titulo: `El celular ${c.descripcion || c.id} dejó de reportar`, detalle: 'Los Yapes a ese celular no llegan a ninguna máquina.', desde: c.ultimo_latido });
    }
  } else {
    a.push({ prioridad: 'alta', tipo: 'celular_sin_latido', titulo: `${celulares.length} celulares de cobro dejaron de reportar`,
      detalle: 'Los Yapes a esos celulares no llegan a ninguna máquina: revisa batería, datos y MacroDroid.',
      cantidad: celulares.length, cuentas: celulares.map((c) => ({ id: c.id, descripcion: c.descripcion })) });
  }
  if (yape.por_reembolsar > 0) {
    a.push({ prioridad: 'alta', tipo: 'por_reembolsar', titulo: `${yape.por_reembolsar} pago(s) Yape por revisar o reembolsar`,
      detalle: `S/ ${yape.monto_por_reembolsar.toFixed(2)} en los últimos 30 días` });
  }
  for (const t of inc.por_tipo.filter((x) => x.gravedad === 'alta' && !['no_entregado', 'sin_maquina', 'unused_credit', 'posible_duplicado', 'monto_excesivo'].includes(x.tipo))) {
    a.push({ prioridad: 'alta', tipo: 'incidencia', incidencia_tipo: t.tipo, titulo: `${t.cantidad} × ${t.titulo}`, detalle: t.accion, desde: t.ultima });
  }
  if (sinc.error + sinc.omitidas > 0) {
    a.push({ prioridad: 'media', tipo: 'sincronizacion', titulo: `${sinc.error + sinc.omitidas} venta(s) Yape no llegaron a Qhapay`,
      detalle: 'Revisa Sincronización: puedes reintentarlas.' });
  }
  porMaquina(a, flota.filter((x) => x.equipo_pendiente), {
    prioridad: 'media', tipo: 'equipo_pendiente', uno: (m) => `${m.name} no tiene equipo vinculado`,
    varios: (n) => `${n} máquinas sin equipo vinculado`, detalle: 'Vincula su placa en la ficha de la máquina.', desde: () => null });
  porMaquina(a, flota.filter((x) => x.alertas.includes('sin_ventas_24h') && x.ventas.ultima_venta), {
    prioridad: 'media', tipo: 'sin_ventas_24h', uno: (m) => `${m.name} no vende hace más de 24 h`,
    varios: (n) => `${n} máquinas sin ventas en 24 h`, detalle: 'Revisa si están prendidas, sin productos o con un problema de pago.',
    desde: (m) => m.ventas.ultima_venta });
  porMaquina(a, flota.filter((x) => x.codigo_pendiente), {
    prioridad: 'baja', tipo: 'sin_codigo', uno: (m) => `${m.name} no tiene código KMT`,
    varios: (n) => `${n} máquinas sin código KMT`, detalle: 'Asígnales su región y número en Flota.', desde: () => null });
  porMaquina(a, flota.filter((x) => !x.nombre), {
    prioridad: 'baja', tipo: 'sin_nombre', uno: (m) => `${m.name} no tiene nombre`,
    varios: (n) => `${n} máquinas sin nombre`, detalle: 'Ponles un nombre descriptivo en Flota.', desde: () => null });
  return a.sort((x, y) => PRIORIDAD[x.prioridad] - PRIORIDAD[y.prioridad]);
}

function agrupar(flota, clave, nombre) {
  const m = new Map();
  for (const x of flota) {
    const k = clave(x);
    if (!m.has(k)) m.set(k, { ...nombre(x), maquinas: 0, en_linea: 0, hoy_monto: 0, hoy_unidades: 0, mes_monto: 0 });
    const g = m.get(k);
    g.maquinas += 1;
    if (x.conexion.estado === 'en_linea') g.en_linea += 1;
    g.hoy_monto += x.ventas.hoy_monto; g.hoy_unidades += x.ventas.hoy_unidades; g.mes_monto += x.ventas.mes_monto || 0;
  }
  return [...m.values()].sort((a, b) => b.hoy_monto - a.hoy_monto || b.maquinas - a.maquinas);
}

// GET /api/superadmin/resumen
const resumen = async (req, res) => {
  try {
    if (cacheResumen && cacheResumen.vence > Date.now() && req.query.fresco !== '1') return res.json(cacheResumen.cuerpo);
    const [flota, dias, mes, yape, sinc, inc] = await Promise.all([
      consultarFlota(), ventasPorDia(14), ventasMes(), resumenYape(), resumenSincronizacion(), resumenIncidencias(),
    ]);
    const suma = (f) => flota.reduce((s, x) => s + f(x), 0);
    const kymezFlota = flota.filter((x) => x.tipo_equipo === 'kymez');
    const cuerpo = {
      success: true,
      generado_en: new Date().toISOString(),
      zona_horaria: tiempo.ZONA,
      maquinas: {
        total: flota.length,
        en_linea: flota.filter((x) => x.conexion.estado === 'en_linea').length,
        fuera_de_linea: flota.filter((x) => x.conexion.estado === 'fuera_de_linea').length,
        sin_telemetria: flota.filter((x) => x.conexion.estado === 'sin_telemetria').length,
        sin_equipo: flota.filter((x) => x.equipo_pendiente).length,
        kymez: kymezFlota.length,
        esp32: flota.filter((x) => x.tipo_equipo === 'esp32').length,
        con_codigo: flota.filter((x) => !x.codigo_pendiente).length,
        sin_codigo: flota.filter((x) => x.codigo_pendiente).length,
        sin_nombre: flota.filter((x) => !x.nombre).length,
        sin_ventas_24h: flota.filter((x) => x.alertas.includes('sin_ventas_24h')).length,
        con_ventas_hoy: flota.filter((x) => x.ventas.hoy_unidades > 0).length,
        bloqueadas: flota.filter((x) => !x.pago_al_dia).length,
      },
      ventas: {
        hoy: { monto: suma((x) => x.ventas.hoy_monto), unidades: suma((x) => x.ventas.hoy_unidades),
               yape: suma((x) => x.ventas.hoy_yape), efectivo: suma((x) => x.ventas.hoy_efectivo) },
        ayer: dias.length > 1 ? { monto: dias[dias.length - 2].monto, unidades: dias[dias.length - 2].unidades } : null,
        mes: mes,
        ultimos_14_dias: dias,
      },
      yape,
      sincronizacion: sinc,
      incidencias: inc,
      por_region: agrupar(flota, (x) => x.region_id || 0,
        (x) => ({ region_id: x.region_id || null, nombre: x.region_nombre || 'Sin región' })),
      por_dueno: agrupar(flota, (x) => String(x.dueno.id ?? ''),
        (x) => ({ id_dueno: x.dueno.id, nombre: x.dueno.nombre || x.dueno.email || 'Sin dueño', email: x.dueno.email })),
      top_hoy: [...flota].filter((x) => x.ventas.hoy_unidades > 0).sort((a, b) => b.ventas.hoy_monto - a.ventas.hoy_monto).slice(0, 8)
        .map((x) => ({ id: x.id, name: x.name, codigo_kmt: x.codigo_kmt, region_nombre: x.region_nombre,
          hoy_monto: x.ventas.hoy_monto, hoy_unidades: x.ventas.hoy_unidades, hoy_yape: x.ventas.hoy_yape, hoy_efectivo: x.ventas.hoy_efectivo })),
      atencion: listaAtencion(flota, yape, sinc, inc),
    };
    cacheResumen = { vence: Date.now() + 10000, cuerpo };
    res.json(cuerpo);
  } catch (e) { responderError(res, e, 'resumen'); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Ficha de una máquina
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/superadmin/maquinas/:id
const fichaMaquina = async (req, res) => {
  try {
    const id = req.params.id;
    const [maquina] = await consultarFlota(id);
    if (!maquina) return res.status(404).json({ success: false, message: 'La máquina no existe (quizá cambió de equipo). Recarga la página.' });
    const kz = await partesKymez();
    const metodo = await sqlMetodo('v');
    const hayFuente = await columnaExiste('historial_ventas', 'fuente');
    const nombre = await identidad.sqlNombre('m');

    const [inv, layout, ultimas, dias, incid, pagos, eventos, estado, audit] = await Promise.all([
      pool.query(`
        SELECT count(*)::int AS resortes,
               count(*) FILTER (WHERE COALESCE(nombre_producto, '') <> '')::int AS con_producto,
               COALESCE(sum(stock), 0)::int AS unidades, COALESCE(sum(capacidad), 0)::int AS capacidad
        FROM inventario WHERE machine_id = $1`, [id]),
      pool.query('SELECT layout FROM maquinas WHERE machine_id = $1', [id]),
      pool.query(`
        SELECT v.id, ${await tiempo.comoInstante('v.fecha')} AS fecha, v.codigo_motor, v.nombre_producto,
               ${MONTO()}::float AS precio, v.nombre_cliente, ${hayFuente ? 'v.fuente' : 'NULL::text AS fuente'}, ${metodo} AS metodo
        FROM historial_ventas v WHERE v.machine_id = $1 ORDER BY v.fecha DESC LIMIT 15`, [id]),
      resumenVentas.disponible()
        ? pool.query(`
            SELECT to_char(g.dia, 'YYYY-MM-DD') AS dia, COALESCE(v.unidades, 0)::int AS unidades, COALESCE(v.monto, 0)::float AS monto
            FROM generate_series(${tiempo.HOY} - 13, ${tiempo.HOY}, interval '1 day') g(dia)
            LEFT JOIN ventas_dia_maquina v ON v.dia = g.dia::date AND v.machine_id = $1 ORDER BY g.dia`, [id])
        : Promise.resolve({ rows: [] }),
      kz.inc ? pool.query(`
        SELECT id, tipo, pago_id, monto_cent, datos, resuelta, creado_en
               ${(await kymez.tiene('incidencias', 'resuelta_en')) ? ', resuelta_en' : ''}
               ${(await kymez.tiene('incidencias', 'resolucion')) ? ', resolucion' : ''}
        FROM kymez.incidencias WHERE machine_id = $1 ORDER BY resuelta, creado_en DESC LIMIT 20`, [id]) : Promise.resolve({ rows: [] }),
      (await kymez.tiene('pagos_yape', 'machine_id')) ? pool.query(`
        SELECT id, recibido_en, estado, pagador, monto_cent ${(await kymez.tiene('pagos_yape', 'entregado_en')) ? ', entregado_en' : ''}
        FROM kymez.pagos_yape WHERE machine_id = $1 ORDER BY id DESC LIMIT 15`, [id]) : Promise.resolve({ rows: [] }),
      (await kymez.tiene('eventos_maquina', 'tipo')) ? pool.query(`
        SELECT id, tipo, datos, creado_en FROM kymez.eventos_maquina WHERE machine_id = $1 ORDER BY id DESC LIMIT 15`, [id])
        : Promise.resolve({ rows: [] }),
      kz.est ? pool.query('SELECT online, datos, actualizado_en FROM kymez.maquinas_estado WHERE machine_id = $1', [id])
        : Promise.resolve({ rows: [] }),
      (await columnaExiste('auditoria_superadmin', 'accion')) ? pool.query(`
        SELECT id, usuario, accion, detalle, creado_en FROM auditoria_superadmin
        WHERE machine_id = $1 ORDER BY creado_en DESC LIMIT 30`, [id]) : Promise.resolve({ rows: [] }),
    ]);

    let bandejas = 0, resortesLayout = 0;
    try {
      let l = layout.rows[0] && layout.rows[0].layout;
      if (typeof l === 'string') l = JSON.parse(l);
      const t = Array.isArray(l) ? l : (l && Array.isArray(l.trays) ? l.trays : []);
      bandejas = t.length;
      resortesLayout = t.reduce((s, b) => s + (Array.isArray(b && b.springs) ? b.springs.length : 0), 0);
    } catch { /* layout roto: se muestra 0 */ }

    const i = inv.rows[0];
    const telemetria = estado.rows[0] || null;
    const checklist = [
      { paso: 'nombre', titulo: 'Nombre descriptivo', ok: !!maquina.nombre,
        ayuda: maquina.nombre ? maquina.nombre : 'Ponle un nombre que la identifique (ej. "Colegio San Juan · Patio")' },
      { paso: 'codigo', titulo: 'Código KMT', ok: !maquina.codigo_pendiente,
        ayuda: maquina.codigo_kmt ? `${maquina.codigo_kmt} · ${maquina.codigo_descripcion}` : 'Asígnale su región y número' },
      { paso: 'equipo', titulo: 'Equipo (placa) vinculado', ok: !maquina.equipo_pendiente,
        ayuda: maquina.equipo_pendiente ? 'Vincula el MACHINE_ID de la placa' : `ID del equipo: ${maquina.equipo_id}` },
      maquina.tipo_equipo === 'esp32'
        ? { paso: 'conexion', titulo: 'Equipo reportando', ok: !!maquina.ventas.ultima_venta, no_aplica: false,
            ayuda: 'Equipo ESP32 v1: no envía latido; se mide por sus ventas' }
        : { paso: 'conexion', titulo: 'Equipo conectado (latido)', ok: maquina.conexion.estado === 'en_linea',
            ayuda: telemetria ? (telemetria.online ? 'La placa envía su latido' : 'La placa se desconectó') : 'La placa todavía no se ha conectado',
            desde: telemetria ? telemetria.actualizado_en : null },
      maquina.tipo_equipo === 'esp32'
        ? { paso: 'yape', titulo: 'Cuenta Yape', ok: true, no_aplica: true, ayuda: 'Equipo ESP32 v1: cobra por MacroDroid directo' }
        : { paso: 'yape', titulo: 'Cuenta Yape (celular de cobro)', ok: !!(maquina.yape && maquina.yape.cuenta_cobro_id),
            ayuda: maquina.yape && maquina.yape.cuenta_cobro_id
              ? `${maquina.yape.cuenta_descripcion || maquina.yape.cuenta_cobro_id}` : 'Vincula el celular que recibe sus Yapes' },
      { paso: 'planograma', titulo: 'Planograma con productos', ok: i.con_producto > 0,
        ayuda: `${bandejas} bandejas · ${i.resortes} resortes · ${i.con_producto} con producto` },
      { paso: 'venta', titulo: 'Primera venta registrada', ok: !!maquina.ventas.ultima_venta,
        ayuda: maquina.ventas.ultima_venta ? 'Ya vende' : 'Todavía no hay ventas', desde: maquina.ventas.ultima_venta || null },
    ];

    res.json({
      success: true,
      maquina,
      planograma: { bandejas, resortes: resortesLayout, resortes_inventario: i.resortes, con_producto: i.con_producto,
        unidades: i.unidades, capacidad: i.capacidad },
      telemetria: telemetria ? { online: telemetria.online, actualizado_en: telemetria.actualizado_en, datos: telemetria.datos } : null,
      ventas_14_dias: dias.rows,
      ultimas_ventas: ultimas.rows,
      incidencias: incid.rows.map((x) => ({ ...x, monto: (x.monto_cent || 0) / 100, ...kymez.describirIncidencia(x.tipo) })),
      pagos_yape: pagos.rows.map((x) => ({ ...x, monto: (x.monto_cent || 0) / 100, estado_texto: kymez.describirPago(x.estado).texto,
        estado_color: kymez.describirPago(x.estado).color })),
      eventos: eventos.rows,
      auditoria: audit.rows.map((x) => ({ ...x, accion_texto: auditoria.ACCIONES[x.accion] || x.accion })),
      checklist,
      checklist_completo: checklist.every((x) => x.ok),
    });
  } catch (e) { responderError(res, e, 'ficha'); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Código KMT
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/superadmin/codigos/siguiente?region_id=1
const siguienteCodigo = async (req, res) => {
  try {
    if (!(await identidad.hayKMT())) return res.status(503).json({ success: false, message: 'La migración de códigos aún no corre. Espera unos segundos y recarga.' });
    const region = await identidad.leerRegion(pool, req.query.region_id);
    const numero = await identidad.siguienteNumero(pool, region.id);
    res.json({ success: true, region_id: region.id, region_nombre: region.nombre, numero,
      codigo: identidad.formatearKMT(region.id, numero), descripcion: identidad.describirKMT(region.nombre, numero) });
  } catch (e) { responderError(res, e, 'siguiente código'); }
};

async function maquinaActualizada(id) {
  const [m] = await consultarFlota(id);
  return m || null;
}

// PUT /api/superadmin/maquinas/:id/codigo-kmt { region_id, numero? }
const asignarCodigoKMT = async (req, res) => {
  invalidarResumen();
  const client = await pool.connect();
  try {
    if (!(await identidad.hayKMT())) return res.status(503).json({ success: false, message: 'La migración de códigos aún no corre. Espera unos segundos y recarga.' });
    await client.query('BEGIN');
    const r = await identidad.asignarKMT(client, req.params.id, req.body.region_id, req.body.numero);
    await client.query('COMMIT');
    if (r.anterior !== r.codigo) {
      await auditoria.registrar({ usuario: req.superadmin.email, accion: 'codigo_kmt_asignado', machine_id: req.params.id,
        detalle: { anterior: r.anterior, nuevo: r.codigo } });
    }
    console.log(`[superadmin] ${req.superadmin.email} asignó ${r.codigo} a ${req.params.id}`);
    res.json({ success: true, message: r.anterior === r.codigo ? `El código ya era ${r.codigo}.` : `Código asignado: ${r.codigo}`,
      anterior: r.anterior, codigo: r.codigo, descripcion: identidad.describirKMT(r.region.nombre, r.numero),
      maquina: await maquinaActualizada(req.params.id) });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') return res.status(409).json({ success: false, message: 'Ese código acaba de ser asignado a otra máquina. Elige otro número.' });
    responderError(res, e, 'código KMT');
  } finally { client.release(); }
};

// DELETE /api/superadmin/maquinas/:id/codigo-kmt
const quitarCodigoKMT = async (req, res) => {
  invalidarResumen();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await identidad.quitarKMT(client, req.params.id);
    await client.query('COMMIT');
    if (r.anterior) {
      await auditoria.registrar({ usuario: req.superadmin.email, accion: 'codigo_kmt_quitado', machine_id: req.params.id,
        detalle: { anterior: r.anterior } });
    }
    res.json({ success: true, message: r.anterior ? `Se quitó el código ${r.anterior}.` : 'La máquina no tenía código.',
      maquina: await maquinaActualizada(req.params.id) });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    responderError(res, e, 'quitar código');
  } finally { client.release(); }
};

// PUT /api/superadmin/maquinas/:id/datos { nombre?, matricula? }
const editarDatos = async (req, res) => {
  invalidarResumen();
  try {
    const cambios = [];
    const valores = [];
    const antes = await pool.query('SELECT name, matricula FROM maquinas WHERE machine_id = $1', [req.params.id]);
    if (!antes.rowCount) return res.status(404).json({ success: false, message: 'La máquina no existe. Recarga la página.' });
    if (req.body.nombre !== undefined) {
      const n = identidad.limpiar(req.body.nombre);
      if (n.length < 2 || n.length > 80) return res.status(400).json({ success: false, message: 'El nombre debe tener entre 2 y 80 caracteres.' });
      valores.push(n); cambios.push(`name = $${valores.length}`);
    }
    if (req.body.matricula !== undefined) {
      const mt = identidad.limpiar(req.body.matricula);
      if (mt.length > 40) return res.status(400).json({ success: false, message: 'La matrícula puede tener hasta 40 caracteres.' });
      valores.push(mt); cambios.push(`matricula = $${valores.length}`);
    }
    if (!cambios.length) return res.status(400).json({ success: false, message: 'No llegó ningún cambio.' });
    valores.push(req.params.id);
    await pool.query(`UPDATE maquinas SET ${cambios.join(', ')} WHERE machine_id = $${valores.length}`, valores);
    await auditoria.registrar({ usuario: req.superadmin.email, accion: 'datos_editados', machine_id: req.params.id,
      detalle: { antes: { nombre: antes.rows[0].name, matricula: antes.rows[0].matricula },
                 despues: { nombre: req.body.nombre, matricula: req.body.matricula } } });
    res.json({ success: true, message: 'Datos guardados.', maquina: await maquinaActualizada(req.params.id) });
  } catch (e) { responderError(res, e, 'datos'); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Equipo (placa) y Yape
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/superadmin/equipos-disponibles
const equiposDisponibles = async (req, res) => {
  try { res.json({ success: true, equipos: await identidad.equiposDisponibles() }); }
  catch (e) { responderError(res, e, 'equipos disponibles'); }
};

// PUT /api/superadmin/maquinas/:id/equipo { equipo_id, copiar_yape? }
const cambiarEquipo = async (req, res) => {
  invalidarResumen();
  const actual = req.params.id;
  const nuevo = identidad.limpiar(req.body.equipo_id);
  const problema = identidad.validarEquipo(nuevo);
  if (problema) return res.status(400).json({ success: false, message: problema });
  const client = await pool.connect();
  let yapeCopiado = null;
  try {
    await client.query('BEGIN');
    await identidad.cambiarEquipo(client, actual, nuevo);
    // La placa nueva hereda la cuenta Yape de la anterior, si no tiene una propia
    if (req.body.copiar_yape !== false && nuevo !== actual && (await kymez.tiene('maquinas', 'cuenta_cobro_id'))) {
      // Copia la fila completa (cuenta, activa, versión de firma, monto único…) con el ID nuevo
      const cols = [...(await kymez.estructura()).get('maquinas')].filter((c) => c !== 'machine_id');
      const lista = cols.map((c) => '"' + c.replace(/"/g, '""') + '"').join(', ');
      const r = await client.query(`
        INSERT INTO kymez.maquinas (machine_id, ${lista})
        SELECT $1, ${lista} FROM kymez.maquinas WHERE machine_id = $2
        ON CONFLICT (machine_id) DO NOTHING RETURNING cuenta_cobro_id`, [nuevo, actual]);
      if (r.rowCount) yapeCopiado = r.rows[0].cuenta_cobro_id;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') return res.status(409).json({ success: false, message: `El equipo ${nuevo} ya está vinculado a otra máquina.` });
    client.release();
    return responderError(res, e, 'cambiar equipo');
  }
  client.release();

  await auditoria.registrar({ usuario: req.superadmin.email, accion: 'equipo_cambiado', machine_id: nuevo,
    detalle: { anterior: actual, nuevo, yape_copiado: yapeCopiado } });
  console.log(`[superadmin] ${req.superadmin.email} cambió el equipo ${actual} -> ${nuevo}`);
  const kz = await identidad.estadoEnKymez(nuevo);
  let aviso = null;
  if (!identidad.limpiar(nuevo).match(kymez.ID_KYMEZ)) {
    aviso = `El ID ${nuevo} tiene caracteres que las placas KYMEZ no aceptan en MQTT (solo letras, números, - y _). Sirve para equipos ESP32 v1.`;
  } else if (kz && !kz.visto_en) {
    aviso = `El equipo ${nuevo} todavía no se ha conectado. Si es una placa KYMEZ, revisa que su MACHINE_ID (config.h) ` +
      `y su usuario de HiveMQ (permiso vending/${nuevo}/#) sean exactamente este ID` +
      (kz.registrada ? '.' : ', y vincúlale una cuenta Yape.');
  }
  res.json({ success: true, message: nuevo === actual ? 'El equipo ya era ese.' : `Equipo vinculado: ${nuevo}`,
    anterior: actual, equipo_id: nuevo, yape_copiado: yapeCopiado, kymez: kz, ...(aviso ? { aviso } : {}),
    maquina: await maquinaActualizada(nuevo) });
};

// PUT /api/superadmin/maquinas/:id/yape { cuenta_cobro_id | null, activa? }
const vincularYape = async (req, res) => {
  invalidarResumen();
  try {
    if (!(await kymez.tiene('maquinas', 'cuenta_cobro_id'))) {
      return res.status(503).json({ success: false, message: 'Esta base no tiene las tablas de kymez-pagos.' });
    }
    const id = req.params.id;
    const m = await pool.query('SELECT machine_id FROM maquinas WHERE machine_id = $1', [id]);
    if (!m.rowCount) return res.status(404).json({ success: false, message: 'La máquina no existe. Recarga la página.' });
    if (identidad.esEquipoPendiente(id)) return res.status(400).json({ success: false, message: 'Primero vincula el equipo (placa) de esta máquina.' });
    if (!kymez.ID_KYMEZ.test(id)) {
      return res.status(400).json({ success: false, message: `El equipo ${id} no es una placa KYMEZ (su ID no sirve para MQTT de kymez-pagos).` });
    }
    const cuenta = req.body.cuenta_cobro_id === null || req.body.cuenta_cobro_id === '' ? null : identidad.limpiar(req.body.cuenta_cobro_id);
    if (cuenta) {
      const c = await pool.query('SELECT id FROM kymez.cuentas_cobro WHERE id = $1', [cuenta]);
      if (!c.rowCount) return res.status(400).json({ success: false, message: `La cuenta ${cuenta} no existe. Créala en Cobros Yape → Celulares.` });
    }
    const antes = await pool.query('SELECT cuenta_cobro_id, activa FROM kymez.maquinas WHERE machine_id = $1', [id]);
    const activa = req.body.activa === undefined ? (antes.rows[0] ? antes.rows[0].activa !== false : true) : req.body.activa !== false;
    const kmCols = (await kymez.estructura()).get('maquinas') || new Set();
    const extra = [];
    if (kmCols.has('firma_version')) extra.push(['firma_version', 1]);
    if (kmCols.has('monto_unico')) extra.push(['monto_unico', false]);
    await pool.query(`
      INSERT INTO kymez.maquinas (machine_id, cuenta_cobro_id, activa${extra.map(([c]) => ', ' + c).join('')})
      VALUES ($1, $2, $3${extra.map((_, i) => `, $${i + 4}`).join('')})
      ON CONFLICT (machine_id) DO UPDATE SET cuenta_cobro_id = EXCLUDED.cuenta_cobro_id, activa = EXCLUDED.activa`,
      [id, cuenta, activa, ...extra.map(([, v]) => v)]);
    await auditoria.registrar({ usuario: req.superadmin.email, accion: cuenta ? 'yape_vinculado' : 'yape_desvinculado', machine_id: id,
      detalle: { antes: antes.rows[0] || null, despues: { cuenta_cobro_id: cuenta, activa } } });
    kymez.olvidar();
    res.json({ success: true, message: cuenta ? `Cuenta Yape vinculada: ${cuenta}` : 'Cuenta Yape desvinculada.',
      maquina: await maquinaActualizada(id) });
  } catch (e) { responderError(res, e, 'vincular Yape'); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Datos sin máquina (ventas, abastecimientos… de un ID que ya no existe)
// ─────────────────────────────────────────────────────────────────────────────
const TABLAS_HUERFANOS = [
  ['historial_ventas', 'ventas', 'fecha'],
  ['inventario', 'resortes', null],
  ['historial_abastecimiento', 'abastecimientos', 'fecha'],
  ['gastos', 'gastos', 'fecha'],
];

// GET /api/superadmin/huerfanos
const listarHuerfanos = async (req, res) => {
  try {
    const partes = [];
    for (const [tabla, etiqueta, fecha] of TABLAS_HUERFANOS) {
      if (!(await columnaExiste(tabla, 'machine_id'))) continue;
      const conFecha = fecha && (await columnaExiste(tabla, fecha));
      partes.push(`
        SELECT t.machine_id, '${etiqueta}' AS tipo, count(*)::int AS n,
               ${conFecha ? `min(t.${fecha})::text` : 'NULL::text'} AS desde, ${conFecha ? `max(t.${fecha})::text` : 'NULL::text'} AS hasta
        FROM ${tabla} t
        WHERE t.machine_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM maquinas m WHERE m.machine_id = t.machine_id)
        GROUP BY 1`);
    }
    if (!partes.length) return res.json({ success: true, huerfanos: [] });
    const { rows } = await pool.query(partes.join(' UNION ALL '));
    const porId = new Map();
    for (const r of rows) {
      if (!porId.has(r.machine_id)) porId.set(r.machine_id, { machine_id: r.machine_id, detalle: {}, total: 0 });
      const h = porId.get(r.machine_id);
      h.detalle[r.tipo] = { cantidad: r.n, desde: r.desde, hasta: r.hasta };
      h.total += r.n;
    }
    res.json({ success: true, huerfanos: [...porId.values()].sort((a, b) => b.total - a.total) });
  } catch (e) { responderError(res, e, 'datos sin máquina'); }
};

// POST /api/superadmin/huerfanos/mover { desde, hacia }
const moverHuerfanos = async (req, res) => {
  invalidarResumen();
  const desde = identidad.limpiar(req.body.desde);
  const hacia = identidad.limpiar(req.body.hacia);
  if (!desde || !hacia || desde === hacia) return res.status(400).json({ success: false, message: 'Indica el ID de origen y la máquina destino.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '180s'");
    // Nadie registra ventas mientras se mueven (unos segundos): los totales quedan exactos
    await client.query('LOCK TABLE historial_ventas IN SHARE ROW EXCLUSIVE MODE');
    const existeOrigen = await client.query('SELECT 1 FROM maquinas WHERE machine_id = $1', [desde]);
    if (existeOrigen.rowCount) throw identidad.error(400, `${desde} es una máquina que existe: para cambiarle el equipo usa su ficha.`);
    const destino = await client.query('SELECT machine_id FROM maquinas WHERE machine_id = $1 FOR UPDATE', [hacia]);
    if (!destino.rowCount) throw identidad.error(404, `La máquina destino ${hacia} no existe.`);

    const dia = await tiempo.diaLocal('fecha');
    const rango = await client.query(
      `SELECT min(${dia})::text AS desde, max(${dia})::text AS hasta, count(*)::int AS n FROM historial_ventas WHERE machine_id = $1`, [desde]);

    const movidos = {};
    await client.query("SET LOCAL qhapay.sin_resumen = 'on'");
    for (const [tabla, etiqueta] of TABLAS_HUERFANOS) {
      if (!(await columnaExiste(tabla, 'machine_id'))) continue;
      if (tabla === 'inventario') {
        // Los resortes solo se mueven si la máquina destino no tiene planograma (si no, se duplicarían)
        const tiene = await client.query('SELECT 1 FROM inventario WHERE machine_id = $1 LIMIT 1', [hacia]);
        if (tiene.rowCount) {
          const n = await client.query('SELECT count(*)::int AS n FROM inventario WHERE machine_id = $1', [desde]);
          movidos[etiqueta] = 0;
          if (n.rows[0].n) movidos.resortes_no_movidos = n.rows[0].n;
          continue;
        }
      }
      const r = await client.query(`UPDATE ${tabla} SET machine_id = $1 WHERE machine_id = $2`, [hacia, desde]);
      movidos[etiqueta] = r.rowCount;
    }
    await client.query("SET LOCAL qhapay.sin_resumen = 'off'");
    if (rango.rows[0].n > 0 && resumenVentas.disponible()) {
      await resumenVentas.recalcularRango(client, rango.rows[0].desde, rango.rows[0].hasta);
    }
    await client.query('COMMIT');
    await auditoria.registrar({ usuario: req.superadmin.email, accion: 'datos_movidos', machine_id: hacia,
      detalle: { desde, hacia, movidos } });
    res.json({ success: true, message: `Datos de ${desde} movidos a ${hacia}.`, movidos });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    responderError(res, e, 'mover datos');
  } finally { client.release(); }
};

module.exports = {
  consultarFlota, invalidarResumen,
  listarMaquinas, resumen, fichaMaquina,
  siguienteCodigo, asignarCodigoKMT, quitarCodigoKMT, editarDatos,
  equiposDisponibles, cambiarEquipo, vincularYape,
  listarHuerfanos, moverHuerfanos,
};
