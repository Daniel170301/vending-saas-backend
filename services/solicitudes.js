// services/solicitudes.js  (v3.6.6)
// Solicitudes de alta de máquinas: lo que llena el cliente en la página pública /registro.
// El superadmin las revisa, aprueba (se crea la máquina, el dueño y el celular de cobro) y
// descarga el archivo maquina.h con los valores de ESA placa para el firmware.
const pool = require('../config/database');

const TIPOS = {
  TCN:    { nombre: 'TCN',          prefijo: 'TCN',    firmware: 'TCN 3.x' },
  SNAKKY: { nombre: 'Necta Snakky', prefijo: 'SNAKKY', firmware: 'Necta 6.7+' },
  KIKKO:  { nombre: 'Necta Kikko',  prefijo: 'KIKKO',  firmware: 'Necta 6.7+' },
  SAMBA:  { nombre: 'Necta Samba',  prefijo: 'SAMBA',  firmware: 'Necta (perfil provisional)' },
  OTRA:   { nombre: 'Otra',         prefijo: 'MAQ',    firmware: 'por definir' },
};

// Perfil MDB de cada Necta (lo medido en el diagnóstico del 26-oct-2026 y la Samba del 10-nov)
const PERFIL_NECTA = {
  SNAKKY: { modelo: 'NECTA-SNAKKY', saldoEspera: 65535, ajusteItem: 0, preciosPropios: false },
  KIKKO:  { modelo: 'NECTA-KIKKO',  saldoEspera: 1,     ajusteItem: 1, preciosPropios: true },
  SAMBA:  { modelo: 'NECTA-SAMBA',  saldoEspera: 1,     ajusteItem: 0, preciosPropios: false },
};

let lista = null;
function asegurarTabla() {
  if (!lista) {
    lista = pool.query(`
      CREATE TABLE IF NOT EXISTS solicitudes_maquina (
        id               SERIAL PRIMARY KEY,
        estado           TEXT NOT NULL DEFAULT 'pendiente',   -- pendiente | aprobada | rechazada | instalada
        nombre           TEXT NOT NULL,
        telefono         TEXT NOT NULL,
        email            TEXT NOT NULL,
        lugar            TEXT NOT NULL,
        direccion        TEXT,
        distrito         TEXT,
        ciudad           TEXT,
        tipo_maquina     TEXT NOT NULL,
        cobro_numero     TEXT,
        datos            JSONB NOT NULL DEFAULT '{}'::jsonb,  -- el resto del formulario (sin claves)
        wifi_ssid_1      TEXT,
        wifi_pass_1_cif  TEXT,                                -- cifrada (utils/cifrado.js)
        wifi_ssid_2      TEXT,
        wifi_pass_2_cif  TEXT,
        qr_yape          TEXT,
        qr_valido        BOOLEAN,
        ip               TEXT,
        creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
        actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
        revisado_por     TEXT,
        revisado_en      TIMESTAMPTZ,
        motivo_rechazo   TEXT,
        machine_id       TEXT,
        cuenta_cobro_id  TEXT,
        id_dueno         TEXT,
        mqtt_pass_cif    TEXT,
        notas_internas   TEXT,
        instalada_en     TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS solicitudes_estado_idx ON solicitudes_maquina (estado, creado_en DESC);
    `).catch((e) => { lista = null; throw e; });
  }
  return lista;
}

const codigo = (id) => `SOL-${String(id).padStart(4, '0')}`;

// Siguiente MACHINE_ID libre para ese tipo: SNAKKY-0006, TCN-0007...
async function siguienteId(tipo, q = pool) {
  const pre = (TIPOS[tipo] || TIPOS.OTRA).prefijo;
  const patron = `^${pre}-[0-9]+$`;
  const r = await q.query(`
    SELECT COALESCE(max(substring(id FROM '[0-9]+$')::int), 0) AS n FROM (
      SELECT machine_id AS id FROM maquinas WHERE machine_id ~* $1
      UNION ALL SELECT code FROM maquinas WHERE code ~* $1
      UNION ALL SELECT machine_id FROM solicitudes_maquina WHERE machine_id ~* $1
    ) t`, [patron]);
  let n = Number(r.rows[0].n) + 1;
  if (await existeTabla(q, 'kymez', 'maquinas')) {
    const k = await q.query(`SELECT COALESCE(max(substring(machine_id FROM '[0-9]+$')::int), 0) AS n FROM kymez.maquinas WHERE machine_id ~* $1`, [patron]);
    n = Math.max(n, Number(k.rows[0].n) + 1);
  }
  return `${pre}-${String(n).padStart(4, '0')}`;
}

async function existeTabla(q, esquema, tabla) {
  const r = await q.query('SELECT to_regclass($1) IS NOT NULL AS ok', [`${esquema}.${tabla}`]);
  return r.rows[0].ok;
}

// ---------- maquina.h ----------
// Texto en C seguro: escapa comillas, barras y caracteres raros (octal de 3 cifras).
function c(texto) {
  let out = '';
  for (const b of Buffer.from(String(texto ?? ''), 'utf8')) {
    if (b === 0x22) out += '\\"';
    else if (b === 0x5C) out += '\\\\';
    else if (b >= 0x20 && b < 0x7F && b !== 0x3F) out += String.fromCharCode(b);   // ? se escapa (trigraphs)
    else out += '\\' + b.toString(8).padStart(3, '0');
  }
  return `"${out}"`;
}
const comentario = (t) => String(t ?? '').replace(/[\r\n]+/g, ' ').replace(/\*\//g, '* /').slice(0, 120);

/**
 * Genera include/maquina.h. El config.h del firmware lo incluye AL FINAL (una sola línea):
 *   #if __has_include("maquina.h")
 *   #include "maquina.h"
 *   #endif
 * Cada valor se define como MAQ_X y luego "#define X MAQ_X": como el resto del código se compila
 * después de config.h, usa el valor de esta máquina. Los secretos comunes (HMAC, certificado,
 * host de MQTT) siguen solo en el config.h de tu PC.
 *
 * s: fila de la solicitud ya aprobada; claves: { wifi1, wifi2, mqtt } en claro; precios: [{producto, centimos}]
 */
function generarMaquinaH(s, claves, { soporte = '', precios = [] } = {}) {
  const tipo = TIPOS[s.tipo_maquina] ? s.tipo_maquina : 'OTRA';
  const necta = PERFIL_NECTA[tipo];
  const avisos = [];
  const L = [];
  const def = (nombre, decl) => { L.push(decl); L.push(`#define ${nombre} MAQ_${nombre}`); };
  L.push('#pragma once');
  L.push('// ============================================================================');
  L.push(`//  maquina.h · generado por QhaPay (Superadmin › Solicitudes) el ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  L.push(`//  Solicitud ${codigo(s.id)} · ${comentario(s.lugar)} · ${comentario(s.distrito)} ${comentario(s.ciudad)}`);
  L.push(`//  Máquina: ${TIPOS[tipo].nombre} · firmware ${TIPOS[tipo].firmware}`);
  L.push('//  NO lo subas a GitHub ni lo mandes por chat: tiene la clave del WiFi y la de MQTT.');
  L.push('//  Cópialo a la carpeta include/ del proyecto y compila. Ver LEEME-maquina.md');
  L.push('// ============================================================================');
  L.push('#define KYMEZ_MAQUINA_H 1');
  L.push('');
  L.push('// ---------- Identidad ----------');
  def('MACHINE_ID', `constexpr char MAQ_MACHINE_ID[] = ${c(s.machine_id)};`);
  L.push('');
  L.push('// ---------- WiFi ----------');
  if (!s.wifi_ssid_1) avisos.push('Falta el nombre del WiFi');
  if (claves.wifi1 === null && s.wifi_ssid_1) avisos.push('La contraseña del WiFi ya se borró (máquina instalada o rechazada): escríbela a mano');
  def('WIFI_SSID_1', `constexpr char MAQ_WIFI_SSID_1[] = ${c(s.wifi_ssid_1 || '')};`);
  def('WIFI_PASS_1', `constexpr char MAQ_WIFI_PASS_1[] = ${c(claves.wifi1 || '')};`);
  def('WIFI_SSID_2', `constexpr char MAQ_WIFI_SSID_2[] = ${c(s.wifi_ssid_2 || '')};`);
  def('WIFI_PASS_2', `constexpr char MAQ_WIFI_PASS_2[] = ${c(claves.wifi2 || '')};`);
  L.push('');
  L.push(`// ---------- MQTT (en HiveMQ: usuario ${comentario(s.machine_id)}, permiso vending/${comentario(s.machine_id)}/#) ----------`);
  def('MQTT_USER', `constexpr char MAQ_MQTT_USER[] = ${c(s.machine_id)};`);
  def('MQTT_PASS', `constexpr char MAQ_MQTT_PASS[] = ${c(claves.mqtt || '')};`);
  if (!claves.mqtt) avisos.push('Sin clave MQTT');
  if (soporte) {
    L.push('');
    def('SOPORTE_TELEFONO', `static const char MAQ_SOPORTE_TELEFONO[] = ${c(soporte)};`);
  }
  if (s.qr_yape && s.qr_valido) {
    L.push('');
    L.push(`// ---------- QR de Yape del celular de cobro ${comentario(s.cuenta_cobro_id || '')} ----------`);
    def('QR_YAPE', `static const char MAQ_QR_YAPE[] = ${c(s.qr_yape)};`);
  } else {
    avisos.push('Sin QR de Yape válido: la placa usará el QR_YAPE de tu config.h');
  }
  if (necta) {
    L.push('');
    L.push(`// ---------- Perfil ${necta.modelo} ----------`);
    def('MACHINE_MODEL', `static const char MAQ_MACHINE_MODEL[] = ${c(necta.modelo)};`);
    def('SALDO_ESPERA_CENT', `constexpr uint16_t MAQ_SALDO_ESPERA_CENT = ${necta.saldoEspera};`);
    def('AJUSTE_ITEM_EFECTIVO', `constexpr int8_t MAQ_AJUSTE_ITEM_EFECTIVO = ${necta.ajusteItem};`);
    const filas = necta.preciosPropios ? precios.filter((p) => p.producto >= 0 && p.producto < 1000 && p.centimos > 0 && p.centimos <= 60000) : [];
    def('USAR_PRECIOS_PROPIOS', `constexpr bool MAQ_USAR_PRECIOS_PROPIOS = ${necta.preciosPropios ? 'true' : 'false'};`);
    L.push('constexpr PrecioProducto MAQ_PRECIOS_PROPIOS[] = {');
    if (filas.length) for (const p of filas) L.push(`  { ${String(p.producto).padStart(3)}, ${String(p.centimos).padStart(5)} },   // S/ ${(p.centimos / 100).toFixed(2)}`);
    else L.push('  {   0,     0 },   // sin precios');
    L.push('};');
    L.push('#define PRECIOS_PROPIOS MAQ_PRECIOS_PROPIOS');
    if (necta.preciosPropios && !filas.length) avisos.push('Kikko sin precios: llena el planograma en QhaPay (código de motor y precio) y vuelve a descargar');
    if (tipo === 'SAMBA') avisos.push('Samba: perfil provisional (SALDO_ESPERA 1). Confírmalo en la primera prueba');
  } else if (tipo === 'OTRA') {
    avisos.push('Máquina "Otra": revisa el nivel MDB y el perfil con el diagnóstico antes de instalar');
  }
  L.push('');
  return { texto: L.join('\n'), avisos };
}

module.exports = { TIPOS, PERFIL_NECTA, asegurarTabla, codigo, siguienteId, generarMaquinaH, existeTabla };
