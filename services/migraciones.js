// services/migraciones.js
// Ajustes de rendimiento de la BD. Se ejecutan solos al arrancar (en segundo plano) y son
// seguros de repetir: si el índice o la columna ya existen, no hacen nada.
// Para desactivarlo: variable de entorno MIGRAR_AL_INICIAR=false
// (el mismo SQL está en migraciones/001_rendimiento.sql para correrlo desde DBeaver).
const pool = require('../config/database');

// [tabla, nombre del índice, definición, inicio de columnas para detectar uno equivalente]
const INDICES = [
  ['inventario', 'idx_inventario_maquina_motor', '(machine_id, codigo_motor)', '(machine_id, codigo_motor'],
  ['historial_ventas', 'idx_historial_ventas_maquina_fecha', '(machine_id, fecha DESC)', '(machine_id, fecha'],
  ['historial_ventas', 'idx_historial_ventas_fecha', '(fecha DESC)', '(fecha'],
  ['historial_abastecimiento', 'idx_historial_abast_maquina_fecha', '(machine_id, fecha DESC)', '(machine_id, fecha'],
  ['productos_almacen', 'idx_productos_almacen_dueno', '((id_dueno::text))', '(((id_dueno)::text)'],
  ['productos_almacen', 'idx_productos_almacen_nombre', '(name)', '(name'],
  ['maquinas', 'idx_maquinas_dueno', '((id_dueno::text))', '(((id_dueno)::text)'],
  ['usuarios_duenos', 'idx_usuarios_duenos_email', '(email)', '(email'],
];

async function paso(nombre, sql) {
  try {
    const r = await pool.query(sql);
    if (r.rowCount) console.log(`[migracion] ${nombre}: ${r.rowCount} fila(s)`);
    return true;
  } catch (e) {
    console.error(`[migracion] ${nombre} falló: ${e.message}`);
    return false;
  }
}

async function migrar() {
  if (process.env.MIGRAR_AL_INICIAR === 'false') {
    // No toca la BD, pero si los totales por día ya existen, los usa
    return require('./resumenVentas').detectar();
  }
  const t0 = Date.now();

  // 1) Versión de la foto: cambia la URL cuando cambia la foto (caché del navegador segura)
  await paso('columna imagen_version', 'ALTER TABLE productos_almacen ADD COLUMN IF NOT EXISTS imagen_version TEXT');
  await paso('fotos vacías -> NULL', "UPDATE productos_almacen SET image_url = NULL WHERE image_url = ''");
  await paso('versión de fotos existentes',
    `UPDATE productos_almacen SET imagen_version = substr(md5(image_url), 1, 10)
     WHERE image_url IS NOT NULL AND imagen_version IS NULL`);

  // 2) Índices (solo si no hay uno equivalente)
  for (const [tabla, nombre, definicion, inicio] of INDICES) {
    try {
      const { rows } = await pool.query('SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1', [tabla]);
      if (rows.some((r) => r.indexdef.includes(`USING btree ${inicio}`))) continue;
      await pool.query(`CREATE INDEX IF NOT EXISTS ${nombre} ON ${tabla} ${definicion}`);
      console.log(`[migracion] índice creado: ${nombre}`);
    } catch (e) {
      console.error(`[migracion] índice ${nombre} falló: ${e.message}`);
    }
  }

  // 3) Totales de ventas por día (Inicio y rankings rápidos con miles de máquinas)
  await require('./resumenVentas').instalar();

  await paso('estadísticas', 'ANALYZE inventario, historial_ventas, historial_abastecimiento, productos_almacen, maquinas, usuarios_duenos');
  console.log(`[migracion] lista en ${Date.now() - t0} ms`);
}

module.exports = { migrar };
