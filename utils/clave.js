// utils/clave.js
// Contraseñas guardadas con hash (scrypt, incluido en Node: no hace falta instalar nada).
// Antes se guardaban tal cual en usuarios_duenos.password. Las que siguen en texto plano se
// convierten solas al hash la próxima vez que esa persona inicia sesión con la contraseña correcta.
//
// Formato guardado:  scrypt$16384$8$1$<sal base64>$<hash base64>
const crypto = require('crypto');

const N = 16384, R = 8, P = 1, LARGO = 64;
const MARCA_GOOGLE = 'google_oauth';   // cuentas creadas con Google (no tienen contraseña)

function scrypt(clave, sal, n = N, r = R, p = P) {
  return new Promise((ok, mal) => crypto.scrypt(String(clave), sal, LARGO, { N: n, r, p, maxmem: 64 * 1024 * 1024 },
    (e, h) => (e ? mal(e) : ok(h))));
}

const esHash = (guardada) => typeof guardada === 'string' && guardada.startsWith('scrypt$');

async function hashear(clave) {
  const sal = crypto.randomBytes(16);
  const h = await scrypt(clave, sal);
  return `scrypt$${N}$${R}$${P}$${sal.toString('base64')}$${h.toString('base64')}`;
}

// Compara en tiempo constante (no deja adivinar la contraseña midiendo cuánto tarda)
function iguales(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) { crypto.timingSafeEqual(x, x); return false; }
  return crypto.timingSafeEqual(x, y);
}

/**
 * ¿La contraseña escrita coincide con la guardada?
 * Devuelve { ok, migrar }: migrar = true si estaba en texto plano y hay que guardarla con hash.
 */
async function verificar(clave, guardada) {
  if (clave == null || guardada == null || guardada === '' || guardada === MARCA_GOOGLE) return { ok: false, migrar: false };
  if (esHash(guardada)) {
    const partes = guardada.split('$');
    if (partes.length !== 6) return { ok: false, migrar: false };
    const [, n, r, p, salB64, hB64] = partes;
    const esperado = Buffer.from(hB64, 'base64');
    const h = await scrypt(clave, Buffer.from(salB64, 'base64'), Number(n), Number(r), Number(p));
    return { ok: h.length === esperado.length && crypto.timingSafeEqual(h, esperado), migrar: false };
  }
  const ok = iguales(clave, guardada);   // cuenta antigua, contraseña en texto plano
  return { ok, migrar: ok };
}

// Reglas mínimas para contraseñas nuevas
function validarNueva(clave) {
  const c = String(clave || '');
  if (c.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  if (c.length > 128) return 'La contraseña es demasiado larga.';
  return null;
}

module.exports = { hashear, verificar, esHash, validarNueva, MARCA_GOOGLE };
