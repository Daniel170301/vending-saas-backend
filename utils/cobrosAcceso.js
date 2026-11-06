// utils/cobrosAcceso.js  (v3.6.1)
// Contraseña TEMPORAL para abrir "Celular de cobro" en la app Android.
//  - La genera el superadmin (Superadmin → Cobros Yape → Acceso a celular de cobro).
//  - Sirve UNA sola vez y vence sola (por defecto en 30 minutos).
//  - Se guarda solo su huella (sha256): ni en la base de datos se puede leer.
//  - El superadmin entra sin código. Los operarios nunca.
const crypto = require('crypto');
const pool = require('../config/database');

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // sin 0/O ni 1/I
const MIN_MINUTOS = 5;
const MAX_MINUTOS = 24 * 60;
const MINUTOS_ABIERTO = 15;                             // tiempo que la pantalla queda abierta en el celular

let listo = null;
function asegurarTabla() {
  if (!listo) {
    listo = pool.query(`
      CREATE TABLE IF NOT EXISTS cobros_codigos (
        id          SERIAL PRIMARY KEY,
        codigo_hash TEXT NOT NULL UNIQUE,
        nota        TEXT,
        creado_por  TEXT,
        creado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
        vence_en    TIMESTAMPTZ NOT NULL,
        usado_en    TIMESTAMPTZ,
        usado_por   TEXT,
        anulado_en  TIMESTAMPTZ
      )`).catch((e) => { listo = null; throw e; });
  }
  return listo;
}

const huella = (c) => crypto.createHash('sha256').update(`qhapay-cobros|${c}`).digest('hex');
const normalizar = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const mostrar = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;

function nuevoCodigo() {
  const b = crypto.randomBytes(8);
  let c = '';
  for (let i = 0; i < 8; i++) c += ALFABETO[b[i] % ALFABETO.length];
  return c;
}

async function generar({ minutos, nota, creadoPor }) {
  await asegurarTabla();
  const m = Math.min(MAX_MINUTOS, Math.max(MIN_MINUTOS, Math.round(Number(minutos) || 30)));
  for (let intento = 0; intento < 5; intento++) {
    const c = nuevoCodigo();
    try {
      const r = await pool.query(
        `INSERT INTO cobros_codigos (codigo_hash, nota, creado_por, vence_en)
         VALUES ($1, $2, $3, now() + make_interval(mins => $4)) RETURNING id, vence_en`,
        [huella(c), nota ? String(nota).slice(0, 120) : null, creadoPor || null, m]);
      return { id: r.rows[0].id, codigo: mostrar(c), vence_en: r.rows[0].vence_en, minutos: m };
    } catch (e) {
      if (e.code !== '23505') throw e;          // se repitió (casi imposible): otro
    }
  }
  throw new Error('no se pudo generar el código');
}

// Gasta el código (una sola vez, en una sola sentencia: dos celulares no pueden usar el mismo).
async function canjear(codigo, usadoPor) {
  await asegurarTabla();
  const c = normalizar(codigo);
  if (c.length !== 8) return null;
  const r = await pool.query(
    `UPDATE cobros_codigos SET usado_en = now(), usado_por = $2
      WHERE codigo_hash = $1 AND usado_en IS NULL AND anulado_en IS NULL AND vence_en > now()
      RETURNING id, nota`, [huella(c), usadoPor || null]);
  return r.rows[0] || null;
}

async function listar() {
  await asegurarTabla();
  const r = await pool.query(
    `SELECT id, nota, creado_por, creado_en, vence_en, usado_en, usado_por, anulado_en,
            CASE WHEN anulado_en IS NOT NULL THEN 'anulado'
                 WHEN usado_en IS NOT NULL THEN 'usado'
                 WHEN vence_en <= now() THEN 'vencido'
                 ELSE 'vigente' END AS estado
       FROM cobros_codigos ORDER BY id DESC LIMIT 30`);
  return r.rows;
}

async function anular(id) {
  await asegurarTabla();
  const r = await pool.query(
    `UPDATE cobros_codigos SET anulado_en = now() WHERE id = $1 AND usado_en IS NULL AND anulado_en IS NULL RETURNING id`,
    [Number(id) || 0]);
  return r.rowCount > 0;
}

module.exports = { asegurarTabla, generar, canjear, listar, anular, MINUTOS_ABIERTO, MIN_MINUTOS, MAX_MINUTOS };
