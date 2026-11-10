// controllers/cobrosAccesoController.js  (v3.6.1 · v3.6.5) · ver utils/cobrosAcceso.js y utils/cobrosVinculo.js
const acceso = require('../utils/cobrosAcceso');
const vinculo = require('../utils/cobrosVinculo');
const kymez = require('../services/kymez');
const pool = require('../config/database');
const limite = require('../utils/limite');
const auditoria = require('../utils/auditoria');

// ---------- Dueño / superadmin (desde la app) ----------

// v3.6.2: correos que entran sin código (por ejemplo, la cuenta de prueba para la revisión de Google Play).
// En Render: COBROS_SIN_CODIGO=revision.qhapay@gmail.com  (varios separados por coma). Vacío = nadie.
function sinCodigo(u) {
  const lista = String(process.env.COBROS_SIN_CODIGO || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  return !!u.email && lista.includes(String(u.email).toLowerCase());
}

// GET /api/cobros/acceso → ¿necesita código?
const estado = (req, res) => {
  const u = req.usuario;
  if (u.operario || u.rol === 'operario') return res.status(403).json({ success: false, message: 'Esta pantalla no está disponible para operarios.' });
  // vinculacion: este servidor acepta POST /api/cobros/vincular (el código configura el celular solo)
  res.json({ success: true, requiere_codigo: !(u.superadmin || sinCodigo(u)), minutos_abierto: acceso.MINUTOS_ABIERTO, vinculacion: true });
};

// POST /api/cobros/acceso { codigo }
const abrir = async (req, res) => {
  const u = req.usuario;
  if (u.operario || u.rol === 'operario') return res.status(403).json({ success: false, message: 'Esta pantalla no está disponible para operarios.' });
  if (u.superadmin || sinCodigo(u)) return res.json({ success: true, minutos_abierto: acceso.MINUTOS_ABIERTO });
  const clave = `cobros:${u.id}`;
  const espera = limite.bloqueado(req, clave);
  if (espera) {
    return res.status(429).json({ success: false, message: `Demasiados intentos. Espera ${espera} minuto(s) y vuelve a probar.` });
  }
  try {
    const ok = await acceso.canjear((req.body || {}).codigo, u.email);
    if (!ok) {
      limite.fallo(req, clave);
      return res.status(400).json({ success: false, message: 'Código incorrecto, vencido o ya usado. Pide uno nuevo a KYMEZ.' });
    }
    limite.exito(req, clave);
    auditoria.registrar({ usuario: u.email, accion: 'acceso_cobros_usado', detalle: { codigo_id: ok.id, nota: ok.nota } });
    res.json({ success: true, minutos_abierto: acceso.MINUTOS_ABIERTO });
  } catch (e) {
    console.error('[cobros] acceso:', e.message);
    res.status(500).json({ success: false, message: 'Error del servidor' });
  }
};

// POST /api/cobros/vincular { codigo, equipo? }  (v3.6.5)
// El código de la cuenta (cel-N) configura el celular: devuelve la clave UNA sola vez.
// La app la pasa directo al lector del celular; no se muestra ni se guarda en la web.
const vincular = async (req, res) => {
  const u = req.usuario;
  if (u.operario || u.rol === 'operario') return res.status(403).json({ success: false, message: 'Esta pantalla no está disponible para operarios.' });
  const clave = `cobros:${u.id}`;
  const espera = limite.bloqueado(req, clave);
  if (espera) return res.status(429).json({ success: false, message: `Demasiados intentos. Espera ${espera} minuto(s) y vuelve a probar.` });
  try {
    const r = await vinculo.vincular({ codigo: (req.body || {}).codigo, email: u.email, equipo: (req.body || {}).equipo });
    if (!r) {
      limite.fallo(req, clave);
      return res.status(400).json({ success: false, message: 'Código incorrecto, vencido o ya usado. Pide uno nuevo a KYMEZ.' });
    }
    if (r.error === 'sin_kymez') return res.status(503).json({ success: false, message: 'El servidor de pagos no está disponible. Avisa a KYMEZ.' });
    if (r.error) return res.status(409).json({ success: false, message: 'Esa cuenta de cobro está desactivada. Avisa a KYMEZ.' });
    limite.exito(req, clave);
    auditoria.registrar({ usuario: u.email, accion: 'celular_vinculado', detalle: { cuenta: r.telefono, codigo_id: r.codigo_id, equipo: (req.body || {}).equipo || null } });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, cuenta: { telefono: r.telefono, nombre: r.nombre, token: r.token },
      message: `Celular vinculado a ${r.nombre}.` });
  } catch (e) {
    console.error('[cobros] vincular:', e.message);
    res.status(500).json({ success: false, message: 'Error del servidor' });
  }
};

// ---------- Superadmin ----------

// POST /api/superadmin/cuentas-yape/:id/codigo { minutos? }  (v3.6.5) → código para vincular ESE celular
const generarParaCuenta = async (req, res) => {
  try {
    if (!(await vinculo.asegurarColumnas())) return res.status(503).json({ success: false, message: 'Esta base de datos no tiene las tablas de kymez-pagos.' });
    const c = await pool.query('SELECT id, COALESCE(activa, true) AS activa FROM kymez.cuentas_cobro WHERE id = $1', [req.params.id]);
    if (!c.rowCount) return res.status(404).json({ success: false, message: 'La cuenta no existe.' });
    if (!c.rows[0].activa) return res.status(409).json({ success: false, message: 'La cuenta está desactivada: actívala primero.' });
    const b = req.body || {};
    const r = await acceso.generar({ minutos: b.minutos, nota: `Vincular ${c.rows[0].id}`, creadoPor: req.superadmin.email, cuentaId: c.rows[0].id });
    auditoria.registrar({ usuario: req.superadmin.email, accion: 'vinculo_codigo_creado', detalle: { cuenta: c.rows[0].id, codigo_id: r.id, minutos: r.minutos } });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ...r, message: 'Díctale este código al cliente: sirve una sola vez y no se vuelve a mostrar.' });
  } catch (e) {
    console.error('[cobros] código de cuenta:', e.message);
    res.status(500).json({ success: false, message: 'Error del servidor' });
  }
};

// POST /api/superadmin/cuentas-yape/:id/desvincular { modo?: 'bloquear' | 'clave_general' }  (v3.6.5)
const desvincular = async (req, res) => {
  try {
    const modo = (req.body || {}).modo === 'clave_general' ? 'clave_general' : 'bloquear';
    const r = await vinculo.desvincular(req.params.id, modo);
    if (!r) return res.status(404).json({ success: false, message: 'La cuenta no existe.' });
    auditoria.registrar({ usuario: req.superadmin.email, accion: 'celular_desvinculado', detalle: { cuenta: r.id, modo: r.modo } });
    kymez.olvidar();
    res.json({ success: true, ...r, message: modo === 'clave_general'
      ? `${r.id} vuelve a aceptar la clave general (MacroDroid).`
      : `${r.id} desvinculado: ese celular ya no puede enviar pagos. Para volver a usarlo, genera un código nuevo.` });
  } catch (e) {
    console.error('[cobros] desvincular:', e.message);
    res.status(500).json({ success: false, message: 'Error del servidor' });
  }
};

// POST /api/superadmin/cobros-codigos { minutos?, nota? } → el código se muestra UNA vez
const generar = async (req, res) => {
  try {
    const b = req.body || {};
    const r = await acceso.generar({ minutos: b.minutos, nota: b.nota, creadoPor: req.superadmin.email });
    auditoria.registrar({ usuario: req.superadmin.email, accion: 'acceso_cobros_creado', detalle: { codigo_id: r.id, minutos: r.minutos, nota: b.nota || null } });
    res.json({ success: true, ...r, message: 'Cópialo ahora: no se vuelve a mostrar.' });
  } catch (e) {
    console.error('[cobros] generar:', e.message);
    res.status(500).json({ success: false, message: 'Error del servidor' });
  }
};

// GET /api/superadmin/cobros-codigos → historial (sin los códigos)
const listar = async (_req, res) => {
  try { res.json({ success: true, codigos: await acceso.listar() }); } catch (e) {
    console.error('[cobros] listar:', e.message);
    res.status(500).json({ success: false, message: 'Error del servidor' });
  }
};

// DELETE /api/superadmin/cobros-codigos/:id → anular uno que aún no se usó
const anular = async (req, res) => {
  try {
    if (!(await acceso.anular(req.params.id))) return res.status(404).json({ success: false, message: 'Ese código ya se usó, se anuló o no existe.' });
    auditoria.registrar({ usuario: req.superadmin.email, accion: 'acceso_cobros_anulado', detalle: { codigo_id: Number(req.params.id) } });
    res.json({ success: true });
  } catch (e) {
    console.error('[cobros] anular:', e.message);
    res.status(500).json({ success: false, message: 'Error del servidor' });
  }
};

module.exports = { estado, abrir, vincular, generar, generarParaCuenta, desvincular, listar, anular };
