// services/asistente.js
// v3.6 · Asistente QhaPay con IA (Claude, de Anthropic) por su API.
//
// Cómo funciona:
//  - La app manda la conversación (y si hay, UNA foto: boleta, factura, máquina…).
//  - Claude puede CONSULTAR datos del dueño con herramientas de solo lectura (máquinas,
//    planograma, almacén, ventas) y PROPONER cambios (gasto, compra de mercadería, producto
//    nuevo, abastecimiento). Las propuestas NO se guardan: la app muestra una tarjeta y se guardan
//    solo cuando la persona toca "Confirmar" (POST /api/asistente/confirmar).
//  - Todo pasa por las mismas rutas de la API con la sesión de la persona, así que el asistente
//    solo ve y toca lo mismo que ella (un operario: solo abastecer).
//  - No se guardan las fotos ni los mensajes; solo cuántos mensajes y tokens usó cada cuenta al día.
//
// Variables de entorno:
//   ANTHROPIC_API_KEY      clave de la API (consola de Claude). Sin ella el asistente queda apagado.
//   ASISTENTE_MODELO       por defecto claude-sonnet-5-5 (más barato: claude-haiku-5-5)
//   ASISTENTE_LIMITE_DIA   mensajes por cuenta al día (por defecto 80)
const crypto = require('crypto');
const pool = require('../config/database');

const API_URL = process.env.ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages';
const MODELO = process.env.ASISTENTE_MODELO || 'claude-sonnet-5-5';
const LIMITE_DIA = Math.max(1, parseInt(process.env.ASISTENTE_LIMITE_DIA, 10) || 80);
const MAX_RONDAS = 6;
const activo = () => !!process.env.ANTHROPIC_API_KEY;

// ------------------------------------------------------------------ uso diario
let tablaLista = null;
function asegurarTabla() {
  if (!tablaLista) {
    tablaLista = pool.query(`
      CREATE TABLE IF NOT EXISTS asistente_uso (
        fecha           DATE NOT NULL,
        clave           TEXT NOT NULL,
        mensajes        INTEGER NOT NULL DEFAULT 0,
        tokens_entrada  BIGINT NOT NULL DEFAULT 0,
        tokens_salida   BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (fecha, clave)
      )`).catch((e) => { tablaLista = null; throw e; });
  }
  return tablaLista;
}
const hoyLima = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
const claveUso = (req) => (req.usuario.operario ? `o:${req.usuario.operario.id}` : `d:${req.usuario.id}`);

async function mensajesHoy(req) {
  await asegurarTabla();
  const r = await pool.query('SELECT mensajes FROM asistente_uso WHERE fecha = $1 AND clave = $2', [hoyLima(), claveUso(req)]);
  return r.rows[0] ? Number(r.rows[0].mensajes) : 0;
}
async function sumarUso(req, entrada, salida) {
  await asegurarTabla();
  await pool.query(`
    INSERT INTO asistente_uso (fecha, clave, mensajes, tokens_entrada, tokens_salida) VALUES ($1, $2, 1, $3, $4)
    ON CONFLICT (fecha, clave) DO UPDATE SET mensajes = asistente_uso.mensajes + 1,
      tokens_entrada = asistente_uso.tokens_entrada + EXCLUDED.tokens_entrada,
      tokens_salida = asistente_uso.tokens_salida + EXCLUDED.tokens_salida`,
  [hoyLima(), claveUso(req), entrada, salida]);
}

// ------------------------------------------------------------------ API interna
// Las herramientas usan las mismas rutas que la app, con la sesión de la persona.
function baseInterna(req) {
  return process.env.API_INTERNA || `http://127.0.0.1:${req.socket.localPort}`;
}
async function api(req, metodo, ruta, cuerpo) {
  const sep = ruta.includes('?') ? '&' : '?';
  const url = `${baseInterna(req)}${ruta}${req.usuario.email ? `${sep}user=${encodeURIComponent(req.usuario.email)}` : ''}`;
  const r = await fetch(url, {
    method: metodo,
    headers: { authorization: req.get('authorization') || '', 'content-type': 'application/json' },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    signal: AbortSignal.timeout(25000),
  });
  const t = await r.text();
  let datos; try { datos = JSON.parse(t); } catch { datos = t; }
  return { ok: r.ok, status: r.status, datos };
}
const mensajeDe = (r) => (r && r.datos && (r.datos.message || r.datos.error)) || `Error ${r && r.status}`;

// ------------------------------------------------------------------ herramientas
const n2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
const fechaOk = (f) => /^\d{4}-\d{2}-\d{2}$/.test(String(f || ''));

async function listaProductos(req, ctx) {
  if (!ctx.productos) {
    const r = await api(req, 'GET', '/api/productos-almacen');
    const lista = (r.datos && (r.datos.productos || r.datos.data)) || [];
    ctx.productos = lista.map((p) => ({
      id: p.id, nombre: p.name, categoria: p.category || null, costo: n2(p.unit_cost),
      precio_venta: n2(p.sale_price), stock: Number(p.stock_warehouse) || 0, unidad: p.unit_type || 'unidad',
    }));
  }
  return ctx.productos;
}
async function listaMaquinas(req, ctx) {
  if (!ctx.maquinas) {
    const r = await api(req, 'GET', '/api/machines?ligero=1');
    const lista = Array.isArray(r.datos) ? r.datos : (r.datos && r.datos.data) || [];
    ctx.maquinas = lista.map((m) => ({
      id: m.id || m.machine_id, nombre: m.name || m.nombre || null, codigo: m.codigo_kmt || m.code || null,
      ubicacion: m.location || m.ubicacion || null,
    }));
  }
  return ctx.maquinas;
}

const HERRAMIENTAS = [
  {
    name: 'listar_maquinas', soloDueno: false,
    description: 'Lista las máquinas expendedoras de la cuenta: id (usar en otras herramientas), nombre, código KMT y ubicación.',
    input_schema: { type: 'object', properties: {} },
    async correr(req, ctx) { return { maquinas: await listaMaquinas(req, ctx) }; },
  },
  {
    name: 'ver_planograma', soloDueno: false,
    description: 'Resortes de una máquina: número de motor (el que se marca en la máquina), producto, precio, stock y capacidad. Úsalo antes de proponer un abastecimiento.',
    input_schema: { type: 'object', properties: { machine_id: { type: 'string' } }, required: ['machine_id'] },
    async correr(req, ctx, e) {
      const r = await api(req, 'GET', `/api/inventario/${encodeURIComponent(e.machine_id)}`);
      if (!r.ok) return { error: mensajeDe(r) };
      const filas = Array.isArray(r.datos) ? r.datos : (r.datos && r.datos.data) || [];
      return {
        resortes: filas.map((f) => ({
          motor: String(f.codigo_motor ?? f.slot ?? ''), producto: f.nombre_producto ?? f.product_name ?? null,
          producto_id: f.producto_almacen_id ?? null, precio: n2(f.precio ?? f.price),
          stock: Number(f.stock ?? f.current_qty) || 0, capacidad: Number(f.capacidad ?? f.capacity) || 0,
        })),
      };
    },
  },
  {
    name: 'buscar_productos', soloDueno: false,
    description: 'Busca productos del almacén por nombre o categoría (sin texto: todos). Devuelve id, nombre, costo, precio de venta y stock en almacén.',
    input_schema: { type: 'object', properties: { texto: { type: 'string' } } },
    async correr(req, ctx, e) {
      const t = String(e.texto || '').trim().toLowerCase();
      const todos = await listaProductos(req, ctx);
      const palabras = t.split(/\s+/).filter(Boolean);
      const hallados = palabras.length
        ? todos.filter((p) => palabras.every((w) => `${p.nombre} ${p.categoria || ''}`.toLowerCase().includes(w)))
        : todos;
      return { total: hallados.length, productos: hallados.slice(0, 40) };
    },
  },
  {
    name: 'resumen_ventas', soloDueno: true,
    description: 'Resume las ventas entre dos fechas (YYYY-MM-DD, hora de Lima), de todas las máquinas o de una: total en soles, unidades, por día, por producto y por medio de pago.',
    input_schema: {
      type: 'object',
      properties: { desde: { type: 'string' }, hasta: { type: 'string' }, machine_id: { type: 'string' } },
      required: ['desde', 'hasta'],
    },
    async correr(req, ctx, e) {
      if (!fechaOk(e.desde) || !fechaOk(e.hasta)) return { error: 'Fechas con formato YYYY-MM-DD' };
      const q = `/api/ventas?desde=${e.desde}&hasta=${e.hasta}&limite=20000${e.machine_id ? `&machine_id=${encodeURIComponent(e.machine_id)}` : ''}`;
      const r = await api(req, 'GET', q);
      if (!r.ok) return { error: mensajeDe(r) };
      const filas = Array.isArray(r.datos) ? r.datos : (r.datos && (r.datos.ventas || r.datos.data)) || [];
      const porDia = {}, porProducto = {}, porMedio = {};
      let total = 0;
      for (const v of filas) {
        const monto = Number(v.precio) || 0;
        total += monto;
        const dia = v.fecha ? new Date(v.fecha).toLocaleDateString('en-CA', { timeZone: 'America/Lima' }) : 'sin fecha';
        porDia[dia] = n2((porDia[dia] || 0) + monto);
        const prod = v.nombre_producto || `Motor ${v.codigo_motor}`;
        porProducto[prod] = porProducto[prod] || { unidades: 0, total: 0 };
        porProducto[prod].unidades += 1; porProducto[prod].total = n2(porProducto[prod].total + monto);
        const f = String(v.fuente || '').toLowerCase();
        const medio = f.includes('yape') ? 'Yape' : f.includes('moned') ? 'Monedas' : f.includes('billet') ? 'Billetes'
          : (v.nombre_cliente && v.nombre_cliente !== 'Efectivo' ? 'Yape' : 'Efectivo');
        porMedio[medio] = n2((porMedio[medio] || 0) + monto);
      }
      const top = Object.entries(porProducto).sort((a, b) => b[1].total - a[1].total).slice(0, 15)
        .map(([nombre, x]) => ({ nombre, ...x }));
      return { total: n2(total), unidades: filas.length, por_dia: porDia, por_medio: porMedio, productos_top: top };
    },
  },
  // ---------- Propuestas (no guardan: la persona confirma en la app) ----------
  {
    name: 'proponer_gasto', soloDueno: true, propuesta: 'gasto',
    description: 'Prepara un gasto que NO es compra de mercadería (luz, mantenimiento, transporte, sueldos, alquiler, etc.). Montos en soles con IGV incluido.',
    input_schema: {
      type: 'object',
      properties: {
        categoria: { type: 'string', description: 'Mantenimiento, Logística, Nómina, Gastos administrativos, Otros, o la que diga la persona' },
        concepto: { type: 'string' }, monto: { type: 'number' }, fecha: { type: 'string', description: 'YYYY-MM-DD' },
        proveedor: { type: 'string' }, machine_id: { type: 'string', description: 'si el gasto es de una máquina' },
        comprobante_tipo: { type: 'string', description: 'Boleta, Factura, Recibo o Sin comprobante' },
        comprobante_numero: { type: 'string' },
      },
      required: ['categoria', 'concepto', 'monto', 'fecha'],
    },
  },
  {
    name: 'proponer_compra_mercaderia', soloDueno: true, propuesta: 'compra',
    description: 'Prepara una compra de mercadería para el almacén (suma stock y promedia el costo). Cada item usa producto_id de buscar_productos; si el producto no existe, usa nombre_nuevo (se creará). costo_unitario en soles por unidad.',
    input_schema: {
      type: 'object',
      properties: {
        proveedor: { type: 'string' }, fecha: { type: 'string', description: 'YYYY-MM-DD' },
        comprobante_tipo: { type: 'string' }, comprobante_numero: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              producto_id: { type: 'integer' }, nombre_nuevo: { type: 'string' }, categoria_nueva: { type: 'string' },
              precio_venta_nuevo: { type: 'number' }, cantidad: { type: 'integer' }, costo_unitario: { type: 'number' },
            },
            required: ['cantidad', 'costo_unitario'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'proponer_producto_nuevo', soloDueno: true, propuesta: 'producto',
    description: 'Prepara un producto nuevo para el almacén, sin compra (para registrar una compra usa proponer_compra_mercaderia).',
    input_schema: {
      type: 'object',
      properties: {
        nombre: { type: 'string' }, categoria: { type: 'string' }, costo: { type: 'number' }, precio_venta: { type: 'number' },
        stock_inicial: { type: 'integer' }, unidad: { type: 'string' },
      },
      required: ['nombre'],
    },
  },
  {
    name: 'proponer_abastecimiento', soloDueno: false, propuesta: 'abastecimiento',
    description: 'Prepara el relleno de resortes de UNA máquina: unidades que se AGREGAN por motor (descuenta del almacén). Para un resorte vacío indica producto_id. precio solo si la persona lo pidió cambiar.',
    input_schema: {
      type: 'object',
      properties: {
        machine_id: { type: 'string' },
        descontar_almacen: { type: 'boolean', description: 'false solo si la persona dice que no sale del almacén (carga inicial)' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              motor: { type: 'string' }, cantidad: { type: 'integer' }, producto_id: { type: 'integer' },
              precio: { type: 'number' }, capacidad: { type: 'integer' },
            },
            required: ['motor', 'cantidad'],
          },
        },
      },
      required: ['machine_id', 'items'],
    },
  },
];
const POR_NOMBRE = new Map(HERRAMIENTAS.map((h) => [h.name, h]));
const herramientasPara = (req) => HERRAMIENTAS.filter((h) => !(h.soloDueno && req.usuario.operario));

// ------------------------------------------------------------------ propuestas
const txt = (v, max = 120) => String(v ?? '').trim().slice(0, max);
const soles = (v) => `S/ ${n2(v).toFixed(2)}`;

/** Valida y normaliza los datos de una propuesta. Devuelve { datos } o { error }. */
function validar(accion, e, req) {
  if (accion === 'gasto') {
    const monto = n2(e.monto);
    if (!txt(e.concepto) || monto <= 0) return { error: 'Falta concepto o el monto debe ser mayor a 0' };
    if (!fechaOk(e.fecha)) return { error: 'La fecha debe ser YYYY-MM-DD' };
    return { datos: {
      categoria: txt(e.categoria, 60) || 'Otros', concepto: txt(e.concepto, 200), monto, fecha: e.fecha,
      proveedor: txt(e.proveedor) || null, machine_id: txt(e.machine_id, 64) || null,
      comprobante_tipo: txt(e.comprobante_tipo, 40) || null, comprobante_numero: txt(e.comprobante_numero, 60) || null,
    } };
  }
  if (accion === 'compra') {
    const items = Array.isArray(e.items) ? e.items.slice(0, 100) : [];
    if (!items.length) return { error: 'La compra no tiene productos' };
    const limpios = [];
    for (const it of items) {
      const cantidad = parseInt(it.cantidad, 10);
      const costo = n2(it.costo_unitario);
      if (!Number.isFinite(cantidad) || cantidad <= 0) return { error: 'Cada producto necesita una cantidad mayor a 0' };
      if (costo < 0) return { error: 'El costo no puede ser negativo' };
      if (it.producto_id == null && !txt(it.nombre_nuevo)) return { error: 'Cada item necesita producto_id o nombre_nuevo' };
      limpios.push({
        producto_id: it.producto_id != null ? parseInt(it.producto_id, 10) : null,
        nombre_nuevo: it.producto_id != null ? null : txt(it.nombre_nuevo),
        categoria_nueva: txt(it.categoria_nueva, 60) || null,
        precio_venta_nuevo: it.precio_venta_nuevo != null ? n2(it.precio_venta_nuevo) : null,
        cantidad, costo_unitario: costo,
      });
    }
    const fecha = fechaOk(e.fecha) ? e.fecha : new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    return { datos: {
      proveedor: txt(e.proveedor) || null, fecha, comprobante_tipo: txt(e.comprobante_tipo, 40) || 'Boleta',
      comprobante_numero: txt(e.comprobante_numero, 60) || null, items: limpios,
    } };
  }
  if (accion === 'producto') {
    if (!txt(e.nombre)) return { error: 'Falta el nombre' };
    return { datos: {
      nombre: txt(e.nombre), categoria: txt(e.categoria, 60) || null, costo: n2(e.costo), precio_venta: n2(e.precio_venta),
      stock_inicial: Math.max(0, parseInt(e.stock_inicial, 10) || 0), unidad: txt(e.unidad, 20) || 'unidad',
    } };
  }
  if (accion === 'abastecimiento') {
    const items = Array.isArray(e.items) ? e.items.slice(0, 300) : [];
    if (!txt(e.machine_id, 64) || !items.length) return { error: 'Falta la máquina o los resortes' };
    const limpios = [];
    for (const it of items) {
      const cantidad = parseInt(it.cantidad, 10);
      if (!txt(it.motor, 10) || !Number.isFinite(cantidad) || cantidad <= 0) return { error: 'Cada resorte necesita motor y cantidad mayor a 0' };
      limpios.push({
        motor: txt(it.motor, 10), cantidad,
        producto_id: it.producto_id != null ? parseInt(it.producto_id, 10) : null,
        precio: it.precio != null && !req.usuario.operario ? n2(it.precio) : null,
        capacidad: it.capacidad != null ? parseInt(it.capacidad, 10) || null : null,
      });
    }
    return { datos: { machine_id: txt(e.machine_id, 64), descontar_almacen: e.descontar_almacen !== false, items: limpios } };
  }
  return { error: 'Acción desconocida' };
}

// Texto de la tarjeta que ve la persona antes de confirmar
async function describir(accion, d, req, ctx) {
  const nombreProd = async (id) => (await listaProductos(req, ctx)).find((p) => String(p.id) === String(id))?.nombre || `Producto ${id}`;
  if (accion === 'gasto') {
    return { titulo: `Gasto · ${d.categoria}`, lineas: [
      `${d.concepto}: ${soles(d.monto)}`, `Fecha: ${d.fecha}`,
      ...(d.proveedor ? [`Proveedor: ${d.proveedor}`] : []),
      ...(d.comprobante_tipo ? [`${d.comprobante_tipo}${d.comprobante_numero ? ` ${d.comprobante_numero}` : ''}`] : []),
      ...(d.machine_id ? [`Máquina: ${d.machine_id}`] : []),
    ] };
  }
  if (accion === 'compra') {
    const lineas = [];
    let total = 0;
    for (const it of d.items) {
      const nombre = it.producto_id != null ? await nombreProd(it.producto_id) : `${it.nombre_nuevo} (nuevo)`;
      const sub = n2(it.cantidad * it.costo_unitario);
      total += sub;
      lineas.push(`${it.cantidad} × ${nombre} a ${soles(it.costo_unitario)} = ${soles(sub)}`);
    }
    lineas.push(`Total: ${soles(total)}`);
    if (d.proveedor) lineas.push(`Proveedor: ${d.proveedor}`);
    lineas.push(`${d.comprobante_tipo}${d.comprobante_numero ? ` ${d.comprobante_numero}` : ''} · ${d.fecha}`);
    return { titulo: 'Compra de mercadería', lineas };
  }
  if (accion === 'producto') {
    return { titulo: 'Producto nuevo', lineas: [
      d.nombre, ...(d.categoria ? [`Categoría: ${d.categoria}`] : []),
      `Costo ${soles(d.costo)} · Venta ${soles(d.precio_venta)}`, `Stock inicial: ${d.stock_inicial} ${d.unidad}`,
    ] };
  }
  if (accion === 'abastecimiento') {
    const maq = (await listaMaquinas(req, ctx)).find((m) => String(m.id) === d.machine_id);
    const lineas = [];
    for (const it of d.items) {
      lineas.push(`Motor ${it.motor}: +${it.cantidad}${it.producto_id != null ? ` ${await nombreProd(it.producto_id)}` : ''}${it.precio != null ? ` · precio ${soles(it.precio)}` : ''}`);
    }
    lineas.push(`Total: +${d.items.reduce((s, x) => s + x.cantidad, 0)} unidades${d.descontar_almacen ? ' (sale del almacén)' : ' (no descuenta almacén)'}`);
    return { titulo: `Abastecer ${maq?.nombre || d.machine_id}`, lineas };
  }
  return { titulo: accion, lineas: [] };
}

// ------------------------------------------------------------------ ejecutar (tras "Confirmar")
async function ejecutar(req, accion, d) {
  if (accion === 'gasto') {
    const r = await api(req, 'POST', '/api/gastos', {
      categoria: d.categoria, concepto: d.concepto, monto: d.monto, fecha: d.fecha, proveedor: d.proveedor,
      machine_id: d.machine_id, comprobante_tipo: d.comprobante_tipo, comprobante_num: d.comprobante_numero,
      id_usuario: req.usuario.id,
    });
    return r.ok ? { ok: true, mensaje: 'Gasto registrado' } : { ok: false, mensaje: mensajeDe(r) };
  }
  if (accion === 'producto') {
    const r = await api(req, 'POST', '/api/productos-almacen', {
      name: d.nombre, category: d.categoria, unit_cost: d.costo, sale_price: d.precio_venta,
      stock_warehouse: d.stock_inicial, min_stock: 0, unit_type: d.unidad, user_email: req.usuario.email,
    });
    return r.ok ? { ok: true, mensaje: 'Producto creado' } : { ok: false, mensaje: mensajeDe(r) };
  }
  if (accion === 'compra') {
    // Productos nuevos: se crean con stock 0 (la compra les suma la cantidad). Si ya existe uno
    // con el mismo nombre, se usa ese.
    const ctx = {};
    const productos = [];
    let total = 0;
    for (const it of d.items) {
      let id = it.producto_id;
      if (id == null) {
        const existente = (await listaProductos(req, ctx)).find((p) => p.nombre.trim().toLowerCase() === it.nombre_nuevo.toLowerCase());
        if (existente) id = existente.id;
        else {
          const c = await api(req, 'POST', '/api/productos-almacen', {
            name: it.nombre_nuevo, category: it.categoria_nueva, unit_cost: it.costo_unitario,
            sale_price: it.precio_venta_nuevo || 0, stock_warehouse: 0, min_stock: 0, unit_type: 'unidad',
            user_email: req.usuario.email,
          });
          if (!c.ok || !c.datos || !c.datos.producto) return { ok: false, mensaje: `No se pudo crear "${it.nombre_nuevo}": ${mensajeDe(c)}` };
          id = c.datos.producto.id;
          ctx.productos = null;
        }
      }
      const sub = n2(it.cantidad * it.costo_unitario);
      total += sub;
      productos.push({ id_producto: id, cantidad: it.cantidad, costo_unitario: it.costo_unitario, subtotal: sub });
    }
    const r = await api(req, 'POST', '/api/gastos/purchase', {
      id_usuario: req.usuario.email, proveedor: d.proveedor, tipo_comprobante: d.comprobante_tipo,
      numero_documento: d.comprobante_numero, fecha_compra: d.fecha, total: n2(total), productos,
    });
    return r.ok ? { ok: true, mensaje: 'Compra registrada y stock sumado' } : { ok: false, mensaje: mensajeDe(r) };
  }
  if (accion === 'abastecimiento') {
    const r = await api(req, 'POST', '/api/inventario/lote', {
      machine_id: d.machine_id, descontar_almacen: d.descontar_almacen,
      nombre_operario: req.usuario.operario ? (req.usuario.operario.nombre || req.usuario.operario.usuario) : 'Asistente QhaPay',
      items: d.items.map((it) => ({
        codigo_motor: it.motor, cantidad: it.cantidad,
        ...(it.producto_id != null ? { producto_id: it.producto_id } : {}),
        ...(it.precio != null ? { precio: it.precio } : {}),
        ...(it.capacidad != null ? { capacidad: it.capacidad } : {}),
      })),
    });
    if (r.ok) return { ok: true, mensaje: 'Máquina abastecida' };
    const errores = r.datos && Array.isArray(r.datos.errores)
      ? r.datos.errores.map((x) => `Motor ${x.codigo_motor}: ${x.motivo}`).join(' · ') : '';
    return { ok: false, mensaje: errores ? `No se guardó nada. ${errores}` : mensajeDe(r) };
  }
  return { ok: false, mensaje: 'Acción desconocida' };
}

// ------------------------------------------------------------------ conversación
function sistema(req) {
  const hoy = new Date().toLocaleDateString('es-PE', { timeZone: 'America/Lima', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const iso = hoyLima();
  const rol = req.usuario.operario
    ? 'un OPERARIO que rellena las máquinas de su jefe. Solo puede ver máquinas, planogramas y almacén, y abastecer. No puede ver ventas ni registrar gastos: si lo pide, dile amablemente que eso lo hace el dueño.'
    : 'el DUEÑO de las máquinas expendedoras.';
  return [
    'Eres el Asistente QhaPay: ayudas a operar máquinas expendedoras (vending) en Perú dentro de la app QhaPay.',
    `Hoy es ${hoy} (${iso}), hora de Lima. Estás hablando con ${rol}`,
    'Reglas:',
    '- Responde en español, breve y claro (frases cortas, listas si ayudan). Montos en soles: S/ 0.00.',
    '- Nunca inventes datos: consulta con las herramientas. Si falta algo importante, pregunta UNA cosa concreta.',
    '- Para cualquier cambio usa una herramienta proponer_*. Esas herramientas NO guardan: después dile a la persona que revise la tarjeta y toque "Confirmar". Nunca digas que algo ya quedó guardado.',
    '- Boletas y facturas peruanas: el total ya incluye IGV. Lee proveedor (razón social), RUC, fecha, número (serie-correlativo), productos, cantidades y precios. Si es mercadería para vender en las máquinas, es una compra de mercadería; si es un servicio (luz, mantenimiento, transporte), es un gasto.',
    '- En una compra de mercadería, busca cada producto en el almacén (buscar_productos) y usa su producto_id. Si no existe, usa nombre_nuevo con un nombre corto y claro (ej. "Coca-Cola 500 ml"). costo_unitario = precio por unidad (si viene por paquete, divide entre las unidades del paquete).',
    '- Para abastecer, primero mira el planograma: los "motores" son los números que se marcan en la máquina. La cantidad es lo que se AGREGA y no puede pasar la capacidad del resorte.',
    '- Si la foto no se lee bien, dilo y pide otra más cerca y con luz.',
  ].join('\n');
}

function aMensajesClaude(mensajes, imagen) {
  const salida = [];
  for (const m of (Array.isArray(mensajes) ? mensajes : []).slice(-20)) {
    const role = m && m.rol === 'asistente' ? 'assistant' : 'user';
    const texto = txt(m && m.texto, 4000);
    if (!texto) continue;
    const ult = salida[salida.length - 1];
    if (ult && ult.role === role) ult.content[0].text += `\n${texto}`;
    else salida.push({ role, content: [{ type: 'text', text: texto }] });
  }
  while (salida.length && salida[0].role !== 'user') salida.shift();
  if (!salida.length || salida[salida.length - 1].role !== 'user') {
    salida.push({ role: 'user', content: [{ type: 'text', text: imagen ? 'Revisa esta foto.' : 'Hola' }] });
  }
  if (imagen) salida[salida.length - 1].content.unshift({ type: 'image', source: { type: 'base64', media_type: imagen.media_type, data: imagen.data } });
  return salida;
}

async function llamarClaude(cuerpo) {
  const r = await fetch(API_URL, {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(90000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const e = new Error((j && j.error && j.error.message) || `Anthropic respondió ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return j;
}

/** Una vuelta de conversación. Devuelve { respuesta, propuestas, uso }. */
async function conversar(req, mensajes, imagen) {
  const herramientas = herramientasPara(req);
  const tools = herramientas.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  const msgs = aMensajesClaude(mensajes, imagen);
  const ctx = {};
  const propuestas = [];
  let entrada = 0, salida = 0, ultima = null;

  for (let ronda = 0; ronda < MAX_RONDAS; ronda++) {
    ultima = await llamarClaude({ model: MODELO, max_tokens: 1500, system: sistema(req), tools, messages: msgs });
    entrada += (ultima.usage && ultima.usage.input_tokens) || 0;
    salida += (ultima.usage && ultima.usage.output_tokens) || 0;
    msgs.push({ role: 'assistant', content: ultima.content });
    if (ultima.stop_reason !== 'tool_use') break;

    const resultados = [];
    for (const b of ultima.content.filter((x) => x.type === 'tool_use')) {
      const h = POR_NOMBRE.get(b.name);
      let out;
      try {
        if (!h || (h.soloDueno && req.usuario.operario)) out = { error: 'Herramienta no disponible para esta cuenta' };
        else if (h.propuesta) {
          const v = validar(h.propuesta, b.input || {}, req);
          if (v.error) out = { error: v.error };
          else {
            const tarjeta = await describir(h.propuesta, v.datos, req, ctx);
            const id = crypto.randomUUID();
            propuestas.push({ id, accion: h.propuesta, ...tarjeta, datos: v.datos });
            out = { ok: true, propuesta_id: id, nota: 'Tarjeta lista. AÚN NO está guardado: la persona debe tocar Confirmar.' };
          }
        } else out = await h.correr(req, ctx, b.input || {});
      } catch (e) {
        console.error(`[asistente] herramienta ${b.name}:`, e.message);
        out = { error: 'No se pudo consultar ahora' };
      }
      resultados.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out).slice(0, 30000), ...(out && out.error ? { is_error: true } : {}) });
    }
    msgs.push({ role: 'user', content: resultados });
  }

  let respuesta = (ultima && ultima.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n').trim();
  if (!respuesta) respuesta = propuestas.length ? 'Revisa la tarjeta y toca Confirmar para guardarlo.' : 'No pude completar la respuesta. ¿Lo intentamos de nuevo?';
  return { respuesta, propuestas, uso: { entrada, salida } };
}

module.exports = {
  activo, MODELO, LIMITE_DIA, mensajesHoy, sumarUso, conversar, validar, ejecutar, asegurarTabla,
  herramientasPara,
};
