// utils/esquema.js
// Pregunta (una sola vez) si una columna existe, para que el código funcione igual
// antes y después de que corra la migración.
const pool = require('../config/database');

const confirmadas = new Set();

async function columnaExiste(tabla, columna) {
  const clave = `${tabla}.${columna}`;
  if (confirmadas.has(clave)) return true;
  const { rowCount } = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`, [tabla, columna]);
  if (rowCount) confirmadas.add(clave);
  return rowCount > 0;
}

module.exports = { columnaExiste };
