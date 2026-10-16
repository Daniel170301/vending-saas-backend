// utils/tiempo.js
// Fechas de historial_ventas en la zona del negocio (America/Lima).
// historial_ventas.fecha suele ser "timestamp" SIN zona y guarda la hora de la sesión de la BD
// (UTC en Render). Estas expresiones sirven para ambos tipos de columna.
const pool = require('../config/database');
const { ZONA } = require('../services/resumenVentas');

let conZona = null;
async function fechaConZona() {
  if (conZona === null) {
    const r = await pool.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'historial_ventas' AND column_name = 'fecha'`);
    conZona = r.rows[0]?.data_type === 'timestamp with time zone';
  }
  return conZona;
}

// La columna como instante absoluto (timestamptz): así el JSON sale con la hora correcta
async function comoInstante(col) {
  return (await fechaConZona()) ? `(${col})` : `((${col}) AT TIME ZONE current_setting('TimeZone'))`;
}

// Inicio del día local (Lima) de hace N días, en el MISMO tipo que la columna fecha:
// se puede comparar directo con v.fecha y usa el índice.
async function inicioDia(diasAtras = 0) {
  const n = Math.max(0, Math.floor(Number(diasAtras) || 0));
  const local = `(date_trunc('day', now() AT TIME ZONE '${ZONA}') - interval '${n} days')`;
  return (await fechaConZona())
    ? `(${local} AT TIME ZONE '${ZONA}')`
    : `((${local} AT TIME ZONE '${ZONA}') AT TIME ZONE current_setting('TimeZone'))`;
}

// "Hace N horas" en el tipo de la columna fecha
async function haceHoras(horas) {
  const h = Math.max(0, Number(horas) || 0);
  return (await fechaConZona())
    ? `(now() - interval '${h} hours')`
    : `((now() - interval '${h} hours') AT TIME ZONE current_setting('TimeZone'))`;
}

// Día local de una fecha de historial_ventas (para agrupar por día)
async function diaLocal(col) {
  return (await fechaConZona())
    ? `((${col}) AT TIME ZONE '${ZONA}')::date`
    : `(((${col}) AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE '${ZONA}')::date`;
}

const HOY = `(now() AT TIME ZONE '${ZONA}')::date`;

module.exports = { ZONA, HOY, fechaConZona, comoInstante, inicioDia, haceHoras, diaLocal };
