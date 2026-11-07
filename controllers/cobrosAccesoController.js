// controllers/cobrosAccesoController.js  (v3.6.1) · ver utils/cobrosAcceso.js
const acceso = require('../utils/cobrosAcceso');
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
  res.json({ success: true, requiere_codigo: !(u.superadmin || sinCodigo(u)), minutos_abierto: acceso.MINUTOS_ABIERTO });
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

// ---------- Superadmin ----------

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

module.exports = { estado, abrir, generar, listar, anular };
