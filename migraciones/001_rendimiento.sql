-- ============================================================================
--  Qhapay · Ajustes de rendimiento (v3.1)
--  El servidor ya ejecuta esto solo al arrancar (services/migraciones.js).
--  Este archivo es por si prefieres correrlo a mano desde DBeaver.
--  Se puede ejecutar varias veces sin problema.
--  Las tablas de totales por día y su trigger los crea SOLO el servidor
--  (services/resumenVentas.js), no este archivo.
-- ============================================================================

-- Versión de la foto: la URL de la imagen cambia cuando cambia la foto
ALTER TABLE productos_almacen ADD COLUMN IF NOT EXISTS imagen_version TEXT;
UPDATE productos_almacen SET image_url = NULL WHERE image_url = '';
UPDATE productos_almacen SET imagen_version = substr(md5(image_url), 1, 10)
 WHERE image_url IS NOT NULL AND imagen_version IS NULL;

-- Índices (si ya tienes uno equivalente, puedes saltarte esa línea)
CREATE INDEX IF NOT EXISTS idx_inventario_maquina_motor       ON inventario (machine_id, codigo_motor);
CREATE INDEX IF NOT EXISTS idx_historial_ventas_maquina_fecha ON historial_ventas (machine_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_historial_ventas_fecha         ON historial_ventas (fecha DESC);
CREATE INDEX IF NOT EXISTS idx_historial_abast_maquina_fecha  ON historial_abastecimiento (machine_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_productos_almacen_dueno        ON productos_almacen ((id_dueno::text));
CREATE INDEX IF NOT EXISTS idx_productos_almacen_nombre       ON productos_almacen (name);
CREATE INDEX IF NOT EXISTS idx_maquinas_dueno                 ON maquinas ((id_dueno::text));
CREATE INDEX IF NOT EXISTS idx_usuarios_duenos_email          ON usuarios_duenos (email);

ANALYZE inventario, historial_ventas, historial_abastecimiento, productos_almacen, maquinas, usuarios_duenos;

-- Para ver qué índices tienes:
-- SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1;
