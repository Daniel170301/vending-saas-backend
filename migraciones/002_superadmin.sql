-- ============================================================================
--  Qhapay · Entorno superadmin (v3.3)
--  El servidor ya ejecuta esto solo al arrancar (services/migraciones.js).
--  Este archivo es por si prefieres correrlo a mano desde DBeaver.
--  Se puede ejecutar varias veces sin problema. Todo es AGREGADO: no modifica ni
--  borra máquinas, ventas, inventario ni usuarios.
-- ============================================================================

-- Regiones del código KMT:  KMT-<región>-<número>   (KMT-1-0003 = Lima, máquina 0003)
CREATE TABLE IF NOT EXISTS regiones (
  id         integer PRIMARY KEY CHECK (id BETWEEN 1 AND 99),
  nombre     text NOT NULL,
  activa     boolean NOT NULL DEFAULT true,
  creado_en  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO regiones (id, nombre) VALUES (1, 'Lima'), (2, 'Trujillo'), (3, 'Cañete')
ON CONFLICT (id) DO NOTHING;
CREATE UNIQUE INDEX IF NOT EXISTS ux_regiones_nombre ON regiones (lower(nombre));

-- Código KMT de cada máquina (lo asigna solo el superadmin; machine_id NO cambia)
ALTER TABLE maquinas ADD COLUMN IF NOT EXISTS region_id  integer;
ALTER TABLE maquinas ADD COLUMN IF NOT EXISTS numero_kmt integer;
ALTER TABLE maquinas ADD COLUMN IF NOT EXISTS codigo_kmt text;
CREATE UNIQUE INDEX IF NOT EXISTS ux_maquinas_codigo_kmt    ON maquinas (codigo_kmt);
CREATE UNIQUE INDEX IF NOT EXISTS ux_maquinas_region_numero ON maquinas (region_id, numero_kmt);

-- Historial de lo que hace el superadmin
CREATE TABLE IF NOT EXISTS auditoria_superadmin (
  id          bigserial PRIMARY KEY,
  usuario     text,
  accion      text NOT NULL,
  machine_id  text,
  detalle     jsonb,
  creado_en   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auditoria_maquina ON auditoria_superadmin (machine_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_auditoria_fecha   ON auditoria_superadmin (creado_en DESC);
