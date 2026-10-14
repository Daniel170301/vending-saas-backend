// controllers/warehouseController.js
const pool = require('../config/database');
const mqttService = require('../services/mqttService');
const img = require('../utils/imagenes');
const { usuarioPorEmail } = require('../utils/usuarios');

// ─────────────────────────────────────────────────────────────────────────────
// Columnas de productos_almacen SIN image_url (la foto viaja aparte, por URL).
// ─────────────────────────────────────────────────────────────────────────────
let columnasCache = null;
async function columnas() {
  if (columnasCache) return columnasCache;
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'productos_almacen'
     ORDER BY ordinal_position`);
  const lista = rows.map((r) => r.column_name).filter((c) => c !== 'image_url');
  const res = {
    lista,
    conAlias: lista.map((c) => `p."${c}"`).join(', '),
    sinAlias: lista.map((c) => `"${c}"`).join(', '),
    tieneVersion: lista.includes('imagen_version'),
  };
  if (res.tieneVersion) columnasCache = res;   // hasta que la migración agregue la columna, se vuelve a consultar
  return res;
}

/** Fila de BD -> objeto para el frontend (image_url pasa a ser una URL liviana). */
function formatear(req, fila) {
  if (!fila) return fila;
  const { tiene_imagen, ...resto } = fila;
  return { ...resto, image_url: img.urlImagen(req, fila.id, tiene_imagen, fila.imagen_version) };
}

// Campos que el frontend puede editar
const EDITABLES = ['name', 'category', 'subcategory', 'unit_cost', 'sale_price', 'stock_warehouse',
  'capacidad', 'unit_type', 'barcode', 'min_stock'];

// 1. OBTENER ALMACÉN (con modo superadmin)
const obtenerAlmacen = async (req, res) => {
  try {
    const user_id = req.query.user_id || req.query.user || req.query.email;
    const u = user_id ? await usuarioPorEmail(user_id) : null;
    const userRol = u ? u.rol : 'dueno';
    const cols = await columnas();

    let query = `
      SELECT ${cols.conAlias}, (p.image_url IS NOT NULL) AS tiene_imagen, u.email AS owner_email
      FROM productos_almacen p
      LEFT JOIN usuarios_duenos u ON p.id_dueno::text = u.id::text
    `;
    const values = [];
    if (userRol === 'superadmin') {
      // El superadmin ve todo el almacén
    } else if (user_id) {
      // Solo lo suyo (por correo o por id de dueño)
      query += ' WHERE (u.email::text = $1 OR p.id_dueno::text = $1)';
      values.push(String(user_id));
    } else {
      query += ' WHERE 1 = 0';   // sin usuario identificado no se devuelve nada
    }
    query += ' ORDER BY p.id DESC';

    const result = await pool.query(query, values);
    const productos = result.rows.map((f) => formatear(req, f));
    // Antes se enviaba la lista 3 veces (productos, data y ...rows). Ahora una sola referencia.
    res.json({ success: true, productos, data: productos });
  } catch (error) {
    console.error('Error al obtener el almacén:', error);
    res.status(500).json({ success: false, message: 'Error en el servidor' });
  }
};

// 1b. FOTO DEL PRODUCTO  GET /api/productos-almacen/:id/imagen?v=xxxx
const obtenerImagen = async (req, res) => {
  try {
    const cols = await columnas();
    const { rows } = await pool.query(
      `SELECT image_url${cols.tieneVersion ? ', imagen_version' : ''} FROM productos_almacen WHERE id = $1`,
      [String(req.params.id)]);
    const fila = rows[0];
    if (!fila || !fila.image_url) return res.status(404).end();

    const ver = fila.imagen_version || img.version(fila.image_url);
    const etag = `"${ver}"`;
    const fija = req.query.v && req.query.v === ver;   // URL con la versión correcta: caché de 1 año
    res.set({
      ETag: etag,
      'Cache-Control': fija ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    if (req.headers['if-none-match'] === etag) return res.status(304).end();

    const datos = img.leerDataUrl(fila.image_url);
    if (datos) return res.type(datos.mime).send(datos.buffer);
    if (/^https?:\/\//i.test(fila.image_url)) return res.redirect(302, fila.image_url);
    return res.status(404).end();
  } catch (error) {
    console.error('Error al servir la imagen:', error.message);
    res.status(404).end();
  }
};

// 2. CREAR PRODUCTO
const crearProductoAlmacen = async (req, res) => {
  try {
    const {
      name, category, subcategory, unit_cost,
      sale_price, stock_warehouse, capacidad, unit_type,
      id_dueno, user_email,
      barcode, image_url, min_stock,
    } = req.body;

    let finalIdDueno = id_dueno;
    if (!finalIdDueno && user_email) {
      const u = await usuarioPorEmail(user_email);
      if (u) finalIdDueno = u.id;
    }

    const cols = await columnas();
    const foto = (await img.prepararParaGuardar(image_url)) || { image_url: null, imagen_version: null };

    const campos = ['name', 'category', 'subcategory', 'unit_cost', 'sale_price', 'stock_warehouse',
      'capacidad', 'unit_type', 'id_dueno', 'barcode', 'image_url', 'min_stock'];
    const values = [
      name, category || null, subcategory || null,
      unit_cost || 0, sale_price || 0, stock_warehouse || 0,
      capacidad || 10, unit_type || 'unidad', finalIdDueno || null,
      barcode || null, foto.image_url, min_stock || 0,
    ];
    if (cols.tieneVersion) { campos.push('imagen_version'); values.push(foto.imagen_version); }

    const result = await pool.query(
      `INSERT INTO productos_almacen (${campos.join(', ')})
       VALUES (${campos.map((_, i) => `$${i + 1}`).join(', ')})
       RETURNING ${cols.sinAlias}, (image_url IS NOT NULL) AS tiene_imagen`,
      values);

    res.json({ success: true, producto: formatear(req, result.rows[0]), message: 'Producto guardado correctamente' });
  } catch (error) {
    console.error('Error al guardar el producto:', error);
    res.status(500).json({ success: false, message: 'Error al guardar en la base de datos' });
  }
};

// 3. EDITAR PRODUCTO (solo cambia los campos que llegan; los demás se conservan)
const editarProductoAlmacen = async (req, res) => {
  try {
    const { id } = req.params;
    const cols = await columnas();

    const actualRes = await pool.query('SELECT id, name, sale_price, id_dueno FROM productos_almacen WHERE id = $1', [id]);
    if (actualRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Producto no encontrado' });
    }
    const actual = actualRes.rows[0];

    const sets = [];
    const values = [];
    for (const campo of EDITABLES) {
      if (req.body[campo] !== undefined) {
        values.push(req.body[campo]);
        sets.push(`${campo} = $${values.length}`);
      }
    }
    // La foto solo se reescribe si llegó una foto NUEVA (no la URL que nosotros le dimos)
    const foto = await img.prepararParaGuardar(req.body.image_url);
    if (foto) {
      values.push(foto.image_url); sets.push(`image_url = $${values.length}`);
      if (cols.tieneVersion) { values.push(foto.imagen_version); sets.push(`imagen_version = $${values.length}`); }
    }

    let producto;
    if (sets.length) {
      values.push(id);
      const r = await pool.query(
        `UPDATE productos_almacen SET ${sets.join(', ')} WHERE id = $${values.length}
         RETURNING ${cols.sinAlias}, (image_url IS NOT NULL) AS tiene_imagen`, values);
      producto = r.rows[0];
    } else {
      const r = await pool.query(
        `SELECT ${cols.sinAlias}, (image_url IS NOT NULL) AS tiene_imagen FROM productos_almacen WHERE id = $1`, [id]);
      producto = r.rows[0];
    }

    // Sincroniza el precio SOLO en las máquinas del dueño de este producto y SOLO donde
    // cambió (antes se reenviaba a todas las máquinas de todos los usuarios con ese nombre).
    const nombre = producto.name;
    const precio = parseFloat(producto.sale_price || 0).toFixed(2);
    if (nombre && (req.body.sale_price !== undefined || req.body.name !== undefined)) {
      try {
        const cambiados = await pool.query(
          `UPDATE inventario i SET precio = $1
           FROM maquinas m
           WHERE m.machine_id = i.machine_id
             AND i.nombre_producto = $2
             AND ($3::text IS NULL OR m.id_dueno::text = $3::text)
             AND round(COALESCE(NULLIF(i.precio::text, '')::numeric, 0), 2) <> $1::numeric
           RETURNING i.machine_id, i.codigo_motor`,
          [precio, nombre, actual.id_dueno == null ? null : String(actual.id_dueno)]);
        for (const maq of cambiados.rows) {
          mqttService.publicarMensaje(`jaimez/expendedora/${maq.machine_id}/comandos`, `EDITAR:${maq.codigo_motor} ${precio}`);
        }
        if (cambiados.rowCount) console.log(`Precio de "${nombre}" -> S/ ${precio} en ${cambiados.rowCount} resorte(s)`);
      } catch (syncError) {
        console.error('Error sincronizando el precio con las máquinas:', syncError.message);
      }
    }

    res.json({ success: true, producto: formatear(req, producto), message: 'Producto actualizado y sincronizado en todas las máquinas' });
  } catch (error) {
    console.error('Error al actualizar el producto:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar en la base de datos' });
  }
};

// 4. STOCK DEL ALMACÉN
//    { stock_warehouse: 40 }  -> fija el valor (como antes)
//    { delta: -6 }            -> suma/resta de forma atómica (no se pisa con otro operario)
const actualizarStock = async (req, res) => {
  try {
    const { id } = req.params;
    const { stock_warehouse, delta } = req.body;
    const cols = await columnas();
    const ret = `RETURNING ${cols.sinAlias}, (image_url IS NOT NULL) AS tiene_imagen`;

    let result;
    if (delta !== undefined && delta !== null) {
      const d = parseInt(delta, 10);
      if (!Number.isFinite(d)) return res.status(400).json({ success: false, message: 'delta inválido' });
      result = await pool.query(
        `UPDATE productos_almacen SET stock_warehouse = COALESCE(stock_warehouse, 0) + $1
         WHERE id = $2 AND COALESCE(stock_warehouse, 0) + $1 >= 0 ${ret}`, [d, id]);
      if (result.rows.length === 0) {
        const existe = await pool.query('SELECT stock_warehouse FROM productos_almacen WHERE id = $1', [id]);
        if (!existe.rows.length) return res.status(404).json({ success: false, message: 'Producto no encontrado' });
        return res.status(409).json({ success: false, message: `Stock insuficiente en almacén (quedan ${existe.rows[0].stock_warehouse})` });
      }
    } else {
      result = await pool.query(`UPDATE productos_almacen SET stock_warehouse = $1 WHERE id = $2 ${ret}`, [stock_warehouse, id]);
      if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Producto no encontrado' });
    }
    res.json({ success: true, producto: formatear(req, result.rows[0]), message: 'Stock de bodega descontado correctamente' });
  } catch (error) {
    console.error('Error al actualizar el stock:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar el stock' });
  }
};

// 5. ELIMINAR PRODUCTO
const eliminarProductoAlmacen = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM productos_almacen WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Producto no encontrado' });
    }
    res.json({ success: true, message: 'Producto eliminado correctamente del almacén' });
  } catch (error) {
    console.error('Error al eliminar el producto:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar en el servidor' });
  }
};

// 6. SINCRONIZAR TODOS LOS PRECIOS DE UNA MÁQUINA CON EL ESP32 (sin cambios)
const sincronizarPreciosMaquina = async (req, res) => {
  try {
    const { machine_id } = req.params;
    const result = await pool.query(
      'SELECT codigo_motor, precio, nombre_producto FROM inventario WHERE machine_id = $1', [machine_id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No se encontraron productos para esta máquina' });
    }
    const topic = `jaimez/expendedora/${machine_id}/comandos`;
    let sincronizados = 0;
    for (const item of result.rows) {
      const precioFormateado = parseFloat(item.precio || 0).toFixed(2);
      mqttService.publicarMensaje(topic, `EDITAR:${item.codigo_motor} ${precioFormateado}`);
      sincronizados++;
    }
    res.json({ success: true, message: `Se sincronizaron ${sincronizados} motores correctamente para la máquina ${machine_id}` });
  } catch (error) {
    console.error('Error en el barrido de sincronización:', error);
    res.status(500).json({ success: false, message: 'Error interno al sincronizar la máquina' });
  }
};

module.exports = {
  obtenerAlmacen,
  obtenerImagen,
  crearProductoAlmacen,
  editarProductoAlmacen,
  actualizarStock,
  eliminarProductoAlmacen,
  sincronizarPreciosMaquina,
};
