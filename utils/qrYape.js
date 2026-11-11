// utils/qrYape.js  (v3.6.6)
// Revisa el texto de un QR de pago (formato EMV de Yape/Plin): empieza con 000201 y termina en
// 6304 + CRC-16/CCITT-FALSE de todo lo anterior. Así no se graba en la placa un QR mal copiado.
function crc16(texto) {
  let crc = 0xFFFF;
  for (const ch of Buffer.from(texto, 'utf8')) {
    crc ^= ch << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** { ok, motivo? } */
function revisarQr(texto) {
  const t = String(texto || '').trim();
  if (!t) return { ok: false, motivo: 'vacío' };
  if (t.length > 512) return { ok: false, motivo: 'demasiado largo' };
  if (!t.startsWith('000201')) return { ok: false, motivo: 'no es un QR de pago (no empieza con 000201)' };
  const m = /6304([0-9A-Fa-f]{4})$/.exec(t);
  if (!m) return { ok: false, motivo: 'no termina con el código de control (6304....)' };
  if (crc16(t.slice(0, -4)).toUpperCase() !== m[1].toUpperCase()) return { ok: false, motivo: 'el código de control no coincide (QR mal copiado)' };
  return { ok: true };
}

module.exports = { crc16, revisarQr };
