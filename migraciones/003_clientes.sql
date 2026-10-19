-- ============================================================================
--  Qhapay · Clientes: mensualidad y suspensión por falta de pago (v3.4)
--  El servidor ya ejecuta esto solo al arrancar. Se puede repetir sin problema.
--  Todo es AGREGADO: no modifica ni borra datos.
-- ============================================================================
ALTER TABLE maquinas        ADD COLUMN IF NOT EXISTS mensaje_bloqueo text;
ALTER TABLE maquinas        ADD COLUMN IF NOT EXISTS suspendida_en   timestamptz;
ALTER TABLE usuarios_duenos ADD COLUMN IF NOT EXISTS mensualidad     numeric;
ALTER TABLE usuarios_duenos ADD COLUMN IF NOT EXISTS pagado_hasta    date;
CREATE TABLE IF NOT EXISTS pagos_mensualidad (
  id              bigserial PRIMARY KEY,
  id_dueno        text NOT NULL,
  monto           numeric,
  meses           integer NOT NULL,
  pagado_desde    date,
  pagado_hasta    date NOT NULL,
  nota            text,
  registrado_por  text,
  creado_en       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pagos_mensualidad_dueno ON pagos_mensualidad (id_dueno, creado_en DESC);
