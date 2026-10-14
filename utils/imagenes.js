// utils/imagenes.js
// Las fotos de productos siguen guardadas en productos_almacen.image_url (Base64), pero ya
// NO viajan dentro de las listas: se sirven aparte en /api/productos-almacen/:id/imagen,
// con caché del navegador de 1 año (la URL cambia cuando cambia la foto).
const crypto = require('crypto');

let sharp = null;
try { sharp = require('sharp'); } catch { /* sin sharp: se guarda la foto tal como llega */ }

const LADO_MAX = Number(process.env.IMAGEN_LADO_MAX || 400);
const CALIDAD = Number(process.env.IMAGEN_CALIDAD || 72);

const RE_URL_PROPIA = /\/api\/productos-almacen\/[^/]+\/imagen(\?|$)/;

/** "data:image/png;base64,AAAA" -> { mime, buffer } */
function leerDataUrl(texto) {
  if (typeof texto !== 'string') return null;
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(texto);
  if (!m) return null;
  const buffer = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  return { mime: m[1] || 'application/octet-stream', buffer };
}

const version = (texto) => crypto.createHash('md5').update(String(texto)).digest('hex').slice(0, 10);

/** true si el frontend nos devolvió la URL que nosotros mismos le dimos (no es una foto nueva). */
const esUrlPropia = (texto) => typeof texto === 'string' && RE_URL_PROPIA.test(texto);

/** Reduce una foto Base64 a LADO_MAX px en WebP. Si no se puede, la devuelve igual. */
async function optimizar(dataUrl) {
  const img = leerDataUrl(dataUrl);
  if (!img || !sharp || !img.mime.startsWith('image/') || img.mime === 'image/svg+xml') return dataUrl;
  try {
    const salida = await sharp(img.buffer, { failOn: 'none' })
      .rotate()                                           // respeta la orientación de la cámara
      .resize(LADO_MAX, LADO_MAX, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: CALIDAD })
      .toBuffer();
    // Solo reemplaza si de verdad pesa menos
    if (salida.length >= img.buffer.length) return dataUrl;
    return `data:image/webp;base64,${salida.toString('base64')}`;
  } catch (e) {
    console.error('[imagenes] no se pudo optimizar, se guarda original:', e.message);
    return dataUrl;
  }
}

/**
 * Decide qué guardar en image_url a partir de lo que mandó el frontend.
 * Devuelve undefined si NO hay que tocar la columna.
 */
async function prepararParaGuardar(valor) {
  if (valor === undefined) return undefined;              // no lo mandaron: no se toca
  if (esUrlPropia(valor)) return undefined;               // es nuestra URL: la foto no cambió
  if (valor === null || valor === '') return { image_url: null, imagen_version: null };
  if (typeof valor === 'string' && valor.startsWith('data:')) {
    const final = await optimizar(valor);
    return { image_url: final, imagen_version: version(final) };
  }
  return { image_url: String(valor), imagen_version: version(valor) };   // URL externa
}

/** Base pública del servidor (https://vending-api-server.onrender.com). */
function base(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const host = req.get('host') || '';
  // Render siempre sirve por https: así la app (https) nunca recibe una foto "http" bloqueada
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  return `${local ? req.protocol : 'https'}://${host}`;
}

/** URL de la foto para el frontend, o null si el producto no tiene foto. */
function urlImagen(req, idProducto, tieneImagen, ver) {
  if (!tieneImagen || idProducto == null) return null;
  return `${base(req)}/api/productos-almacen/${encodeURIComponent(idProducto)}/imagen?v=${ver || 'x'}`;
}

module.exports = { leerDataUrl, version, esUrlPropia, optimizar, prepararParaGuardar, urlImagen, sharpDisponible: () => !!sharp };
