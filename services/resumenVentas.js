// services/resumenVentas.js
// Totales de ventas por DÍA, siempre al día, para que Inicio y Rankings no tengan que sumar
// millones de filas de historial_ventas en cada consulta.
//
//   ventas_dia_maquina   (machine_id, dia, unidades, monto)        -> ventas de un día por máquina
//   ventas_mes_maquina   (machine_id, mes, unidades, monto)        -> ranking de máquinas del año
//   ventas_dia_producto  (id_dueno, dia, producto, unidades, monto) -> productos más vendidos y ganancia
//
// Un trigger en historial_ventas los actualiza con CADA venta, venga de donde venga
// (este servidor, kymez-pagos o DBeaver). Si el trigger fallara, NUNCA bloquea la venta:
// solo deja un aviso, y la revisión nocturna (03:10) recalcula los últimos 3 días.
const pool = require('../config/database');

const ZONA_VALIDA = /^[A-Za-z][A-Za-z0-9_+\-/]{0,40}$/;
const ZONA = ZONA_VALIDA.test(process.env.NEGOCIO_ZONA || '') ? process.env.NEGOCIO_ZONA : 'America/Lima';

let listo = false;
const disponible = () => listo;

// Día local del negocio para una fecha de historial_ventas
async function exprDia(cli, col) {
  const r = await cli.query(
    `SELECT data_type FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'historial_ventas' AND column_name = 'fecha'`);
  const conZona = r.rows[0]?.data_type === 'timestamp with time zone';
  // Sin zona horaria: DEFAULT now() guarda la hora en la zona de la sesión (la de la BD)
  return conZona
    ? `((${col}) AT TIME ZONE '${ZONA}')::date`
    : `(((${col}) AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE '${ZONA}')::date`;
}

const MONTO = (fila) => `COALESCE(NULLIF(${fila}.precio::text, '')::numeric, 0)`;
const PRODUCTO = (fila) => `COALESCE(NULLIF(${fila}.nombre_producto, ''), 'Venta libre')`;

async function instalar() {
  const cli = await pool.connect();
  try {
    await cli.query("SET lock_timeout = '15s'");
    await cli.query('BEGIN');
    await cli.query('SELECT pg_advisory_xact_lock(424242)');   // si hay 2 instancias, solo una instala

    await cli.query(`CREATE TABLE IF NOT EXISTS ventas_dia_maquina (
      machine_id text NOT NULL, dia date NOT NULL,
      unidades integer NOT NULL DEFAULT 0, monto numeric NOT NULL DEFAULT 0,
      PRIMARY KEY (machine_id, dia))`);
    await cli.query(`CREATE TABLE IF NOT EXISTS ventas_mes_maquina (
      machine_id text NOT NULL, mes date NOT NULL,
      unidades integer NOT NULL DEFAULT 0, monto numeric NOT NULL DEFAULT 0,
      PRIMARY KEY (machine_id, mes))`);
    await cli.query(`CREATE TABLE IF NOT EXISTS ventas_dia_producto (
      id_dueno text NOT NULL, dia date NOT NULL, producto text NOT NULL,
      unidades integer NOT NULL DEFAULT 0, monto numeric NOT NULL DEFAULT 0,
      PRIMARY KEY (id_dueno, dia, producto))`);

    const diaNew = await exprDia(cli, 'NEW.fecha');
    const diaOld = await exprDia(cli, 'OLD.fecha');
    await cli.query(`
      CREATE OR REPLACE FUNCTION qhapay_resumen_venta() RETURNS trigger LANGUAGE plpgsql AS $f$
      DECLARE d date; dueno text; m numeric; p text;
      BEGIN
        -- Cambio de código de una máquina: mueve los totales de una sola vez (services/codigoMaquina.js)
        IF current_setting('qhapay.sin_resumen', true) = 'on' THEN RETURN NULL; END IF;
        BEGIN
          IF TG_OP IN ('DELETE', 'UPDATE') THEN
            d := ${diaOld}; m := ${MONTO('OLD')}; p := ${PRODUCTO('OLD')};
            SELECT id_dueno::text INTO dueno FROM maquinas WHERE machine_id = OLD.machine_id;
            UPDATE ventas_dia_maquina SET unidades = unidades - 1, monto = monto - m
              WHERE machine_id = OLD.machine_id AND dia = d;
            UPDATE ventas_mes_maquina SET unidades = unidades - 1, monto = monto - m
              WHERE machine_id = OLD.machine_id AND mes = date_trunc('month', d)::date;
            UPDATE ventas_dia_producto SET unidades = unidades - 1, monto = monto - m
              WHERE id_dueno = COALESCE(dueno, '') AND dia = d AND producto = p;
          END IF;
          IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.machine_id IS NOT NULL THEN
            d := ${diaNew}; m := ${MONTO('NEW')}; p := ${PRODUCTO('NEW')};
            SELECT id_dueno::text INTO dueno FROM maquinas WHERE machine_id = NEW.machine_id;
            INSERT INTO ventas_dia_maquina AS t (machine_id, dia, unidades, monto) VALUES (NEW.machine_id, d, 1, m)
              ON CONFLICT (machine_id, dia) DO UPDATE SET unidades = t.unidades + 1, monto = t.monto + EXCLUDED.monto;
            INSERT INTO ventas_mes_maquina AS t (machine_id, mes, unidades, monto) VALUES (NEW.machine_id, date_trunc('month', d)::date, 1, m)
              ON CONFLICT (machine_id, mes) DO UPDATE SET unidades = t.unidades + 1, monto = t.monto + EXCLUDED.monto;
            INSERT INTO ventas_dia_producto AS t (id_dueno, dia, producto, unidades, monto) VALUES (COALESCE(dueno, ''), d, p, 1, m)
              ON CONFLICT (id_dueno, dia, producto) DO UPDATE SET unidades = t.unidades + 1, monto = t.monto + EXCLUDED.monto;
          END IF;
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'qhapay_resumen_venta: %', SQLERRM;   -- la venta se guarda igual
        END;
        RETURN NULL;
      END $f$`);

    // Bloquea un instante las ventas nuevas para no contar dos veces mientras se instala
    await cli.query('LOCK TABLE historial_ventas IN SHARE ROW EXCLUSIVE MODE');
    await cli.query('DROP TRIGGER IF EXISTS trg_qhapay_resumen_venta ON historial_ventas');
    await cli.query(`CREATE TRIGGER trg_qhapay_resumen_venta
      AFTER INSERT OR DELETE OR UPDATE OF machine_id, precio, nombre_producto, fecha ON historial_ventas
      FOR EACH ROW EXECUTE FUNCTION qhapay_resumen_venta()`);

    // Primera vez: llena con todo el historial
    const vacio = (await cli.query(
      'SELECT NOT EXISTS (SELECT 1 FROM ventas_dia_maquina) OR NOT EXISTS (SELECT 1 FROM ventas_mes_maquina) AS v')).rows[0].v;
    if (vacio) {
      const t0 = Date.now();
      await llenar(cli, null);
      console.log(`[resumen-ventas] historial cargado en ${Date.now() - t0} ms`);
    }
    await cli.query('COMMIT');
    listo = true;
    console.log('[resumen-ventas] activo');
  } catch (e) {
    await cli.query('ROLLBACK').catch(() => {});
    console.error('[resumen-ventas] no se pudo instalar (Inicio usará el cálculo lento):', e.message);
  } finally {
    cli.release();
  }
}

// Recalcula desde un día (o todo si desdeDias es null). Debe correr dentro de una transacción.
async function llenar(cli, desdeDias) {
  const dia = await exprDia(cli, 'v.fecha');
  const filtro = desdeDias == null ? '' : `WHERE v.fecha >= now() - make_interval(days => ${Number(desdeDias) + 1})`;
  const corte = desdeDias == null ? '' : `WHERE dia >= ((now() AT TIME ZONE '${ZONA}')::date - ${Number(desdeDias)})`;
  await cli.query(`DELETE FROM ventas_dia_maquina ${corte}`);
  await cli.query(`DELETE FROM ventas_dia_producto ${corte}`);
  const base = `
    SELECT v.machine_id, ${dia} AS dia, ${MONTO('v')} AS monto, ${PRODUCTO('v')} AS producto,
           COALESCE(m.id_dueno::text, '') AS id_dueno
    FROM historial_ventas v LEFT JOIN maquinas m ON m.machine_id = v.machine_id
    ${filtro}`;
  await cli.query(`
    INSERT INTO ventas_dia_maquina (machine_id, dia, unidades, monto)
    SELECT machine_id, dia, count(*), sum(monto) FROM (${base}) x
    WHERE machine_id IS NOT NULL ${corte ? `AND ${corte.slice(6)}` : ''}
    GROUP BY 1, 2`);
  // Mensual por máquina: se recalcula desde el diario (los meses tocados por el corte)
  const corteMes = desdeDias == null ? '' :
    `WHERE mes >= date_trunc('month', (now() AT TIME ZONE '${ZONA}')::date - ${Number(desdeDias)})::date`;
  await cli.query(`DELETE FROM ventas_mes_maquina ${corteMes}`);
  await cli.query(`
    INSERT INTO ventas_mes_maquina (machine_id, mes, unidades, monto)
    SELECT machine_id, date_trunc('month', dia)::date, SUM(unidades), SUM(monto) FROM ventas_dia_maquina
    ${corteMes ? corteMes.replace('mes >=', "date_trunc('month', dia)::date >=") : ''}
    GROUP BY 1, 2`);
  await cli.query(`
    INSERT INTO ventas_dia_producto (id_dueno, dia, producto, unidades, monto)
    SELECT id_dueno, dia, producto, count(*), sum(monto) FROM (${base}) x
    WHERE machine_id IS NOT NULL ${corte ? `AND ${corte.slice(6)}` : ''}
    GROUP BY 1, 2, 3`);
}

// Recalcula los totales de un rango de días locales (incluidos) para TODAS las máquinas.
// Debe correr dentro de una transacción que ya bloqueó historial_ventas (SHARE ROW EXCLUSIVE).
// Lo usa "mover datos sin máquina": esas ventas pudieron contarse antes con otro dueño.
async function recalcularRango(cli, desdeDia, hastaDia) {
  const dia = await exprDia(cli, 'v.fecha');
  const base = `
    SELECT v.machine_id, ${dia} AS dia, ${MONTO('v')} AS monto, ${PRODUCTO('v')} AS producto,
           COALESCE(m.id_dueno::text, '') AS id_dueno
    FROM historial_ventas v LEFT JOIN maquinas m ON m.machine_id = v.machine_id
    WHERE v.fecha >= ($1::date - 1) AND v.fecha < ($2::date + 2)`;
  await cli.query('DELETE FROM ventas_dia_maquina WHERE dia BETWEEN $1::date AND $2::date', [desdeDia, hastaDia]);
  await cli.query('DELETE FROM ventas_dia_producto WHERE dia BETWEEN $1::date AND $2::date', [desdeDia, hastaDia]);
  await cli.query(`
    INSERT INTO ventas_dia_maquina (machine_id, dia, unidades, monto)
    SELECT machine_id, dia, count(*), sum(monto) FROM (${base}) x
    WHERE machine_id IS NOT NULL AND dia BETWEEN $1::date AND $2::date
    GROUP BY 1, 2`, [desdeDia, hastaDia]);
  await cli.query(`
    INSERT INTO ventas_dia_producto (id_dueno, dia, producto, unidades, monto)
    SELECT id_dueno, dia, producto, count(*), sum(monto) FROM (${base}) x
    WHERE machine_id IS NOT NULL AND dia BETWEEN $1::date AND $2::date
    GROUP BY 1, 2, 3`, [desdeDia, hastaDia]);
  // Meses tocados: se rehacen desde el diario
  await cli.query(`
    DELETE FROM ventas_mes_maquina
    WHERE mes BETWEEN date_trunc('month', $1::date)::date AND date_trunc('month', $2::date)::date`, [desdeDia, hastaDia]);
  await cli.query(`
    INSERT INTO ventas_mes_maquina (machine_id, mes, unidades, monto)
    SELECT machine_id, date_trunc('month', dia)::date, SUM(unidades), SUM(monto) FROM ventas_dia_maquina
    WHERE dia >= date_trunc('month', $1::date)::date AND dia < (date_trunc('month', $2::date) + interval '1 month')::date
    GROUP BY 1, 2`, [desdeDia, hastaDia]);
}

// Sin instalar nada: activa la versión rápida si el trigger ya existe (MIGRAR_AL_INICIAR=false)
async function detectar() {
  try {
    const r = await pool.query("SELECT 1 FROM pg_trigger WHERE tgname = 'trg_qhapay_resumen_venta' AND NOT tgisinternal");
    listo = r.rowCount > 0;
  } catch { listo = false; }
}

// Revisión nocturna: corrige cualquier diferencia de los últimos días
async function revisar(dias = 3) {
  if (!listo) return;
  const cli = await pool.connect();
  try {
    await cli.query("SET lock_timeout = '15s'");
    await cli.query('BEGIN');
    await cli.query('LOCK TABLE historial_ventas IN SHARE ROW EXCLUSIVE MODE');
    await llenar(cli, dias);
    await cli.query('COMMIT');
    console.log(`[resumen-ventas] revisión de los últimos ${dias} días lista`);
  } catch (e) {
    await cli.query('ROLLBACK').catch(() => {});
    console.error('[resumen-ventas] revisión falló:', e.message);
  } finally {
    cli.release();
  }
}

module.exports = { instalar, detectar, revisar, recalcularRango, disponible, ZONA };
