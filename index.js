/**
 * KYMEZ · Servicio de pagos   (v2.3)
 * -----------------------------------
 *   POST /api/yape/notificacion   notificación de Yape (MacroDroid)
 *   POST /api/yape/latido         "sigo vivo" del celular de cobro
 *   GET  /salud                   para el health check de Render
 *
 * Variables de entorno (Render -> Environment)
 *   Obligatorias
 *     DATABASE_URL            Internal Database URL de PostgreSQL
 *     MQTT_TCN_URL            mqtts://xxxx.s1.eu.hivemq.cloud:8883
 *     MQTT_TCN_USER / MQTT_TCN_PASS
 *     MDB_HMAC_SECRET         IGUAL al HMAC_SECRET grabado en los ESP32 (no lo cambies)
 *     YAPE_WEBHOOK_TOKEN      token global de MacroDroid (mínimo 24 caracteres)
 *   Opcionales
 *     QHAPAY_SYNC=true        registrar ventas en Qhapay (public.historial_ventas / inventario)
 *     QHAPAY_RECUPERAR_DIAS   30    ventas omitidas (maquina aun no creada en Qhapay) que se recuperan al crearla
 *     YAPE_MAX_CREDITO_CENT   10000 (S/ 100)
 *     YAPE_DUP_VENTANA_S      20
 *     PEDIDO_VIGENCIA_MS      200000
 *     CREDITO_REINTENTO_S     8     segundos entre reintentos de crédito
 *     CREDITO_LIMITE_S        30    después de esto el crédito NO se envía (el cliente ya se fue)
 *     MONTO_UNICO_MAX_CENT    9     descuento máximo para desempatar montos (máquinas con monto_unico)
 *     CELULAR_LATIDO_MAX_MIN  12    alerta si un celular no manda latido en este tiempo
 *     CELULAR_MUDO_PEDIDOS    5     QRs expirados sin ninguna notificación para alertar
 *     MQTT_CLIENT_ID          kymez-pagos
 *     MQTT_INSTANCIAS_MULTIPLES=true   solo si corres 2+ instancias (ver REVISION.md)
 *     DB_POOL_MAX             10
 *     TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / ALERTAS_AVISO
 *     LOG_FORMATO=json        para mandar los logs a Better Stack / Grafana / Axiom
 */
const express = require('express');
const { Pool } = require('pg');
const mqtt = require('mqtt');
const os = require('os');
const log = require('./log');

for (const v of ['DATABASE_URL', 'MQTT_TCN_URL', 'MQTT_TCN_USER', 'MQTT_TCN_PASS',
                 'MDB_HMAC_SECRET', 'YAPE_WEBHOOK_TOKEN']) {
  if (!process.env[v]) { log.error('-', 'config_falta', { variable: v }); process.exit(1); }
}
// Solo avisa: la clave actual está grabada en los ESP32; cambiarla obliga a regrabarlos todos.
if (process.env.MDB_HMAC_SECRET.length < 32) {
  log.aviso('-', 'config_debil', { variable: 'MDB_HMAC_SECRET', minimo: 32,
    nota: 'usa una clave larga en el firmware v2 (clave por maquina)' });
}

// ── PostgreSQL ────────────────────────────────────────────────────────────────
const dbUrl = process.env.DATABASE_URL;
const db = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl.includes('.render.com') ? { rejectUnauthorized: false } : false,  // interna de Render: red privada
  max: Number(process.env.DB_POOL_MAX || 10),
  connectionTimeoutMillis: 5000,     // no quedarse colgado esperando conexión
  idleTimeoutMillis: 30000,
  statement_timeout: 10000,          // ninguna consulta bloquea un pago más de 10 s
  application_name: 'kymez-pagos',
});
db.on('error', (e) => log.error('-', 'db_error', { error: e.message }));

// ── MQTT ──────────────────────────────────────────────────────────────────────
// Por defecto: UNA instancia, clientId fijo y sesión persistente (como v2.1).
// Con MQTT_INSTANCIAS_MULTIPLES=true: MQTT 5, un clientId por instancia y suscripción
// compartida ($share): cada mensaje lo procesa UNA sola instancia.
const multiples = process.env.MQTT_INSTANCIAS_MULTIPLES === 'true';
const instancia = (process.env.RENDER_INSTANCE_ID || os.hostname()).slice(-12);
const baseId = process.env.MQTT_CLIENT_ID || 'kymez-pagos';
const mqttTcn = mqtt.connect(process.env.MQTT_TCN_URL, {
  username: process.env.MQTT_TCN_USER,
  password: process.env.MQTT_TCN_PASS,
  clientId: multiples ? `${baseId}-${instancia}` : baseId,
  clean: false,
  reconnectPeriod: 3000,
  connectTimeout: 15000,
  ...(multiples ? { protocolVersion: 5, properties: { sessionExpiryInterval: 3600 } } : {}),
});
let mqttCaidoDesde = null;
mqttTcn.on('connect', () => {
  log.info('-', 'mqtt_conectado', { broker: 'HiveMQ', cliente: mqttTcn.options.clientId,
    caido_s: mqttCaidoDesde ? Math.round((Date.now() - mqttCaidoDesde) / 1000) : undefined });
  mqttCaidoDesde = null;
});
mqttTcn.on('close', () => { if (!mqttCaidoDesde) { mqttCaidoDesde = Date.now(); log.aviso('-', 'mqtt_desconectado', {}); } });
mqttTcn.on('error', (e) => log.aviso('-', 'mqtt_error', { error: e.message }));

const tcn = require('./tcn-mdb')({ mqttClient: mqttTcn, db });
const trabajos = require('./trabajos')({ db, tcn });

const intervaloMqtt = setInterval(() => {
  if (mqttCaidoDesde && Date.now() - mqttCaidoDesde > 120000) {
    log.error('-', 'mqtt_caido', { minutos: Math.round((Date.now() - mqttCaidoDesde) / 60000),
      que_pasa: 'los Yapes se guardan y se enviaran al volver, si no pasa CREDITO_LIMITE_S' });
  }
}, 120000);

// ── HTTP ──────────────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);   // Render va detrás de un proxy: req.ip real en los logs

// Durante el apagado los webhooks SE SIGUEN atendiendo (la base sigue abierta hasta el final):
// rechazarlos perdería la notificación si MacroDroid no reintenta. Solo /salud responde 503
// para que Render deje de enviar tráfico a esta instancia.
let apagando = false;
app.use((req, res, next) => { if (apagando) res.set('Connection', 'close'); next(); });
app.use('/api/yape', require('./yape-notificacion')({ db, tcn }));

app.get('/salud', async (req, res) => {
  let dbOk = false, cola = null;
  try {
    const r = await db.query(
      `SELECT (SELECT count(*) FROM kymez.pagos_yape WHERE estado = 'enviado')::int AS creditos_en_cola,
              (SELECT count(*) FROM kymez.pedidos WHERE estado = 'abierto')::int AS pedidos_abiertos,
              (SELECT count(*) FROM kymez.ventas WHERE qhapay_estado IN ('pendiente','error'))::int AS qhapay_pendientes`);
    cola = r.rows[0]; dbOk = true;
  } catch (e) { log.error('-', 'salud_db', { error: e.message }); }
  const ok = dbOk && mqttTcn.connected && !apagando;
  // No expone IDs de máquinas ni datos de clientes: es una URL pública
  res.status(ok ? 200 : 503).json({ ok, db: dbOk, mqtt: mqttTcn.connected, ...cola,
    eventos_en_proceso: tcn.colasActivas(), alertas_telegram: log.telegramActivo(), uptime_s: Math.round(process.uptime()) });
});

app.use((err, req, res, _next) => {   // JSON malformado, cuerpo muy grande, etc.
  log.aviso('-', 'http_error', { ruta: req.originalUrl, error: err.message });
  res.status(err.status || 500).json({ ok: false });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  log.info('-', 'servicio_iniciado', { puerto: PORT, version: '2.3', instancia,
    multiples: multiples ? 'si' : 'no', telegram: log.telegramActivo() ? 'si' : 'no' });
  trabajos.iniciar();
});
server.keepAliveTimeout = 65000;   // mayor que el del balanceador de Render
server.headersTimeout = 66000;

// ── Apagado ordenado ──────────────────────────────────────────────────────────
// Render manda SIGTERM en cada deploy. Antes se cortaban reintentos y transacciones a la
// mitad; ahora se termina lo que está en curso y lo pendiente queda en la base.
async function apagar(motivo, codigo = 0) {
  if (apagando) return;
  apagando = true;
  log.aviso('-', 'apagando', { motivo });
  const forzar = setTimeout(() => process.exit(codigo || 1), 20000);
  try {
    clearInterval(intervaloMqtt);
    await new Promise((r) => server.close(r));
    await trabajos.detener();
    await tcn.esperarColas();
    await new Promise((r) => mqttTcn.end(false, {}, r));
    await db.end();
    clearTimeout(forzar);
    log.info('-', 'apagado_limpio', {});
    process.exit(codigo);
  } catch (e) {
    log.error('-', 'apagado_error', { error: e.message });
    process.exit(1);
  }
}
process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT', () => apagar('SIGINT'));
process.on('unhandledRejection', (e) => log.error('-', 'error_inesperado', { error: e && e.message ? e.message : String(e) }));
process.on('uncaughtException', (e) => {
  log.error('-', 'excepcion_no_capturada', { error: e.message, donde: (e.stack || '').split('\n')[1]?.trim() });
  apagar('uncaughtException', 1);   // estado incierto: salir y que Render reinicie (lo pendiente está en la base)
});
