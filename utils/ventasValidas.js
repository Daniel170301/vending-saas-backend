// utils/ventasValidas.js  (v3.6.3)
// Una venta "cuenta" en Inicio, rankings y totales solo si NO es de prueba y NO es devolución.
// Las dos marcas se ponen desde Ventas (PATCH /api/convenio/ventas/prueba y /devolucion).
const pool = require('../config/database');
const { columnaExiste } = require('./esquema');

// Condición SQL para una fila de historial_ventas con el alias dado (ej. 'v', 'NEW', 'OLD')
const VALIDA = (a = 'v') => `(NOT COALESCE(${a}.es_prueba, false) AND NOT COALESCE(${a}.es_devolucion, false))`;

// Crea las columnas si aún no existen (las mismas que crea routes/convenioRoutes.js).
// cli puede ser un cliente dentro de una transacción o el pool.
async function asegurarColumnas(cli = pool) {
  if (!(await columnaExiste('historial_ventas', 'es_prueba'))) {
    await cli.query('ALTER TABLE historial_ventas ADD COLUMN IF NOT EXISTS es_prueba BOOLEAN NOT NULL DEFAULT false');
    await cli.query('ALTER TABLE historial_ventas ADD COLUMN IF NOT EXISTS prueba_marcada_por VARCHAR(100)');
    await cli.query('ALTER TABLE historial_ventas ADD COLUMN IF NOT EXISTS prueba_marcada_en TIMESTAMP');
  }
  if (!(await columnaExiste('historial_ventas', 'es_devolucion'))) {
    await cli.query('ALTER TABLE historial_ventas ADD COLUMN IF NOT EXISTS es_devolucion BOOLEAN NOT NULL DEFAULT false');
    await cli.query('ALTER TABLE historial_ventas ADD COLUMN IF NOT EXISTS devolucion_motivo VARCHAR(200)');
    await cli.query('ALTER TABLE historial_ventas ADD COLUMN IF NOT EXISTS devolucion_marcada_por VARCHAR(100)');
    await cli.query('ALTER TABLE historial_ventas ADD COLUMN IF NOT EXISTS devolucion_marcada_en TIMESTAMP');
  }
}

// Para consultas directas: la condición si las columnas existen; si no, 'true' (todas cuentan)
async function filtroValidas(a = 'v') {
  const p = await columnaExiste('historial_ventas', 'es_prueba');
  const d = await columnaExiste('historial_ventas', 'es_devolucion');
  const partes = [];
  if (p) partes.push(`NOT COALESCE(${a}.es_prueba, false)`);
  if (d) partes.push(`NOT COALESCE(${a}.es_devolucion, false)`);
  return partes.length ? `(${partes.join(' AND ')})` : 'true';
}

module.exports = { VALIDA, asegurarColumnas, filtroValidas };
