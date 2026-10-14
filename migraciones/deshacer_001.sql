-- ============================================================================
--  Qhapay · DESHACER los cambios de base de datos de la v3.1
--  Solo si vuelves a la versión anterior del servidor y quieres dejar la BD
--  exactamente como estaba. NO borra ventas, máquinas, productos ni inventario:
--  solo quita lo que la v3.1 agregó.
--
--  ANTES de correrlo, en Render pon MIGRAR_AL_INICIAR=false (o vuelve a la versión
--  anterior del servidor); si no, la v3.1 lo vuelve a crear al reiniciar.
--
--  Lo que NO se puede deshacer con este archivo (para eso está tu respaldo):
--   - las fotos que optimizaste con "npm run optimizar-imagenes"
--   - las fotos vacías ('') que quedaron como NULL (significan lo mismo: sin foto)
-- ============================================================================

-- Totales de ventas por día (trigger, función y sus 3 tablas)
DROP TRIGGER IF EXISTS trg_qhapay_resumen_venta ON historial_ventas;
DROP FUNCTION IF EXISTS qhapay_resumen_venta();
DROP TABLE IF EXISTS ventas_dia_maquina;
DROP TABLE IF EXISTS ventas_mes_maquina;
DROP TABLE IF EXISTS ventas_dia_producto;

-- Índices creados por la v3.1 (si alguno ya existía con otro nombre, no se tocó)
DROP INDEX IF EXISTS idx_inventario_maquina_motor;
DROP INDEX IF EXISTS idx_historial_ventas_maquina_fecha;
DROP INDEX IF EXISTS idx_historial_ventas_fecha;
DROP INDEX IF EXISTS idx_historial_abast_maquina_fecha;
DROP INDEX IF EXISTS idx_productos_almacen_dueno;
DROP INDEX IF EXISTS idx_productos_almacen_nombre;
DROP INDEX IF EXISTS idx_maquinas_dueno;
DROP INDEX IF EXISTS idx_usuarios_duenos_email;

-- Columna de versión de las fotos
ALTER TABLE productos_almacen DROP COLUMN IF EXISTS imagen_version;
