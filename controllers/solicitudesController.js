// controllers/solicitudesController.js  (v3.6.6)
// Página pública /registro (sin sesión) y su revisión en Superadmin › Solicitudes.
const crypto = require('crypto');
const pool = require('../config/database');
const auditoria = require('../utils/auditoria');
const { cifrar, descifrar } = require('../utils/cifrado');
const { revisarQr } = require('../utils/qrYape');
const clave = require('../utils/clave');
const { columnaExiste } = require('../utils/esquema');
const identidad = require('../services/identidadMaquina');
const kymez = require('../services/kymez');
const sol = require('../services/solicitudes');

const SOPORTE = () => String(process.env.SOPORTE_TELEFONO || '').slice(0, 20);

// ---------- Freno para el formulario público (en memoria) ----------
const envios = new Map();          // ip -> [tiempos]
const MAX_POR_IP_HORA = Number(process.env.SOLICITUDES_MAX_IP_HORA || 5);
const MAX_GLOBAL_HORA = Number(process.env.SOLICITUDES_MAX_HORA || 200);
let globales = [];
function frenado(ip) {
  const ahora = Date.now(), hora = 3600000;
  globales = globales.filter((t) => ahora - t < hora);
  const mios = (envios.get(ip) || []).filter((t) => ahora - t < hora);
  envios.set(ip, mios);
  if (envios.size > 5000) envios.clear();
  return mios.length >= MAX_POR_IP_HORA || globales.length >= MAX_GLOBAL_HORA;
}
function anotar(ip) { const a = envios.get(ip) || []; a.push(Date.now()); envios.set(ip, a); globales.push(Date.now()); }

// ---------- Validación ----------
const txt = (v, max) => String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
const bool = (v) => v === true || v === 'true' || v === 'si' || v === 'sí';
const celular = (v) => { const d = String(v ?? '').replace(/\D/g, '').replace(/^51(?=9\d{8}$)/, ''); return /^9\d{8}$/.test(d) ? d : null; };
const correo = (v) => { const e = txt(v, 120).toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null; };
const OPC = {
  tipo_lugar: ['colegio', 'universidad', 'empresa', 'salud', 'transporte', 'gimnasio', 'comercio', 'otro'],
  senal_wifi: ['buena', 'regular', 'mala', 'no_se'],
  si_no: ['si', 'no', 'no_se'],
  cobro_metodo: ['yape', 'plin', 'ambos'],
};
const opcion = (v, lista) => (lista.includes(String(v)) ? String(v) : null);

function validar(b) {
  const e = [];
  const nombre = txt(b.nombre, 100); if (nombre.length < 3) e.push('Escribe tu nombre completo.');
  const telefono = celular(b.telefono); if (!telefono) e.push('El celular / WhatsApp debe tener 9 dígitos y empezar con 9.');
  const email = correo(b.email); if (!email) e.push('Escribe un correo válido: será tu usuario de QhaPay.');
  const lugar = txt(b.lugar, 120); if (lugar.length < 2) e.push('Escribe el nombre del lugar donde está la máquina.');
  const direccion = txt(b.direccion, 200); if (direccion.length < 4) e.push('Escribe la dirección.');
  const distrito = txt(b.distrito, 80); if (distrito.length < 2) e.push('Escribe el distrito.');
  const ciudad = txt(b.ciudad, 80); if (ciudad.length < 2) e.push('Escribe la ciudad o región.');
  const tipo = String(b.tipo_maquina || '').toUpperCase(); if (!sol.TIPOS[tipo]) e.push('Elige qué máquina es.');
  const ssid1 = txt(b.wifi_ssid_1, 32); if (!ssid1) e.push('Escribe el nombre del WiFi (como aparece en el celular).');
  const pass1 = String(b.wifi_pass_1 ?? '');
  if (pass1 && (pass1.length < 8 || pass1.length > 63)) e.push('La contraseña del WiFi debe tener entre 8 y 63 caracteres (o déjala vacía si el WiFi no tiene).');
  const ssid2 = txt(b.wifi_ssid_2, 32); const pass2 = String(b.wifi_pass_2 ?? '');
  if (pass2 && (pass2.length < 8 || pass2.length > 63)) e.push('La contraseña del segundo WiFi debe tener entre 8 y 63 caracteres.');
  const cobroMetodo = opcion(b.cobro_metodo, OPC.cobro_metodo); if (!cobroMetodo) e.push('Elige con qué vas a cobrar (Yape, Plin o ambos).');
  const cobroNumero = celular(b.cobro_numero); if (!cobroNumero) e.push('El número que recibirá los pagos debe tener 9 dígitos y empezar con 9.');
  if (!bool(b.acepta_requisitos)) e.push('Confirma que la máquina cumple los requisitos.');
  if (!bool(b.acepta_datos)) e.push('Acepta el uso de tus datos para la instalación.');
  let lat = Number(b.lat), lng = Number(b.lng);
  if (!(Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) { lat = null; lng = null; }
  const qr = txt(b.qr_yape, 512);
  const cantidad = Math.min(50, Math.max(1, parseInt(b.cantidad_maquinas, 10) || 1));
  return {
    errores: e,
    fila: { nombre, telefono, email, lugar, direccion, distrito, ciudad, tipo_maquina: tipo, cobro_numero: cobroNumero,
      wifi_ssid_1: ssid1, wifi_pass_1: pass1, wifi_ssid_2: ssid2 || null, wifi_pass_2: pass2, qr_yape: qr || null },
    datos: {
      empresa: txt(b.empresa, 120) || undefined, ruc: /^\d{11}$/.test(String(b.ruc || '')) ? String(b.ruc) : undefined,
      tipo_lugar: opcion(b.tipo_lugar, OPC.tipo_lugar) || undefined, referencia: txt(b.referencia, 200) || undefined,
      lat: lat ?? undefined, lng: lng ?? undefined, horario_instalacion: txt(b.horario_instalacion, 120) || undefined,
      cantidad_maquinas: cantidad, modelo: txt(b.modelo, 80) || undefined, tipo_otro: txt(b.tipo_otro, 80) || undefined,
      tiene_monedero: opcion(b.tiene_monedero, OPC.si_no) || undefined, tiene_billetero: opcion(b.tiene_billetero, OPC.si_no) || undefined,
      tiene_mdb: opcion(b.tiene_mdb, OPC.si_no) || undefined, senal_wifi: opcion(b.senal_wifi, OPC.senal_wifi) || undefined,
      enchufe_cerca: opcion(b.enchufe_cerca, OPC.si_no) || undefined, cobro_metodo: cobroMetodo || undefined,
      cobro_titular: txt(b.cobro_titular, 100) || undefined, celular_android: opcion(b.celular_android, OPC.si_no) || undefined,
      celular_modelo: txt(b.celular_modelo, 80) || undefined, notas: txt(b.notas, 500) || undefined,
    },
  };
}

// ---------- Público ----------
// POST /api/solicitudes
const crear = async (req, res) => {
  try {
    await sol.asegurarTabla();
    const b = req.body || {};
    if (txt(b.sitio_web, 50)) return res.json({ success: true, codigo: 'SOL-0000' });   // trampa para robots
    if (frenado(req.ip)) return res.status(429).json({ success: false, message: 'Recibimos muchas solicitudes desde esta conexión. Intenta en una hora o escríbenos por WhatsApp.' });
    const { errores, fila, datos } = validar(b);
    if (errores.length) return res.status(400).json({ success: false, message: errores[0], errores });
    const qr = fila.qr_yape ? revisarQr(fila.qr_yape) : null;
    const r = await pool.query(
      `INSERT INTO solicitudes_maquina (nombre, telefono, email, lugar, direccion, distrito, ciudad, tipo_maquina, cobro_numero,
         datos, wifi_ssid_1, wifi_pass_1_cif, wifi_ssid_2, wifi_pass_2_cif, qr_yape, qr_valido, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
      [fila.nombre, fila.telefono, fila.email, fila.lugar, fila.direccion, fila.distrito, fila.ciudad, fila.tipo_maquina, fila.cobro_numero,
        JSON.stringify(datos), fila.wifi_ssid_1, cifrar(fila.wifi_pass_1), fila.wifi_ssid_2, cifrar(fila.wifi_pass_2),
        fila.qr_yape, qr ? qr.ok : null, String(req.ip || '').slice(0, 64)]);
    anotar(req.ip);
    res.status(201).json({ success: true, codigo: sol.codigo(r.rows[0].id),
      qr_aviso: qr && !qr.ok ? 'No pudimos leer bien tu QR de Yape; te lo pediremos por WhatsApp.' : undefined,
      message: 'Solicitud recibida. Te escribiremos por WhatsApp para coordinar la instalación.' });
  } catch (e) {
    console.error('[solicitudes] crear:', e.message);
    res.status(500).json({ success: false, message: 'No pudimos guardar tu solicitud. Intenta de nuevo en unos minutos.' });
  }
};

// ---------- Superadmin ----------
const ESTADOS = ['pendiente', 'aprobada', 'rechazada', 'instalada'];
const publica = (s) => {
  if (!s) return s;
  const { wifi_pass_1_cif, wifi_pass_2_cif, mqtt_pass_cif, ...r } = s;
  return { ...r, codigo: sol.codigo(s.id), tipo_nombre: (sol.TIPOS[s.tipo_maquina] || sol.TIPOS.OTRA).nombre,
    tiene_wifi_pass: !!wifi_pass_1_cif, tiene_wifi_pass_2: !!wifi_pass_2_cif, tiene_mqtt_pass: !!mqtt_pass_cif };
};

// Privacidad: las claves de WiFi de solicitudes rechazadas o abandonadas (más de 90 días) se borran.
async function limpiarViejas() {
  await pool.query(`UPDATE solicitudes_maquina SET wifi_pass_1_cif = NULL, wifi_pass_2_cif = NULL
    WHERE (wifi_pass_1_cif IS NOT NULL OR wifi_pass_2_cif IS NOT NULL)
      AND (estado IN ('rechazada', 'instalada') OR (estado = 'pendiente' AND creado_en < now() - interval '90 days'))`);
}

// GET /api/superadmin/solicitudes?estado=pendiente&q=
const listar = async (req, res) => {
  try {
    await sol.asegurarTabla();
    await limpiarViejas();
    const vals = [], where = [];
    if (ESTADOS.includes(req.query.estado)) { vals.push(req.query.estado); where.push(`estado = $${vals.length}`); }
    if (req.query.q) { vals.push(`%${txt(req.query.q, 60)}%`); where.push(`(nombre ILIKE $${vals.length} OR lugar ILIKE $${vals.length} OR email ILIKE $${vals.length} OR distrito ILIKE $${vals.length} OR machine_id ILIKE $${vals.length})`); }
    const r = await pool.query(`SELECT * FROM solicitudes_maquina ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY creado_en DESC LIMIT 300`, vals);
    const c = await pool.query('SELECT estado, count(*)::int AS n FROM solicitudes_maquina GROUP BY 1');
    res.json({ success: true, conteo: Object.fromEntries(ESTADOS.map((e) => [e, (c.rows.find((x) => x.estado === e) || {}).n || 0])),
      solicitudes: r.rows.map(publica) });
  } catch (e) { console.error('[solicitudes] listar:', e.message); res.status(500).json({ success: false, message: 'Error del servidor' }); }
};

// GET /api/superadmin/solicitudes/:id  → ficha + sugerencias para aprobar
const ver = async (req, res) => {
  try {
    await sol.asegurarTabla();
    const s = (await pool.query('SELECT * FROM solicitudes_maquina WHERE id = $1', [req.params.id])).rows[0];
    if (!s) return res.status(404).json({ success: false, message: 'No existe esa solicitud.' });
    const dueno = (await pool.query(`SELECT id, nombre, email, rol FROM usuarios_duenos WHERE lower(email) = $1 LIMIT 1`, [s.email])).rows[0] || null;
    const conKymez = await kymez.tiene('cuentas_cobro', 'id');
    const cuentas = conKymez ? (await pool.query(`SELECT c.id, c.descripcion, COALESCE(c.activa, true) AS activa,
        (SELECT count(*)::int FROM kymez.maquinas m WHERE m.cuenta_cobro_id = c.id) AS maquinas
      FROM kymez.cuentas_cobro c ORDER BY c.id`)).rows : [];
    const otras = (await pool.query(`SELECT id, estado, lugar, machine_id, cuenta_cobro_id FROM solicitudes_maquina
      WHERE id <> $1 AND (cobro_numero = $2 OR lower(email) = $3) ORDER BY id DESC LIMIT 10`, [s.id, s.cobro_numero, s.email])).rows
      .map((o) => ({ ...o, codigo: sol.codigo(o.id) }));
    // Si otra solicitud del mismo número ya tiene celular de cobro, se sugiere el mismo (un Yape = una cuenta)
    const mismaCuenta = otras.find((o) => o.cuenta_cobro_id);
    res.json({ success: true, solicitud: publica(s),
      sugerencias: {
        machine_id: s.machine_id || await sol.siguienteId(s.tipo_maquina),
        nombre_maquina: `${s.lugar}`.slice(0, 60),
        dueno_existente: dueno,
        cuenta_cobro: mismaCuenta ? { modo: 'existente', id: mismaCuenta.cuenta_cobro_id,
          motivo: `Ese número de Yape ya cobra para ${mismaCuenta.codigo} (${mismaCuenta.cuenta_cobro_id}): un mismo Yape debe ser una sola cuenta.` }
          : { modo: 'nueva', descripcion: `Yape ${s.lugar}`.slice(0, 80) },
      },
      cuentas_cobro: cuentas, relacionadas: otras, kymez_disponible: conKymez });
  } catch (e) { console.error('[solicitudes] ver:', e.message); res.status(500).json({ success: false, message: 'Error del servidor' }); }
};

// POST /api/superadmin/solicitudes/:id/ver-claves → claves en claro (queda en Auditoría)
const verClaves = async (req, res) => {
  try {
    const s = (await pool.query('SELECT * FROM solicitudes_maquina WHERE id = $1', [req.params.id])).rows[0];
    if (!s) return res.status(404).json({ success: false, message: 'No existe esa solicitud.' });
    await auditoria.registrar({ usuario: req.superadmin.email, accion: 'solicitud_claves_vistas', machine_id: s.machine_id, detalle: { solicitud: sol.codigo(s.id) } });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, wifi_ssid_1: s.wifi_ssid_1, wifi_pass_1: descifrar(s.wifi_pass_1_cif), wifi_ssid_2: s.wifi_ssid_2,
      wifi_pass_2: descifrar(s.wifi_pass_2_cif),
      mqtt: s.machine_id ? { usuario: s.machine_id, clave: descifrar(s.mqtt_pass_cif), permiso: `vending/${s.machine_id}/#` } : null });
  } catch (e) { console.error('[solicitudes] claves:', e.message); res.status(500).json({ success: false, message: 'No se pudieron leer las claves (¿cambió JWT_SECRET o SOLICITUDES_CLAVE?).' }); }
};

// POST /api/superadmin/solicitudes/:id/aprobar
//   { machine_id, nombre_maquina, dueno: { modo: 'existente'|'crear', email? },
//     cuenta_cobro: { modo: 'nueva'|'existente'|'ninguna', id?, descripcion? } }
const aprobar = async (req, res) => {
  const b = req.body || {};
  const cli = await pool.connect();
  try {
    await sol.asegurarTabla();
    await cli.query('BEGIN');
    const s = (await cli.query('SELECT * FROM solicitudes_maquina WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!s) { await cli.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'No existe esa solicitud.' }); }
    if (s.estado !== 'pendiente') { await cli.query('ROLLBACK'); return res.status(409).json({ success: false, message: `La solicitud ya está ${s.estado}.` }); }

    // 1) ID de la placa
    const machineId = identidad.limpiar(b.machine_id) || await sol.siguienteId(s.tipo_maquina, cli);
    const problema = identidad.validarEquipo(machineId);
    if (problema) { await cli.query('ROLLBACK'); return res.status(400).json({ success: false, message: problema }); }
    if (await identidad.equipoOcupado(cli, machineId)) { await cli.query('ROLLBACK'); return res.status(409).json({ success: false, message: `Ya existe una máquina ${machineId}.` }); }

    // 2) Dueño
    const d = b.dueno || {};
    const email = correo(d.email || s.email);
    if (!email) { await cli.query('ROLLBACK'); return res.status(400).json({ success: false, message: 'Correo del dueño inválido.' }); }
    let dueno = (await cli.query('SELECT id, nombre, email, rol FROM usuarios_duenos WHERE lower(email) = $1 ORDER BY id LIMIT 1', [email])).rows[0];
    let duenoCreado = false;
    if (!dueno) {
      if (d.modo === 'existente') { await cli.query('ROLLBACK'); return res.status(404).json({ success: false, message: `No hay una cuenta de QhaPay con ${email}.` }); }
      dueno = (await cli.query(`INSERT INTO usuarios_duenos (nombre, email, password, rol) VALUES ($1, $2, $3, 'dueno') RETURNING id, nombre, email, rol`,
        [s.nombre, email, clave.MARCA_GOOGLE])).rows[0];
      duenoCreado = true;
    } else if (dueno.rol === 'eliminado' || dueno.rol === 'superadmin') {
      await cli.query('ROLLBACK'); return res.status(409).json({ success: false, message: `La cuenta ${email} no puede ser dueña de máquinas (${dueno.rol}).` });
    }

    // 3) Máquina en QhaPay
    const nombre = txt(b.nombre_maquina, 60) || s.lugar.slice(0, 60);
    const cols = ['machine_id', 'code', 'name', 'id_dueno', 'location', 'brand', 'model', 'layout'];
    const vals = [machineId, machineId, nombre, String(dueno.id), `${s.lugar} · ${s.direccion || ''}`.slice(0, 200),
      (sol.TIPOS[s.tipo_maquina] || sol.TIPOS.OTRA).nombre, (s.datos && s.datos.modelo) || null, '[]'];
    for (const [col, v] of [['distrito', s.distrito], ['ciudad', s.ciudad], ['referencia', s.datos && s.datos.referencia], ['ubicacion', s.lugar]]) {
      if (await columnaExiste('maquinas', col)) { cols.push(col); vals.push(v || null); }
    }
    await cli.query(`INSERT INTO maquinas (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, vals);

    // 4) Celular de cobro
    const cc = b.cuenta_cobro || { modo: 'nueva' };
    let cuentaId = null;
    const conKymez = await kymez.tiene('cuentas_cobro', 'id');
    if (cc.modo !== 'ninguna' && conKymez) {
      if (!kymez.ID_KYMEZ.test(machineId)) { await cli.query('ROLLBACK'); return res.status(400).json({ success: false, message: `${machineId} no tiene formato de placa KYMEZ.` }); }
      if (cc.modo === 'existente') {
        cuentaId = txt(cc.id, 40);
        const ok = (await cli.query('SELECT 1 FROM kymez.cuentas_cobro WHERE id = $1', [cuentaId])).rowCount;
        if (!ok) { await cli.query('ROLLBACK'); return res.status(404).json({ success: false, message: `No existe el celular de cobro ${cuentaId}.` }); }
      } else {
        cuentaId = txt(cc.id, 40);
        if (!cuentaId) {
          const n = (await cli.query(`SELECT COALESCE(max(substring(id FROM '^cel-([0-9]+)$')::int), 0) + 1 AS n FROM kymez.cuentas_cobro`)).rows[0].n;
          cuentaId = `cel-${n}`;
        }
        if (!/^[a-z0-9][a-z0-9_-]{1,39}$/i.test(cuentaId)) { await cli.query('ROLLBACK'); return res.status(400).json({ success: false, message: 'El id del celular solo puede tener letras, números, - o _.' }); }
        const ya = (await cli.query('SELECT 1 FROM kymez.cuentas_cobro WHERE id = $1', [cuentaId])).rowCount;
        if (ya) { await cli.query('ROLLBACK'); return res.status(409).json({ success: false, message: `${cuentaId} ya existe: elige "existente" o deja el id vacío.` }); }
        const conDesc = await kymez.tiene('cuentas_cobro', 'descripcion');
        await cli.query(conDesc ? 'INSERT INTO kymez.cuentas_cobro (id, descripcion) VALUES ($1, $2)' : 'INSERT INTO kymez.cuentas_cobro (id) VALUES ($1)',
          conDesc ? [cuentaId, txt(cc.descripcion, 80) || `Yape ${s.lugar}`.slice(0, 80)] : [cuentaId]);
      }
      const kmCols = (await kymez.estructura()).get('maquinas') || new Set();
      const extra = [];
      if (kmCols.has('activa')) extra.push(['activa', true]);
      if (kmCols.has('firma_version')) extra.push(['firma_version', 1]);
      if (kmCols.has('monto_unico')) extra.push(['monto_unico', false]);
      await cli.query(`INSERT INTO kymez.maquinas (machine_id, cuenta_cobro_id${extra.map(([k]) => ', ' + k).join('')})
        VALUES ($1, $2${extra.map((_, i) => `, $${i + 3}`).join('')})
        ON CONFLICT (machine_id) DO UPDATE SET cuenta_cobro_id = EXCLUDED.cuenta_cobro_id`, [machineId, cuentaId, ...extra.map(([, v]) => v)]);
    }

    // 5) Clave MQTT de la placa (la pones igual en HiveMQ)
    const mqttPass = crypto.randomBytes(18).toString('base64url');
    await cli.query(`UPDATE solicitudes_maquina SET estado = 'aprobada', machine_id = $2, cuenta_cobro_id = $3, id_dueno = $4,
        mqtt_pass_cif = $5, revisado_por = $6, revisado_en = now(), actualizado_en = now(), notas_internas = COALESCE($7, notas_internas)
      WHERE id = $1`, [s.id, machineId, cuentaId, String(dueno.id), cifrar(mqttPass), req.superadmin.email, txt(b.notas, 500) || null]);
    await cli.query('COMMIT');
    kymez.olvidar();
    await auditoria.registrar({ usuario: req.superadmin.email, accion: 'solicitud_aprobada', machine_id: machineId,
      detalle: { solicitud: sol.codigo(s.id), dueno: email, dueno_creado: duenoCreado, cuenta_cobro: cuentaId } });
    res.json({ success: true, machine_id: machineId, cuenta_cobro_id: cuentaId, dueno: { ...dueno, creado: duenoCreado },
      hivemq: { usuario: machineId, permiso: `vending/${machineId}/#` },
      message: `Aprobada: ${machineId}${cuentaId ? ` cobra con ${cuentaId}` : ''}.${duenoCreado ? ` Se creó la cuenta de ${email} (entra con Google o con "¿Olvidaste tu contraseña?").` : ''}` });
  } catch (e) {
    await cli.query('ROLLBACK').catch(() => {});
    console.error('[solicitudes] aprobar:', e.message);
    res.status(500).json({ success: false, message: 'Error del servidor' });
  } finally { cli.release(); }
};

// GET /api/superadmin/solicitudes/:id/maquina.h  → archivo para include/ del firmware
const maquinaH = async (req, res) => {
  try {
    const s = (await pool.query('SELECT * FROM solicitudes_maquina WHERE id = $1', [req.params.id])).rows[0];
    if (!s) return res.status(404).json({ success: false, message: 'No existe esa solicitud.' });
    if (!['aprobada', 'instalada'].includes(s.estado) || !s.machine_id) return res.status(409).json({ success: false, message: 'Primero aprueba la solicitud.' });
    let precios = [];
    if (sol.PERFIL_NECTA[s.tipo_maquina] && sol.PERFIL_NECTA[s.tipo_maquina].preciosPropios) {
      precios = (await pool.query(`SELECT codigo_motor, precio FROM inventario WHERE machine_id = $1 AND codigo_motor ~ '^[0-9]{1,3}$' AND precio > 0 ORDER BY codigo_motor::int`, [s.machine_id]))
        .rows.map((p) => ({ producto: Number(p.codigo_motor), centimos: Math.round(Number(p.precio) * 100) }));
    }
    const { texto, avisos } = sol.generarMaquinaH(s, { wifi1: descifrar(s.wifi_pass_1_cif), wifi2: descifrar(s.wifi_pass_2_cif), mqtt: descifrar(s.mqtt_pass_cif) },
      { soporte: SOPORTE(), precios });
    await auditoria.registrar({ usuario: req.superadmin.email, accion: 'solicitud_maquina_h', machine_id: s.machine_id, detalle: { solicitud: sol.codigo(s.id), avisos } });
    res.set('Cache-Control', 'no-store');
    if (req.query.formato === 'json') return res.json({ success: true, nombre_archivo: 'maquina.h', texto, avisos });
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="maquina.h"');
    res.set('X-Avisos', encodeURIComponent(JSON.stringify(avisos)));
    res.send(texto);
  } catch (e) { console.error('[solicitudes] maquina.h:', e.message); res.status(500).json({ success: false, message: 'Error del servidor' }); }
};

// POST /api/superadmin/solicitudes/:id/rechazar { motivo }
const rechazar = async (req, res) => {
  try {
    const r = await pool.query(`UPDATE solicitudes_maquina SET estado = 'rechazada', motivo_rechazo = $2, revisado_por = $3, revisado_en = now(),
        actualizado_en = now(), wifi_pass_1_cif = NULL, wifi_pass_2_cif = NULL
      WHERE id = $1 AND estado = 'pendiente' RETURNING id`, [req.params.id, txt((req.body || {}).motivo, 300) || null, req.superadmin.email]);
    if (!r.rowCount) return res.status(409).json({ success: false, message: 'Solo se puede rechazar una solicitud pendiente.' });
    await auditoria.registrar({ usuario: req.superadmin.email, accion: 'solicitud_rechazada', detalle: { solicitud: sol.codigo(req.params.id) } });
    res.json({ success: true, message: 'Solicitud rechazada. Se borró la contraseña del WiFi.' });
  } catch (e) { console.error('[solicitudes] rechazar:', e.message); res.status(500).json({ success: false, message: 'Error del servidor' }); }
};

// POST /api/superadmin/solicitudes/:id/instalada → borra la contraseña del WiFi
const instalada = async (req, res) => {
  try {
    const r = await pool.query(`UPDATE solicitudes_maquina SET estado = 'instalada', instalada_en = now(), actualizado_en = now(),
        wifi_pass_1_cif = NULL, wifi_pass_2_cif = NULL
      WHERE id = $1 AND estado = 'aprobada' RETURNING machine_id`, [req.params.id]);
    if (!r.rowCount) return res.status(409).json({ success: false, message: 'Solo una solicitud aprobada se puede marcar como instalada.' });
    await auditoria.registrar({ usuario: req.superadmin.email, accion: 'solicitud_instalada', machine_id: r.rows[0].machine_id, detalle: { solicitud: sol.codigo(req.params.id) } });
    res.json({ success: true, message: 'Marcada como instalada. Se borró la contraseña del WiFi.' });
  } catch (e) { console.error('[solicitudes] instalada:', e.message); res.status(500).json({ success: false, message: 'Error del servidor' }); }
};

// PUT /api/superadmin/solicitudes/:id/notas { notas }
const notas = async (req, res) => {
  try {
    const r = await pool.query('UPDATE solicitudes_maquina SET notas_internas = $2, actualizado_en = now() WHERE id = $1 RETURNING id', [req.params.id, txt((req.body || {}).notas, 1000) || null]);
    if (!r.rowCount) return res.status(404).json({ success: false, message: 'No existe esa solicitud.' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: 'Error del servidor' }); }
};

module.exports = { crear, listar, ver, verClaves, aprobar, maquinaH, rechazar, instalada, notas, validar };
