// utils/limite.js
// Freno contra quien prueba contraseñas una y otra vez: después de varios intentos fallidos
// en poco tiempo, ese correo (o esa IP) queda en espera unos minutos. Vive en memoria.
const VENTANA_MS = 15 * 60 * 1000;
const MAX_POR_CORREO = 8;
const MAX_POR_IP = 30;

const fallos = new Map();   // clave -> { n, desde }

function cuenta(clave) {
  const f = fallos.get(clave);
  if (!f) return 0;
  if (Date.now() - f.desde > VENTANA_MS) { fallos.delete(clave); return 0; }
  return f.n;
}

function sumar(clave) {
  const f = fallos.get(clave);
  if (!f || Date.now() - f.desde > VENTANA_MS) fallos.set(clave, { n: 1, desde: Date.now() });
  else f.n += 1;
  if (fallos.size > 20000) fallos.clear();
}

const claves = (req, email) => [`c:${String(email || '').toLowerCase()}`, `ip:${req.ip}`];

// ¿Puede intentar? Si no, cuántos minutos le faltan.
function bloqueado(req, email) {
  const [c, ip] = claves(req, email);
  if (cuenta(c) >= MAX_POR_CORREO || cuenta(ip) >= MAX_POR_IP) {
    const f = fallos.get(cuenta(c) >= MAX_POR_CORREO ? c : ip);
    return Math.max(1, Math.ceil((VENTANA_MS - (Date.now() - f.desde)) / 60000));
  }
  return 0;
}

function fallo(req, email) { claves(req, email).forEach(sumar); }
function exito(req, email) { fallos.delete(claves(req, email)[0]); }

module.exports = { bloqueado, fallo, exito };
