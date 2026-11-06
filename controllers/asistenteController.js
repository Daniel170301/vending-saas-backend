// controllers/asistenteController.js  (v3.6) · ver services/asistente.js
const asistente = require('../services/asistente');

const TIPOS_IMAGEN = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_BASE64 = 7 * 1024 * 1024;   // ~5 MB de imagen

const SUGERENCIAS_DUENO = [
  { icono: 'camera', texto: 'Registrar un gasto con foto', mensaje: 'Quiero registrar un gasto. Te mando la foto del comprobante.', pide_foto: true },
  { icono: 'receipt', texto: 'Registrar compra de mercadería', mensaje: 'Quiero registrar una compra de mercadería.', pide_foto: true },
  { icono: 'package', texto: 'Abastecer una máquina', mensaje: 'Quiero abastecer una máquina.' },
  { icono: 'chart', texto: '¿Cuánto vendí esta semana?', mensaje: '¿Cuánto vendí esta semana y qué fue lo más vendido?' },
];
const SUGERENCIAS_OPERARIO = [
  { icono: 'package', texto: 'Abastecer una máquina', mensaje: 'Quiero abastecer una máquina.' },
  { icono: 'search', texto: '¿Qué le falta a una máquina?', mensaje: '¿Qué resortes tienen poco stock en mis máquinas?' },
];

function puedeUsar(req) {
  if (!req.usuario) return 'Inicia sesión para usar el asistente.';
  if (req.usuario.operario && !req.usuario.id) return 'Primero escribe el código que te dio el dueño.';
  return null;
}

// GET /api/asistente/estado
const estado = async (req, res) => {
  const no = puedeUsar(req);
  let restantes = null;
  try { if (!no && asistente.activo()) restantes = Math.max(0, asistente.LIMITE_DIA - await asistente.mensajesHoy(req)); } catch { /* sin tabla aún */ }
  res.json({
    success: true,
    activo: asistente.activo(),
    puede_usar: !no,
    motivo: no,
    nombre: 'Asistente QhaPay',
    mensajes_restantes_hoy: restantes,
    sugerencias: req.usuario && req.usuario.operario ? SUGERENCIAS_OPERARIO : SUGERENCIAS_DUENO,
  });
};

// POST /api/asistente/mensaje { mensajes: [{ rol: "usuario"|"asistente", texto }], imagen?: { media_type, data } }
const mensaje = async (req, res) => {
  const no = puedeUsar(req);
  if (no) return res.status(403).json({ success: false, message: no });
  if (!asistente.activo()) return res.status(503).json({ success: false, message: 'El asistente todavía no está activado.' });
  const b = req.body || {};
  let imagen = null;
  if (b.imagen) {
    const mt = String(b.imagen.media_type || '').toLowerCase();
    const data = String(b.imagen.data || '').replace(/^data:[^,]+,/, '');
    if (!TIPOS_IMAGEN.has(mt) || !data || data.length > MAX_BASE64 || !/^[A-Za-z0-9+/=\s]+$/.test(data.slice(0, 200))) {
      return res.status(400).json({ success: false, message: 'La foto debe ser JPG, PNG o WEBP de menos de 5 MB.' });
    }
    imagen = { media_type: mt, data };
  }
  try {
    if (await asistente.mensajesHoy(req) >= asistente.LIMITE_DIA) {
      return res.status(429).json({ success: false, message: 'Llegaste al límite de mensajes del asistente por hoy. Mañana se renueva.' });
    }
    const r = await asistente.conversar(req, b.mensajes, imagen);
    await asistente.sumarUso(req, r.uso.entrada, r.uso.salida).catch((e) => console.warn('[asistente] uso:', e.message));
    res.json({ success: true, respuesta: r.respuesta, propuestas: r.propuestas });
  } catch (e) {
    console.error('[asistente] mensaje:', e.status || '', e.message);
    const status = e.status === 429 || e.status === 529 ? 503 : 502;
    res.status(status).json({ success: false, message: 'El asistente no está disponible en este momento. Intenta de nuevo en un rato.' });
  }
};

// POST /api/asistente/confirmar { accion, datos }  → guarda de verdad (con las rutas normales)
const confirmar = async (req, res) => {
  const no = puedeUsar(req);
  if (no) return res.status(403).json({ success: false, message: no });
  const b = req.body || {};
  const accion = String(b.accion || '');
  if (req.usuario.operario && accion !== 'abastecimiento') {
    return res.status(403).json({ success: false, message: 'Tu cuenta de operario solo puede abastecer.' });
  }
  const v = asistente.validar(accion, b.datos || {}, req);
  if (v.error) return res.status(400).json({ success: false, message: v.error });
  try {
    const r = await asistente.ejecutar(req, accion, v.datos);
    res.status(r.ok ? 200 : 400).json({ success: r.ok, message: r.mensaje });
  } catch (e) {
    console.error('[asistente] confirmar:', e.message);
    res.status(500).json({ success: false, message: 'No se pudo guardar. Intenta de nuevo.' });
  }
};

module.exports = { estado, mensaje, confirmar };
