// controllers/inventoryController.js
const pool = require('../config/database');
const mqttService = require('../services/mqttService');
const img = require('../utils/imagenes');
const { columnaExiste } = require('../utils/esquema');
const { usuarioPorEmail } = require('../utils/usuarios');

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const colaVacia = (c) => {
  if (!c) return true;
  if (typeof c === 'string') { try { c = JSON.parse(c); } catch { return true; } }
  return !Array.isArray(c) || c.length === 0;
};

// Producto del almacén que corresponde a un resorte: mismo nombre y MISMO dueño que la máquina.
// (Antes se cruzaba solo por nombre: si dos dueños tenían "Coca Cola", el resorte salía duplicado.)
async function lateralProducto() {
  const conVersion = await columnaExiste('productos_almacen', 'imagen_version');
  return `
    LEFT JOIN LATERAL (
      SELECT pa.id, pa.unit_cost, (pa.image_url IS NOT NULL) AS tiene_imagen,
             ${conVersion ? 'pa.imagen_version' : 'NULL::text AS imagen_version'}
      FROM productos_almacen pa
      WHERE pa.name = i.nombre_producto
        AND pa.id_dueno::text = m.id_dueno::text   -- igual que el código original: solo productos del dueño
      ORDER BY pa.id DESC
      LIMIT 1
    ) pa ON true`;
}

// 1. OBTENER INVENTARIO DE UNA MÁQUINA
const obtenerInventario = async (req, res) => {
  const machine_id = req.params.machine_id || req.query.machine_id;
  if (!machine_id) {
    return res.status(400).json({ success: false, message: 'No se envió la MAC de la máquina' });
  }
  try {
    const query = `
      SELECT
        i.id,
        i.machine_id,
        i.codigo_motor,
        i.codigo_motor AS slot,
        i.nombre_producto,
        i.nombre_producto AS product_name,
        i.nombre_producto AS name,
        i.precio,
        i.precio AS price,
        i.stock,
        i.capacidad,
        i.capacidad AS capacity,
        i.cola_productos,
        pa.id AS producto_almacen_id,
        pa.tiene_imagen,
        pa.imagen_version,
        pa.unit_cost AS costo_unitario
      FROM inventario i
      LEFT JOIN maquinas m ON i.machine_id = m.machine_id
      ${await lateralProducto()}
      WHERE i.machine_id = $1`;
    const result = await pool.query(query, [machine_id]);
    res.json(result.rows.map(({ tiene_imagen, imagen_version, ...r }) => ({
      ...r,
      image_url: img.urlImagen(req, r.producto_almacen_id, tiene_imagen, imagen_version),
    })));
  } catch (error) {
    console.error('Error obteniendo inventario:', error);
    res.status(500).json({ success: false, message: 'Error al obtener inventario' });
  }
};

// Dueño y nombre de la máquina + costo del producto (una sola consulta)
async function datosMaquinaYCosto(cli, machine_id, nombreProducto) {
  const r = await cli.query(
    `SELECT m.name, m.id_dueno,
            (SELECT pa.unit_cost FROM productos_almacen pa
             WHERE pa.name = $2 AND (m.id_dueno IS NULL OR pa.id_dueno::text = m.id_dueno::text)
             ORDER BY pa.id DESC LIMIT 1) AS costo
     FROM maquinas m WHERE m.machine_id = $1`, [machine_id, nombreProducto]);
  if (r.rows.length) return { nombre: r.rows[0].name || 'Máquina Desconocida', idDueno: r.rows[0].id_dueno, costo: num(r.rows[0].costo) };
  const c = await cli.query('SELECT unit_cost FROM productos_almacen WHERE name = $1 ORDER BY id DESC LIMIT 1', [nombreProducto]);
  return { nombre: 'Máquina Desconocida', idDueno: null, costo: c.rows.length ? num(c.rows[0].unit_cost) : 0 };
}

// 2. GUARDAR UN RESORTE (abastecimiento único o mixto) + HISTORIAL
//    Opcional y nuevo: { descontar_almacen: true, producto_id } descuenta del almacén en la
//    MISMA transacción (una sola petición en vez de dos, y sin que dos operarios se pisen).
const actualizarInventario = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {
      machine_id, codigo_motor, nombre_producto, precio, stock, capacidad,
      user_email, nombre_operario, cola_productos, descontar_almacen, producto_id,
    } = req.body;

    const capacidadFinal = capacidad ? parseInt(capacidad, 10) : 10;
    let nombreFinal = nombre_producto;
    let precioFinal = num(precio).toFixed(2);
    let nuevoStockTotal = parseInt(stock, 10) || 0;
    let colaJson = '[]';

    // Modo mixto: el producto visible es el primero de la cola y el stock es la suma
    if (Array.isArray(cola_productos) && cola_productos.length > 0) {
      colaJson = JSON.stringify(cola_productos);
      nombreFinal = cola_productos[0].nombre;
      precioFinal = num(cola_productos[0].precio).toFixed(2);
      nuevoStockTotal = cola_productos.reduce((acc, item) => acc + (parseInt(item.stock, 10) || 0), 0);
    }

    // 1. Estado actual del resorte (bloqueado hasta terminar)
    const motorActual = await client.query(
      'SELECT stock FROM inventario WHERE machine_id = $1 AND codigo_motor = $2 FOR UPDATE',
      [machine_id, codigo_motor]);
    const cantidadAnterior = motorActual.rows.length > 0 ? parseInt(motorActual.rows[0].stock, 10) || 0 : 0;
    const cantidadAgregada = nuevoStockTotal - cantidadAnterior;

    // 2. Guardar o actualizar
    if (motorActual.rows.length === 0) {
      await client.query(
        'INSERT INTO inventario (machine_id, codigo_motor, nombre_producto, precio, stock, capacidad, cola_productos) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [machine_id, codigo_motor, nombreFinal, precioFinal, nuevoStockTotal, capacidadFinal, colaJson]);
    } else {
      await client.query(
        'UPDATE inventario SET nombre_producto = $1, precio = $2, stock = $3, capacidad = $4, cola_productos = $5 WHERE machine_id = $6 AND codigo_motor = $7',
        [nombreFinal, precioFinal, nuevoStockTotal, capacidadFinal, colaJson, machine_id, codigo_motor]);
    }

    // 3. Mismo precio en los otros resortes de esta máquina con el mismo producto (solo abastecimiento único)
    if (nombreFinal && String(nombreFinal).trim() !== '' && colaJson === '[]') {
      await client.query(
        'UPDATE inventario SET precio = $1 WHERE machine_id = $2 AND nombre_producto = $3',
        [precioFinal, machine_id, nombreFinal]);
    }

    // 4. Historial (solo si se agregó mercadería) y, si lo piden, descuento del almacén
    let stockAlmacen;
    if (cantidadAgregada > 0 && nombreFinal) {
      const maq = await datosMaquinaYCosto(client, machine_id, nombreFinal);
      await client.query(`
        INSERT INTO historial_abastecimiento
        (machine_id, nombre_maquina, codigo_motor, nombre_producto, cantidad_anterior, cantidad_agregada, cantidad_total, costo_unitario, responsable_email, nombre_operario)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [machine_id, maq.nombre, codigo_motor, nombreFinal, cantidadAnterior, cantidadAgregada,
        nuevoStockTotal, maq.costo, user_email || 'Administrador', nombre_operario || 'No especificado']);

      if (descontar_almacen && producto_id != null) {
        const d = await client.query(
          `UPDATE productos_almacen SET stock_warehouse = COALESCE(stock_warehouse, 0) - $1
           WHERE id = $2 AND COALESCE(stock_warehouse, 0) >= $1
           RETURNING stock_warehouse`, [cantidadAgregada, producto_id]);
        if (!d.rows.length) {
          await client.query('ROLLBACK');
          return res.status(409).json({ success: false, message: 'Stock insuficiente en almacén' });
        }
        stockAlmacen = d.rows[0].stock_warehouse;
      }
    }

    await client.query('COMMIT');

    // 5. Precio al ESP32
    mqttService.enviarComandoPrecio(machine_id, codigo_motor, precioFinal);

    res.json({
      success: true,
      message: 'Producto guardado, historial registrado y precios sincronizados',
      resorte: { machine_id, codigo_motor, nombre_producto: nombreFinal, precio: precioFinal, stock: nuevoStockTotal, capacidad: capacidadFinal },
      cantidad_agregada: Math.max(0, cantidadAgregada),
      ...(stockAlmacen !== undefined ? { stock_almacen: stockAlmacen } : {}),
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error en DB al actualizar inventario:', error);
    res.status(500).json({ success: false, message: 'Error guardando inventario e historial' });
  } finally {
    client.release();
  }
};

// 2b. RELLENO EN GRUPO: varios resortes en UNA petición y UNA transacción
//  POST /api/inventario/lote
//  { machine_id, user_email, nombre_operario, descontar_almacen = true,
//    items: [{ codigo_motor, cantidad, producto_id?, nombre_producto?, precio?, capacidad? }] }
//  "cantidad" = unidades que se AGREGAN (no el total). Si algo no cuadra no se guarda nada.
const abastecerLote = async (req, res) => {
  const { machine_id, user_email, nombre_operario, items } = req.body || {};
  const descontar = req.body?.descontar_almacen !== false;
  if (!machine_id || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'Faltan machine_id o items' });
  }
  if (items.length > 300) return res.status(400).json({ success: false, message: 'Máximo 300 resortes por lote' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const maqRes = await client.query('SELECT name, id_dueno FROM maquinas WHERE machine_id = $1', [machine_id]);
    if (!maqRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Máquina no encontrada' });
    }
    const maquina = maqRes.rows[0];
    const dueno = maquina.id_dueno == null ? null : String(maquina.id_dueno);

    // Resortes involucrados (bloqueados hasta terminar)
    const codigos = [...new Set(items.map((it) => String(it.codigo_motor)))];
    const resRes = await client.query(
      `SELECT codigo_motor, nombre_producto, precio, stock, capacidad, cola_productos
       FROM inventario WHERE machine_id = $1 AND codigo_motor = ANY($2::text[]) FOR UPDATE`,
      [machine_id, codigos]);
    const resortes = new Map(resRes.rows.map((r) => [String(r.codigo_motor), r]));

    // Productos del almacén del dueño (por id o por nombre), bloqueados para descontar sin carreras
    const ids = [...new Set(items.filter((it) => it.producto_id != null).map((it) => String(it.producto_id)))];
    const nombres = [...new Set(items.map((it) => it.nombre_producto || resortes.get(String(it.codigo_motor))?.nombre_producto).filter(Boolean))];
    const prodRes = await client.query(
      `SELECT id, name, sale_price, unit_cost, stock_warehouse FROM productos_almacen
       WHERE (id::text = ANY($1::text[]) OR name = ANY($2::text[]))
         AND ($3::text IS NULL OR id_dueno::text = $3::text)
       ORDER BY id DESC FOR UPDATE`, [ids, nombres, dueno]);
    const porId = new Map(prodRes.rows.map((p) => [String(p.id), p]));
    const porNombre = new Map();
    for (const p of prodRes.rows) if (!porNombre.has(p.name)) porNombre.set(p.name, p);   // el más reciente

    // Validación completa antes de escribir
    const errores = [];
    const plan = [];
    const pedidoPorProducto = new Map();   // id producto -> unidades pedidas
    const vistos = new Set();
    for (const it of items) {
      const codigo = String(it.codigo_motor ?? '');
      const cantidad = parseInt(it.cantidad, 10);
      const actual = resortes.get(codigo);
      const err = (motivo) => errores.push({ codigo_motor: codigo, motivo });

      if (!codigo) { err('Falta codigo_motor'); continue; }
      if (vistos.has(codigo)) { err('Resorte repetido en el lote'); continue; }
      vistos.add(codigo);
      if (!Number.isFinite(cantidad) || cantidad <= 0) { err('La cantidad debe ser mayor a 0'); continue; }
      if (actual && !colaVacia(actual.cola_productos)) { err('Resorte mixto: cárgalo en relleno por unidad'); continue; }

      const producto = (it.producto_id != null && porId.get(String(it.producto_id)))
        || porNombre.get(it.nombre_producto || actual?.nombre_producto || '');
      const nombre = producto?.name || it.nombre_producto || actual?.nombre_producto;
      if (!nombre) { err('El resorte no tiene producto asignado'); continue; }
      if (descontar && !producto) { err(`"${nombre}" no está en tu almacén`); continue; }

      const stockActual = parseInt(actual?.stock, 10) || 0;
      if (actual?.nombre_producto && actual.nombre_producto !== nombre && stockActual > 0) {
        err(`Tiene ${stockActual} u. de "${actual.nombre_producto}". Vacíalo antes de cambiar de producto`); continue;
      }
      const capacidad = parseInt(it.capacidad ?? actual?.capacidad, 10) || 0;
      if (capacidad > 0 && stockActual + cantidad > capacidad) {
        err(`Solo caben ${Math.max(0, capacidad - stockActual)} u. más (capacidad ${capacidad})`); continue;
      }

      const mismoProducto = actual?.nombre_producto === nombre;
      const precio = num(it.precio ?? (mismoProducto && num(actual?.precio) > 0 ? actual.precio : producto?.sale_price)).toFixed(2);
      if (producto) pedidoPorProducto.set(String(producto.id), (pedidoPorProducto.get(String(producto.id)) || 0) + cantidad);
      plan.push({
        codigo, cantidad, nombre, precio, producto, existe: !!actual,
        anterior: stockActual, total: stockActual + cantidad,
        capacidad: capacidad || (parseInt(actual?.capacidad, 10) || 10),
        precioAnterior: actual ? num(actual.precio).toFixed(2) : null,
        precioExplicito: it.precio !== undefined && it.precio !== null && it.precio !== '',
      });
    }
    if (descontar) {
      for (const [idProd, pedido] of pedidoPorProducto) {
        const p = porId.get(idProd);
        const hay = parseInt(p.stock_warehouse, 10) || 0;
        if (pedido > hay) {
          for (const x of plan.filter((x) => String(x.producto?.id) === idProd)) {
            errores.push({ codigo_motor: x.codigo, motivo: `Almacén: quedan ${hay} u. de "${p.name}" y pides ${pedido}` });
          }
        }
      }
    }
    if (errores.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Revisa los resortes marcados; no se guardó nada', errores });
    }

    // Escritura
    for (const x of plan) {
      if (x.existe) {
        await client.query(
          `UPDATE inventario SET nombre_producto = $1, precio = $2, stock = $3, capacidad = $4, cola_productos = '[]'
           WHERE machine_id = $5 AND codigo_motor = $6`,
          [x.nombre, x.precio, x.total, x.capacidad, machine_id, x.codigo]);
      } else {
        await client.query(
          `INSERT INTO inventario (machine_id, codigo_motor, nombre_producto, precio, stock, capacidad, cola_productos)
           VALUES ($1, $2, $3, $4, $5, $6, '[]')`,
          [machine_id, x.codigo, x.nombre, x.precio, x.total, x.capacidad]);
      }
    }

    // Si el operario CAMBIÓ el precio (lo mandó explícito), los otros resortes de esta máquina con
    // el mismo producto quedan con ese precio, igual que en el abastecimiento por unidad de siempre.
    const otrosPrecios = [];
    const codigosPlan = plan.map((x) => x.codigo);
    for (const x of plan.filter((y) => y.precioExplicito)) {
      const r = await client.query(
        `UPDATE inventario SET precio = $1
         WHERE machine_id = $2 AND nombre_producto = $3 AND NOT (codigo_motor = ANY($4::text[]))
           AND round(COALESCE(NULLIF(precio::text, '')::numeric, 0), 2) <> $1::numeric
         RETURNING codigo_motor`, [x.precio, machine_id, x.nombre, codigosPlan]);
      for (const f of r.rows) otrosPrecios.push({ codigo: String(f.codigo_motor), precio: x.precio });
    }

    // Historial: un solo INSERT con todas las filas
    const filas = [];
    const vals = [];
    for (const x of plan) {
      const base = vals.length;
      vals.push(machine_id, maquina.name || 'Máquina Desconocida', x.codigo, x.nombre, x.anterior, x.cantidad, x.total,
        num(x.producto?.unit_cost), user_email || 'Administrador', nombre_operario || 'No especificado');
      filas.push(`(${Array.from({ length: 10 }, (_, k) => `$${base + k + 1}`).join(', ')})`);
    }
    await client.query(
      `INSERT INTO historial_abastecimiento
       (machine_id, nombre_maquina, codigo_motor, nombre_producto, cantidad_anterior, cantidad_agregada, cantidad_total, costo_unitario, responsable_email, nombre_operario)
       VALUES ${filas.join(', ')}`, vals);

    // Almacén: UN descuento por producto con el total sumado
    const almacen = [];
    if (descontar) {
      for (const [idProd, pedido] of pedidoPorProducto) {
        const r = await client.query(
          `UPDATE productos_almacen SET stock_warehouse = COALESCE(stock_warehouse, 0) - $1
           WHERE id = $2 RETURNING id, name, stock_warehouse`, [pedido, porId.get(idProd).id]);
        almacen.push(r.rows[0]);
      }
    }

    await client.query('COMMIT');

    // Precio al ESP32 solo donde cambió
    for (const x of plan) {
      if (x.precioAnterior !== x.precio) mqttService.enviarComandoPrecio(machine_id, x.codigo, x.precio);
    }
    for (const o of otrosPrecios) mqttService.enviarComandoPrecio(machine_id, o.codigo, o.precio);

    res.json({
      success: true,
      message: `${plan.reduce((a, x) => a + x.cantidad, 0)} unidades cargadas en ${plan.length} resorte(s)`,
      total_unidades: plan.reduce((a, x) => a + x.cantidad, 0),
      resortes: plan.map((x) => ({
        codigo_motor: x.codigo, nombre_producto: x.nombre, precio: x.precio,
        stock: x.total, capacidad: x.capacidad, agregado: x.cantidad, producto_almacen_id: x.producto?.id ?? null,
      })),
      almacen,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error en abastecimiento por lote:', error);
    res.status(500).json({ success: false, message: 'Error guardando el lote' });
  } finally {
    client.release();
  }
};

// 2c. RESUMEN POR MÁQUINA (para el Planograma: unidades, costo y venta futura)
//  GET /api/inventario/resumen?email=...
const resumenInventario = async (req, res) => {
  try {
    const email = req.query.email || req.query.user;
    const u = email ? await usuarioPorEmail(email) : null;
    if (!u) return res.json({ success: true, maquinas: [], totales: { unidades: 0, capacidad: 0, faltantes: 0, costo: 0, venta_futura: 0 } });
    const superadmin = u.rol === 'superadmin';

    const { rows } = await pool.query(`
      SELECT m.machine_id, COALESCE(m.name, m.machine_id) AS nombre,
             COUNT(i.codigo_motor)::int AS resortes,
             COALESCE(SUM(i.stock), 0)::int AS unidades,
             COALESCE(SUM(i.capacidad), 0)::int AS capacidad,
             COALESCE(SUM(GREATEST(COALESCE(i.capacidad, 0) - COALESCE(i.stock, 0), 0))
               FILTER (WHERE COALESCE(i.nombre_producto, '') <> ''), 0)::int AS faltantes,
             COALESCE(SUM(i.stock * COALESCE(NULLIF(i.precio::text, '')::numeric, 0)), 0)::float AS venta_futura,
             COALESCE(SUM(i.stock * COALESCE(pa.unit_cost, 0)), 0)::float AS costo
      FROM maquinas m
      LEFT JOIN inventario i ON i.machine_id = m.machine_id
      LEFT JOIN LATERAL (
        SELECT unit_cost FROM productos_almacen pa
        WHERE pa.name = i.nombre_producto AND (m.id_dueno IS NULL OR pa.id_dueno::text = m.id_dueno::text)
        ORDER BY pa.id DESC LIMIT 1
      ) pa ON true
      WHERE $1::boolean OR m.id_dueno::text = $2::text
      GROUP BY m.machine_id, m.name
      ORDER BY nombre`, [superadmin, String(u.id)]);

    const totales = rows.reduce((t, r) => ({
      unidades: t.unidades + r.unidades, capacidad: t.capacidad + r.capacidad, faltantes: t.faltantes + r.faltantes,
      costo: t.costo + r.costo, venta_futura: t.venta_futura + r.venta_futura,
    }), { unidades: 0, capacidad: 0, faltantes: 0, costo: 0, venta_futura: 0 });
    res.json({ success: true, maquinas: rows, totales });
  } catch (error) {
    console.error('Error en resumen de inventario:', error);
    res.status(500).json({ success: false, message: 'Error al calcular el resumen' });
  }
};

// 3. REGISTRAR VENTA (sin cambios de lógica)
const registrarVenta = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { machine_id, codigo_motor } = req.body;
    const invRes = await client.query(
      'SELECT * FROM inventario WHERE machine_id = $1 AND codigo_motor = $2 FOR UPDATE',
      [machine_id, codigo_motor]);
    if (invRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'No hay stock disponible o el motor no existe' });
    }
    const motor = invRes.rows[0];
    let nuevoStockFinal = 0;

    if (motor.cola_productos && motor.cola_productos.length > 0) {
      const colaProductos = motor.cola_productos;
      colaProductos[0].stock -= 1;
      nuevoStockFinal = colaProductos[0].stock;
      if (colaProductos[0].stock <= 0) colaProductos.shift();
      await client.query(
        'UPDATE inventario SET cola_productos = $1 WHERE machine_id = $2 AND codigo_motor = $3',
        [JSON.stringify(colaProductos), machine_id, codigo_motor]);
    } else if (motor.stock > 0) {
      const updateRes = await client.query(`
        UPDATE inventario SET stock = stock - 1
        WHERE machine_id = $1 AND codigo_motor = $2 AND stock > 0
        RETURNING stock`, [machine_id, codigo_motor]);
      nuevoStockFinal = updateRes.rows[0].stock;
    } else {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'No hay stock disponible' });
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Venta exitosa, stock reducido en 1', nuevo_stock: nuevoStockFinal });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error al registrar la venta:', error);
    res.status(500).json({ success: false, message: 'Error interno del servidor' });
  } finally {
    client.release();
  }
};

// 4. ELIMINAR UN RESORTE
const deleteSpring = async (req, res) => {
  try {
    const { machine_id, codigo_motor } = req.params;
    const result = await pool.query(
      'DELETE FROM inventario WHERE machine_id = $1 AND codigo_motor = $2 RETURNING codigo_motor',
      [machine_id, codigo_motor]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'El resorte no existía en la base de datos.' });
    }
    res.json({ success: true, message: `Resorte #${codigo_motor} eliminado correctamente.` });
  } catch (error) {
    console.error('Error al eliminar resorte:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar el resorte en el servidor.' });
  }
};

// Devuelve unidades al almacén del DUEÑO de la máquina (antes: a todos los productos con ese nombre)
async function devolverAlAlmacen(cli, machine_id, nombre, cantidad) {
  await cli.query(`
    UPDATE productos_almacen SET stock_warehouse = COALESCE(stock_warehouse, 0) + $1
    WHERE id = (
      SELECT pa.id FROM productos_almacen pa
      LEFT JOIN maquinas m ON m.machine_id = $3
      WHERE pa.name = $2 AND (m.id_dueno IS NULL OR pa.id_dueno::text = m.id_dueno::text)
      ORDER BY pa.id DESC LIMIT 1
    )`, [cantidad, nombre, machine_id]);
}

// 5. QUITAR STOCK Y DEVOLVER AL ALMACÉN (parcial o total)
const quitarStockYDevolverAlmacen = async (req, res) => {
  const client = await pool.connect();
  try {
    const { machine_id, codigo_motor, cantidad_a_quitar } = req.body;
    await client.query('BEGIN');

    const invRes = await client.query(
      'SELECT nombre_producto, stock FROM inventario WHERE machine_id = $1 AND codigo_motor = $2 FOR UPDATE',
      [machine_id, codigo_motor]);

    if (invRes.rows.length > 0) {
      const { nombre_producto } = invRes.rows[0];
      const stock = parseInt(invRes.rows[0].stock, 10) || 0;
      const cantidadAQuitar = cantidad_a_quitar ? parseInt(cantidad_a_quitar, 10) : stock;

      if (cantidadAQuitar > 0 && cantidadAQuitar <= stock && nombre_producto) {
        await devolverAlAlmacen(client, machine_id, nombre_producto, cantidadAQuitar);
        if (cantidadAQuitar === stock) {
          await client.query(
            'UPDATE inventario SET stock = 0, nombre_producto = NULL, precio = 0 WHERE machine_id = $1 AND codigo_motor = $2',
            [machine_id, codigo_motor]);
        } else {
          await client.query(
            'UPDATE inventario SET stock = stock - $1 WHERE machine_id = $2 AND codigo_motor = $3',
            [cantidadAQuitar, machine_id, codigo_motor]);
        }
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Stock actualizado y devuelto al almacén.' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error devolviendo stock:', error);
    res.status(500).json({ success: false, message: 'Error interno del servidor.' });
  } finally {
    client.release();
  }
};

// 6. HISTORIAL DE ABASTECIMIENTO
//    Nuevo y opcional: ?desde=2026-10-01&hasta=2026-10-31&limite=200
const obtenerHistorialAbastecimiento = async (req, res) => {
  try {
    const { machine_id } = req.params;
    const values = [machine_id];
    let where = 'WHERE machine_id = $1';
    if (req.query.desde) { values.push(req.query.desde); where += ` AND fecha >= $${values.length}`; }
    if (req.query.hasta) { values.push(`${req.query.hasta} 23:59:59`); where += ` AND fecha <= $${values.length}`; }
    let limite = '';
    if (req.query.limite) { values.push(Math.min(parseInt(req.query.limite, 10) || 200, 5000)); limite = ` LIMIT $${values.length}`; }
    const result = await pool.query(`SELECT * FROM historial_abastecimiento ${where} ORDER BY fecha DESC${limite}`, values);
    res.json({ success: true, historial: result.rows });
  } catch (error) {
    console.error('Error al obtener historial:', error);
    res.status(500).json({ success: false, message: 'Error en el servidor al cargar historial' });
  }
};

// 7. REVERTIR UN ABASTECIMIENTO
const eliminarHistorialAbastecimiento = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const histRes = await client.query('SELECT * FROM historial_abastecimiento WHERE id = $1 FOR UPDATE', [id]);
    if (histRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Registro no encontrado' });
    }
    const registro = histRes.rows[0];

    await client.query(`
      UPDATE inventario SET stock = GREATEST(stock - $1, 0)
      WHERE machine_id = $2 AND codigo_motor = $3`,
    [registro.cantidad_agregada, registro.machine_id, registro.codigo_motor]);

    if (registro.nombre_producto) {
      await devolverAlAlmacen(client, registro.machine_id, registro.nombre_producto, registro.cantidad_agregada);
    }

    await client.query('DELETE FROM historial_abastecimiento WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({ success: true, message: 'Abastecimiento revertido y productos devueltos al almacén' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error al revertir historial:', error);
    res.status(500).json({ success: false, message: 'Error interno al revertir el abastecimiento' });
  } finally {
    client.release();
  }
};

module.exports = {
  obtenerInventario,
  actualizarInventario,
  abastecerLote,
  resumenInventario,
  registrarVenta,
  deleteSpring,
  quitarStockYDevolverAlmacen,
  obtenerHistorialAbastecimiento,
  eliminarHistorialAbastecimiento,
};
