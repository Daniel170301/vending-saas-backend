-- ============================================================================
--  Qhapay · DESHACER lo que agregó la v3.3 (entorno superadmin)
--  Solo si vuelves a una versión anterior del servidor y quieres dejar la BD como estaba.
--  ANTES pon MIGRAR_AL_INICIAR=false en Render (o vuelve a la versión anterior);
--  si no, la v3.3 lo vuelve a crear al reiniciar.
--
--  OJO: borra los códigos KMT asignados, las regiones y el historial de auditoría.
--  NO borra máquinas, ventas, inventario, abastecimientos, gastos ni usuarios.
-- ============================================================================
DROP INDEX IF EXISTS ux_maquinas_codigo_kmt;
DROP INDEX IF EXISTS ux_maquinas_region_numero;
ALTER TABLE maquinas DROP COLUMN IF EXISTS codigo_kmt;
ALTER TABLE maquinas DROP COLUMN IF EXISTS numero_kmt;
ALTER TABLE maquinas DROP COLUMN IF EXISTS region_id;
DROP TABLE IF EXISTS regiones;
DROP TABLE IF EXISTS auditoria_superadmin;
