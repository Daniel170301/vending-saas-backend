// services/kymez.js
// Lectura (y algunas acciones de soporte) sobre el esquema "kymez" que usa kymez-pagos:
// cuentas de cobro (celulares Yape), máquinas KYMEZ, su estado en línea, pagos Yape,
// incidencias y la cola de ventas hacia Qhapay. Todo está en la MISMA base de datos.
// Si alguna tabla no existe (otra instalación), las rutas responden vacío en vez de fallar.
const pool = require('../config/database');

const TTL_MS = 60 * 1000;
let cache = null;   // { vence, tablas: Map<tabla, Set<columna>> }

async function estructura() {
  if (cache && cache.vence > Date.now()) return cache.tablas;
  const tablas = new Map();
  try {
    const { rows } = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'kymez'`);
    for (const r of rows) {
      if (!tablas.has(r.table_name)) tablas.set(r.table_name, new Set());
      tablas.get(r.table_name).add(r.column_name);
    }
  } catch (e) {
    console.warn('[kymez] no se pudo leer el esquema:', e.message);
  }
  cache = { vence: Date.now() + TTL_MS, tablas };
  return tablas;
}

async function tiene(tabla, columna = null) {
  const t = (await estructura()).get(tabla);
  if (!t) return false;
  return columna ? t.has(columna) : true;
}

const olvidar = () => { cache = null; };

// Mismo formato que acepta kymez-pagos en los tópicos MQTT (vending/<ID>/...)
const ID_KYMEZ = /^[A-Za-z0-9_-]{1,40}$/;

// Una máquina KYMEZ se considera en línea si su último latido tiene menos de 3 minutos
const SQL_EN_LINEA = (e) => `(${e}.online AND ${e}.actualizado_en > now() - interval '3 minutes')`;

// Incidencias: [gravedad, qué pasó, qué hacer]
const INCIDENCIAS = {
  no_entregado:         ['alta',  'El saldo Yape no llegó a la máquina', 'Revisa si la máquina estaba prendida. Si el cliente no recibió el producto, reembólsale.'],
  unused_credit:        ['alta',  'El cliente pagó y no compró', 'Reembolsa al cliente.'],
  reembolso_excedente:  ['media', 'El cliente pagó de más', 'Reembolsa el excedente.'],
  excess_refund:        ['media', 'El cliente pagó de más', 'Reembolsa el excedente.'],
  vend_failure:         ['alta',  'El producto no cayó', 'Revisa el resorte. El saldo quedó en la máquina.'],
  credit_rejected:      ['alta',  'Firma inválida al cargar saldo', 'Posible fraude o HMAC_SECRET distinto entre la máquina y Render.'],
  evento_firma_invalida:['alta',  'Evento sin firma válida', 'Alguien publicó en el tópico de la máquina sin la clave: posible fraude.'],
  sin_maquina:          ['alta',  'Llegó un Yape sin máquina que lo esperara', 'Averigua en qué máquina estaba el cliente o reembólsale.'],
  posible_duplicado:    ['media', 'Mismo cliente y monto en pocos segundos', 'Mira en Yape si pagó dos veces: si pagó dos veces, reembolsa uno.'],
  monto_excesivo:       ['alta',  'Monto mayor al permitido', 'Reembolsa al cliente.'],
  maquina_otra_cuenta:  ['alta',  'El pago llegó al celular de otra cuenta', 'Revisa la URL de MacroDroid de ese celular y reembolsa.'],
  maquina_offline:      ['media', 'La máquina se desconectó', 'Revisa luz e internet en el punto.'],
  sin_latido:           ['media', 'La máquina dejó de reportar', 'Revisa luz e internet en el punto.'],
  session_forced_end:   ['baja',  'La máquina cortó una sesión de pago', 'Si se repite, revisa el cable MDB.'],
  celular_sin_latido:   ['alta',  'El celular de cobro dejó de reportar', 'Los Yapes a ese celular no llegan a ninguna máquina: revisa batería, datos y MacroDroid.'],
  celular_mudo:         ['alta',  'Hay QR abiertos pero no llegan notificaciones', 'Revisa permisos de MacroDroid, ahorro de batería y la sesión de Yape.'],
  qhapay_error:         ['media', 'Una venta no pudo pasar a Qhapay', 'Reintenta desde Sincronización.'],
};
function describirIncidencia(tipo) {
  const d = INCIDENCIAS[tipo];
  return d
    ? { gravedad: d[0], titulo: d[1], accion: d[2] }
    : { gravedad: 'baja', titulo: String(tipo || 'Incidencia').replace(/_/g, ' '), accion: 'Revisa el detalle.' };
}

// Estados de un pago Yape: [texto, color]
const ESTADOS_PAGO = {
  recibido:           ['Recibido', 'gris'],
  enviado:            ['Enviando a la máquina', 'azul'],
  entregado:          ['Entregado', 'verde'],
  no_entregado:       ['No llegó a la máquina', 'rojo'],
  no_parseado:        ['No se pudo leer', 'gris'],
  reembolsar:         ['Por reembolsar', 'rojo'],
  reembolsar_parcial: ['Reembolsar excedente', 'ambar'],
  reembolsado:        ['Reembolsado', 'gris'],
  sin_maquina:        ['Sin máquina', 'rojo'],
  posible_duplicado:  ['Posible duplicado', 'ambar'],
  duplicado_exacto:   ['Notificación repetida', 'gris'],
  archivado:          ['Archivado', 'gris'],              // v3.6.5: revisado, no requiere reembolso
};
const POR_REEMBOLSAR = ['reembolsar', 'reembolsar_parcial', 'no_entregado', 'sin_maquina', 'posible_duplicado'];
function describirPago(estado) {
  const d = ESTADOS_PAGO[estado];
  return d ? { texto: d[0], color: d[1] } : { texto: String(estado || '—'), color: 'gris' };
}

// v3.6.5 · KYMEZ ya no vigila los celulares de los clientes (el latido se quitó).
// Para volver a vigilarlos: CELULAR_VIGILAR=si en Render (y lo mismo en kymez-pagos).
const VIGILAR_CELULARES = process.env.CELULAR_VIGILAR === 'si';
const LATIDO_MAX_MIN = Number(process.env.CELULAR_LATIDO_MAX_MIN || 12);
function estadoCelular(c) {
  if (c.activa === false) return 'desactivado';
  // 'sin_latido_configurado' es un valor que la app anterior ya conoce (no la rompe)
  if (!VIGILAR_CELULARES || !c.ultimo_latido) return 'sin_latido_configurado';
  return Date.now() - new Date(c.ultimo_latido).getTime() > LATIDO_MAX_MIN * 60000 ? 'sin_latido' : 'en_linea';
}

// Por qué un pago quedó "por atender": [título, explicación, qué se sugiere]
const MOTIVOS_PAGO = {
  nadie_comprando:    ['No era de máquina', 'Ninguna máquina de ese celular estaba cobrando en ese momento. Casi siempre es un pago personal del dueño del celular.', 'archivar'],
  llego_tarde:        ['Llegó tarde', 'El QR de ese monto ya se había cerrado en la máquina cuando llegó el pago. El cliente pagó y no recibió.', 'reembolsar'],
  ya_pagado:          ['Pago repetido', 'Ese pedido ya estaba pagado: alguien pagó dos veces el mismo monto.', 'reembolsar'],
  otro_monto:         ['Monto distinto', 'Una máquina de ese celular esperaba otro monto.', 'reembolsar'],
  sin_maquina:        ['Sin máquina', 'Ninguna máquina esperaba ese monto.', 'revisar'],
  no_entregado:       ['No llegó a la máquina', 'La máquina no confirmó el saldo (apagada o sin internet).', 'reembolsar'],
  reembolsar:         ['Por reembolsar', 'El cliente pagó y no compró, o el monto era mayor al permitido.', 'reembolsar'],
  reembolsar_parcial: ['Reembolsar excedente', 'El cliente pagó de más: se devuelve la diferencia.', 'reembolsar'],
  posible_duplicado:  ['Posible duplicado', 'Mismo cliente y mismo monto en pocos segundos. Mira en Yape si pagó dos veces.', 'revisar'],
};
function describirMotivo(m) {
  const d = MOTIVOS_PAGO[m];
  return d ? { titulo: d[0], ayuda: d[1], sugerencia: d[2] } : { titulo: String(m || '—').replace(/_/g, ' '), ayuda: '', sugerencia: 'revisar' };
}

module.exports = {
  VIGILAR_CELULARES, LATIDO_MAX_MIN, estadoCelular, MOTIVOS_PAGO, describirMotivo,
  estructura, tiene, olvidar, ID_KYMEZ, SQL_EN_LINEA,
  INCIDENCIAS, describirIncidencia, ESTADOS_PAGO, POR_REEMBOLSAR, describirPago,
};
