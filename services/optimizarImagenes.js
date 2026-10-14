// services/optimizarImagenes.js
// Reduce las fotos YA guardadas (800 px, 50-150 KB) a 400 px WebP (10-25 KB).
// Dos formas de correrlo, una sola vez:
//   a) Render -> Shell:  npm run optimizar-imagenes
//   b) Variable de entorno OPTIMIZAR_IMAGENES_AL_INICIAR=true, deploy, y luego quitarla.
const pool = require('../config/database');
const img = require('../utils/imagenes');
const { columnaExiste } = require('../utils/esquema');

const MIN_BYTES = 30 * 1024;   // solo las que pesan más de 30 KB

async function optimizarImagenes({ log = console.log } = {}) {
  if (!img.sharpDisponible()) {
    log('[imagenes] sharp no está instalado: no se puede optimizar');
    return { revisadas: 0, optimizadas: 0, ahorro_kb: 0 };
  }
  const conVersion = await columnaExiste('productos_almacen', 'imagen_version');
  const { rows } = await pool.query(
    `SELECT id FROM productos_almacen
     WHERE image_url LIKE 'data:image%' AND octet_length(image_url) > $1 ORDER BY id`, [MIN_BYTES]);
  log(`[imagenes] ${rows.length} foto(s) por optimizar`);

  let optimizadas = 0;
  let ahorro = 0;
  for (const { id } of rows) {        // de una en una: no carga la memoria del servidor
    try {
      const r = await pool.query('SELECT image_url FROM productos_almacen WHERE id = $1', [id]);
      const original = r.rows[0]?.image_url;
      if (!original) continue;
      const nueva = await img.optimizar(original);
      if (nueva === original) continue;
      await pool.query(
        `UPDATE productos_almacen SET image_url = $1${conVersion ? ', imagen_version = $3' : ''} WHERE id = $2`,
        conVersion ? [nueva, id, img.version(nueva)] : [nueva, id]);
      optimizadas++;
      ahorro += original.length - nueva.length;
    } catch (e) {
      log(`[imagenes] producto ${id}: ${e.message}`);
    }
  }
  const resumen = { revisadas: rows.length, optimizadas, ahorro_kb: Math.round((ahorro * 0.75) / 1024) };
  log(`[imagenes] listo: ${optimizadas}/${rows.length} optimizadas, ahorro ≈ ${resumen.ahorro_kb} KB`);
  return resumen;
}

module.exports = { optimizarImagenes };

// Ejecución directa: node services/optimizarImagenes.js
if (require.main === module) {
  optimizarImagenes()
    .then(() => pool.end())
    .catch((e) => { console.error(e); process.exit(1); });
}
