// services/hashearClaves.js
// v3.5 · Pasa a hash, de una vez, todas las contraseñas que siguen en texto plano en
// usuarios_duenos (las de quienes todavía no han vuelto a entrar). Corre solo al arrancar,
// en segundo plano, y es seguro de repetir: solo toca las que no empiezan con "scrypt$".
const pool = require('../config/database');
const clave = require('../utils/clave');

async function hashearPendientes() {
  const { rows } = await pool.query(
    `SELECT id, password FROM usuarios_duenos
      WHERE password IS NOT NULL AND password <> '' AND password <> $1 AND password NOT LIKE 'scrypt$%'`,
    [clave.MARCA_GOOGLE]);
  let n = 0;
  for (const u of rows) {
    // "AND password = $3": si justo la cambió alguien mientras tanto, no se pisa
    const r = await pool.query('UPDATE usuarios_duenos SET password = $1 WHERE id = $2 AND password = $3',
      [await clave.hashear(u.password), u.id, u.password]);
    n += r.rowCount;
  }
  if (rows.length) console.log(`[claves] ${n} contraseña(s) antiguas guardadas ahora con hash`);
  return n;
}

module.exports = { hashearPendientes };
