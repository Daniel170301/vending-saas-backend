// utils/propiedad.js
// v3.5 · ¿Este registro es del dueño de la sesión?
// Se usa con router.param(...) en cada archivo de rutas: si el ID de la dirección no es del
// dueño, responde 404 (igual que si no existiera, para no revelar qué IDs existen).
// El superadmin puede todo. En AUTH_MODO=avisar, las peticiones sin sesión pasan sin revisar.
const pool = require('../config/database');

const NO_ENCONTRADO = { success: false, message: 'No encontrado' };

// Revisa una consulta que devuelve filas solo si el registro es del dueño ($1 = id, $2 = id del dueño)
function revisar(sql, valorDe) {
  return async (req, res, next, valor) => {
    try {
      if (!req.usuario || req.usuario.superadmin) return next();
      const v = valorDe ? valorDe(req, valor) : valor;
      if (v === undefined || v === null || v === '') return next();
      const r = await pool.query(sql, [String(v), req.usuario.id]);
      if (!r.rowCount) return res.status(404).json(NO_ENCONTRADO);
      next();
    } catch (e) {
      // Un ID con formato imposible (texto donde va un número) tampoco es del dueño
      if (e && (e.code === '22P02' || e.code === '22003')) return res.status(404).json(NO_ENCONTRADO);
      console.error('[propiedad]', e.message);
      res.status(500).json({ success: false, message: 'Error del servidor' });
    }
  };
}

const SQL_MAQUINA = 'SELECT 1 FROM maquinas WHERE machine_id = $1 AND id_dueno::text = $2';

async function maquinaEsDelDueno(machineId, idDueno) {
  const r = await pool.query(SQL_MAQUINA, [String(machineId), String(idDueno)]);
  return r.rowCount > 0;
}

const maquina = revisar(SQL_MAQUINA);

// Gastos: el mismo ID puede ser de "Mercadería" (transacciones_gastos) o de otro gasto (gastos)
function esMercaderia(req) {
  const c = (req.query && req.query.categoria) || (req.body && req.body.categoria);
  return !c || c === 'Mercadería';
}
const gasto = async (req, res, next, valor) => {
  const sql = esMercaderia(req)
    ? 'SELECT 1 FROM transacciones_gastos WHERE id::text = $1 AND id_dueno::text = $2'
    : 'SELECT 1 FROM gastos WHERE id::text = $1 AND id_dueno::text = $2';
  return revisar(sql)(req, res, next, valor);
};

const RECURSOS = {
  maquina,
  gasto,
  compra: revisar('SELECT 1 FROM transacciones_gastos WHERE id::text = $1 AND id_dueno::text = $2'),
  // El detalle debe pertenecer a la compra de la dirección (la compra ya se revisó con "compra")
  detalleCompra: async (req, res, next, valor) => {
    try {
      if (!req.usuario || req.usuario.superadmin) return next();
      const r = await pool.query(
        `SELECT 1 FROM compras_detalle d JOIN transacciones_gastos t ON t.id = d.id_transaccion
          WHERE d.id::text = $1 AND d.id_transaccion::text = $2 AND t.id_dueno::text = $3`,
        [String(valor), String(req.params.id_transaccion), req.usuario.id]);
      if (!r.rowCount) return res.status(404).json(NO_ENCONTRADO);
      next();
    } catch (e) {
      if (e && (e.code === '22P02' || e.code === '22003')) return res.status(404).json(NO_ENCONTRADO);
      console.error('[propiedad]', e.message);
      res.status(500).json({ success: false, message: 'Error del servidor' });
    }
  },
  producto: revisar('SELECT 1 FROM productos_almacen WHERE id::text = $1 AND id_dueno::text = $2'),
  proveedor: revisar('SELECT 1 FROM proveedores WHERE id::text = $1 AND id_usuario::text = $2'),
  abastecimiento: revisar(`SELECT 1 FROM historial_abastecimiento h JOIN maquinas m ON m.machine_id = h.machine_id
                            WHERE h.id::text = $1 AND m.id_dueno::text = $2`),
  // Clientes (puntos de venta): los que creó el dueño o los que están en una de sus máquinas
  cliente: async (req, res, next, valor) => {
    try { await require('./clientesDueno').asegurar(); } catch (e) { console.error('[propiedad] clientes:', e.message); }
    return revisar(`SELECT 1 FROM empresas_clientes c
                     WHERE c.id::text = $1
                       AND (c.id_dueno = $2 OR EXISTS (SELECT 1 FROM maquinas m
                             WHERE m.id_cliente_punto::text = c.id_usuario::text AND m.id_dueno::text = $2))`)(req, res, next, valor);
  },
  // Perfil: solo el propio correo
  correoPropio: (req, res, next, valor) => {
    if (!req.usuario || req.usuario.superadmin) return next();
    if (String(valor || '').trim().toLowerCase() !== req.usuario.email) return res.status(404).json(NO_ENCONTRADO);
    next();
  },
};

// Máquinas que vienen en la dirección (?machine_id=) o en el cuerpo (machine_id, items[].machine_id)
function maquinasDelPedido(req) {
  const ids = new Set();
  const add = (v) => { if (v !== undefined && v !== null && v !== '' && !['general', 'Todas', 'todas'].includes(String(v))) ids.add(String(v)); };
  add(req.query && req.query.machine_id);
  const b = req.body;
  if (b && typeof b === 'object') {
    add(b.machine_id);
    for (const lista of [b.items, b.maquinas, b.lote, b.resortes]) {
      if (Array.isArray(lista)) lista.forEach((x) => x && typeof x === 'object' && add(x.machine_id));
    }
  }
  return [...ids];
}

// Middleware para montar después de la sesión: revisa las máquinas de la consulta y del cuerpo
async function maquinasPropias(req, res, next) {
  try {
    if (!req.usuario || req.usuario.superadmin) return next();
    for (const id of maquinasDelPedido(req)) {
      if (!(await maquinaEsDelDueno(id, req.usuario.id))) return res.status(404).json({ success: false, message: 'Máquina no encontrada' });
    }
    next();
  } catch (e) {
    console.error('[propiedad] maquinas:', e.message);
    res.status(500).json({ success: false, message: 'Error del servidor' });
  }
}

// v3.6 · Productos del almacén que vienen en el cuerpo de una compra (productos[].id_producto,
// id_producto). Antes una compra podía sumar stock o cambiar el costo de un producto de otro dueño.
function productosDelPedido(req) {
  const ids = new Set();
  const add = (v) => { if (v !== undefined && v !== null && v !== '') ids.add(String(v)); };
  const b = req.body;
  if (b && typeof b === 'object') {
    add(b.id_producto);
    if (Array.isArray(b.productos)) b.productos.forEach((p) => p && typeof p === 'object' && add(p.id_producto ?? p.producto_id ?? p.id));
  }
  return [...ids];
}

async function productosPropios(req, res, next) {
  try {
    if (!req.usuario || req.usuario.superadmin || !['POST', 'PUT', 'PATCH'].includes(req.method)) return next();
    const ids = productosDelPedido(req);
    if (!ids.length) return next();
    if (ids.some((x) => !/^\d+$/.test(x))) return res.status(404).json({ success: false, message: 'Producto no encontrado' });
    const r = await pool.query(
      'SELECT count(*)::int AS n FROM productos_almacen WHERE id::text = ANY($1::text[]) AND id_dueno::text = $2',
      [ids, req.usuario.id]);
    if (r.rows[0].n !== ids.length) return res.status(404).json({ success: false, message: 'Producto no encontrado' });
    next();
  } catch (e) {
    console.error('[propiedad] productos:', e.message);
    res.status(500).json({ success: false, message: 'Error del servidor' });
  }
}

module.exports = { ...RECURSOS, maquinasPropias, maquinaEsDelDueno, productosPropios };
