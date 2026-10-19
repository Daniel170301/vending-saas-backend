-- Deshace la v3.4 (antes: MIGRAR_AL_INICIAR=false). Borra mensualidades y su historial de pagos.
-- NO borra máquinas, ventas ni usuarios. El candado (pago_al_dia) se queda como esté.
DROP TABLE IF EXISTS pagos_mensualidad;
ALTER TABLE usuarios_duenos DROP COLUMN IF EXISTS pagado_hasta;
ALTER TABLE usuarios_duenos DROP COLUMN IF EXISTS mensualidad;
ALTER TABLE maquinas DROP COLUMN IF EXISTS suspendida_en;
ALTER TABLE maquinas DROP COLUMN IF EXISTS mensaje_bloqueo;
