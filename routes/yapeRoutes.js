const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { recibirPagoYape } = require('../controllers/paymentController');
const { esEquipoLegado } = require('../utils/equipoLegado');

// Webhook ANTIGUO de Yape: MacroDroid → este servidor → broker público → máquina ESP32 v1
// (por ejemplo, Snakky Becall). Las placas KYMEZ cobran por kymez-pagos y NO usan esta ruta.
//
// v3.6 · Sigue funcionando IGUAL para las máquinas antiguas, sin tocar MacroDroid:
//   - Sin YAPE_WEBHOOK_CLAVE en Render: solo acepta máquinas registradas en QhaPay que sean
//     equipo antiguo (no KYMEZ). Antes aceptaba cualquier ID.
//   - Con YAPE_WEBHOOK_CLAVE (mínimo 24 caracteres): además exige que MacroDroid mande el
//     encabezado "x-clave: <clave>" o "Authorization: Bearer <clave>". Recomendado cuando puedas
//     editar la macro del celular de esa máquina.
const CLAVE = process.env.YAPE_WEBHOOK_CLAVE || '';

function claveCorrecta(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.get('authorization') || '').trim());
  const dada = String(req.get('x-clave') || (m && m[1]) || '');
  if (!dada) return false;
  const a = Buffer.from(dada), b = Buffer.from(CLAVE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post('/:machine_id', async (req, res, next) => {
  try {
    if (CLAVE.length >= 24 && !claveCorrecta(req)) return res.status(401).send('Clave incorrecta');
    if (!(await esEquipoLegado(req.params.machine_id))) {
      console.warn(`[webhook yape] rechazado: ${String(req.params.machine_id).slice(0, 40)} no es una máquina antigua registrada`);
      return res.status(404).send('Máquina no registrada');
    }
    next();
  } catch (e) {
    console.error('[webhook yape]', e.message);
    res.status(500).send('Error del servidor');
  }
}, express.text({ type: '*/*' }), recibirPagoYape);

module.exports = router;
