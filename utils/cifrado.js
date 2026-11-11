// utils/cifrado.js  (v3.6.6)
// Cifra datos sensibles guardados en la base (contraseñas de WiFi de las solicitudes y la clave
// MQTT de cada máquina). AES-256-GCM. La llave sale de SOLICITUDES_CLAVE (64 hex) o, si no está,
// se deriva de JWT_SECRET (HKDF). Si cambias cualquiera de las dos, lo ya guardado no se puede leer.
const crypto = require('crypto');

let llave = null;
function obtenerLlave() {
  if (llave) return llave;
  const hex = process.env.SOLICITUDES_CLAVE;
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) llave = Buffer.from(hex, 'hex');
  else {
    const base = process.env.JWT_SECRET;
    if (!base) throw new Error('Falta JWT_SECRET (o SOLICITUDES_CLAVE) para cifrar');
    llave = Buffer.from(crypto.hkdfSync('sha256', base, 'qhapay', 'solicitudes-v1', 32));
  }
  return llave;
}

function cifrar(texto) {
  if (texto === null || texto === undefined || texto === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', obtenerLlave(), iv);
  const ct = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function descifrar(guardado) {
  if (!guardado) return null;
  if (!String(guardado).startsWith('v1:')) throw new Error('formato desconocido');
  const b = Buffer.from(String(guardado).slice(3), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', obtenerLlave(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

module.exports = { cifrar, descifrar };
