// utils/clientesDueno.js
// v3.5 · Los clientes (puntos de venta, tabla empresas_clientes) no guardaban quién los creó, y
// GET /api/clients devolvía los de TODOS los dueños. Se agrega la columna id_dueno y se llena con
// el dueño de la máquina donde ya está ese cliente. Seguro de repetir.
const pool = require('../config/database');

let listo = null;

function asegurar() {
  if (!listo) {
    listo = (async () => {
      await pool.query('ALTER TABLE empresas_clientes ADD COLUMN IF NOT EXISTS id_dueno text');
      await pool.query(`
        UPDATE empresas_clientes c SET id_dueno = s.id_dueno
          FROM (SELECT DISTINCT ON (id_cliente_punto::text) id_cliente_punto::text AS punto, id_dueno::text AS id_dueno
                  FROM maquinas WHERE id_cliente_punto IS NOT NULL AND id_dueno IS NOT NULL
                 ORDER BY id_cliente_punto::text, machine_id) s
         WHERE c.id_dueno IS NULL AND c.id_usuario::text = s.punto`);
    })().catch((e) => { listo = null; throw e; });
  }
  return listo;
}

module.exports = { asegurar };
