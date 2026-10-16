// services/identidadMaquina.js
// Cada máquina tiene DOS identificadores (como en Nayax: "máquina" y "equipo"):
//
//  1) CÓDIGO KMT  ->  KMT-<región>-<número>, ej. KMT-1-0003 = Kymez Servitech · Lima · Máquina 0003
//     Es el código de la máquina para ti y tus clientes. Lo asigna SOLO el superadmin.
//     Columnas: maquinas.codigo_kmt, region_id, numero_kmt. No mueve ningún dato.
//
//  2) ID DEL EQUIPO  ->  maquinas.machine_id (TCN-0003, B4-BF-E9-62-21-28…)
//     Es el de la placa: el MACHINE_ID del firmware (config.h), el usuario de HiveMQ y kymez-pagos.
//     Si cambias la placa de una máquina, cambias este ID y todo su historial la sigue.
//     Las máquinas creadas por clientes quedan con un ID provisional PEND-XXXXXX hasta que se
//     vincule su equipo.
const crypto = require('crypto');
const pool = require('../config/database');
const { columnaExiste } = require('../utils/esquema');

// ─────────────────────────────────────────────────────────────────────────────
//  Utilidades
// ─────────────────────────────────────────────────────────────────────────────
function error(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) e.extra = extra;
  return e;
}
const limpiar = (valor) => (valor === undefined || valor === null ? '' : String(valor).trim());
const qi = (nombre) => '"' + String(nombre).replace(/"/g, '""') + '"';

// ─────────────────────────────────────────────────────────────────────────────
//  1) CÓDIGO KMT
// ─────────────────────────────────────────────────────────────────────────────
const PREFIJO = /^[A-Z]{2,6}$/.test(String(process.env.CODIGO_PREFIJO || '').toUpperCase())
  ? String(process.env.CODIGO_PREFIJO).toUpperCase() : 'KMT';
const EMPRESA = String(process.env.CODIGO_EMPRESA || 'Kymez Servitech').slice(0, 60);
const NUMERO_MAX = 9999;

const numero4 = (n) => String(n).padStart(4, '0');
const formatearKMT = (regionId, numero) => `${PREFIJO}-${regionId}-${numero4(numero)}`;
const describirKMT = (regionNombre, numero) =>
  `${EMPRESA} · ${regionNombre || 'Región ?'} · Máquina ${numero4(numero)}`;

// ¿Ya corrió la migración de la v3.3? (antes de eso las consultas no usan las columnas nuevas)
async function hayKMT() {
  return (await columnaExiste('maquinas', 'codigo_kmt')) && (await columnaExiste('regiones', 'nombre'));
}

async function siguienteNumero(q, regionId) {
  const { rows } = await q.query(
    'SELECT COALESCE(max(numero_kmt), 0) + 1 AS n FROM maquinas WHERE region_id = $1', [regionId]);
  return Math.min(Number(rows[0].n) || 1, NUMERO_MAX);
}

async function leerRegion(q, regionId) {
  const id = Number(regionId);
  if (!Number.isInteger(id) || id < 1 || id > 99) throw error(400, 'Elige una región válida.');
  const { rows } = await q.query('SELECT id, nombre, activa FROM regiones WHERE id = $1', [id]);
  if (!rows.length) throw error(400, `La región ${id} no existe. Créala primero en Regiones.`);
  return rows[0];
}

/**
 * Asigna (o cambia) el código KMT de una máquina. Debe correr dentro de una transacción.
 * numero vacío -> el siguiente libre de esa región.
 * Devuelve { anterior, codigo, region, numero }.
 */
async function asignarKMT(client, machineId, regionId, numero) {
  const fila = await client.query(
    'SELECT machine_id, codigo_kmt FROM maquinas WHERE machine_id = $1 FOR UPDATE', [machineId]);
  if (!fila.rowCount) throw error(404, 'La máquina no existe. Recarga la página.');
  const region = await leerRegion(client, regionId);
  if (!region.activa) throw error(400, `La región ${region.nombre} está desactivada.`);

  // Dos asignaciones a la vez en la misma región no eligen el mismo número
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`kmt|${region.id}`]);
  let n = numero === undefined || numero === null || numero === '' ? null : Number(numero);
  if (n === null) n = await siguienteNumero(client, region.id);
  if (!Number.isInteger(n) || n < 1 || n > NUMERO_MAX) throw error(400, `El número debe estar entre 1 y ${NUMERO_MAX}.`);

  const codigo = formatearKMT(region.id, n);
  const ocupada = await client.query(
    `SELECT machine_id, COALESCE(NULLIF(btrim(name), ''), machine_id) AS nombre FROM maquinas
     WHERE ((region_id = $1 AND numero_kmt = $2) OR codigo_kmt = $3) AND machine_id <> $4 LIMIT 1`,
    [region.id, n, codigo, machineId]);
  if (ocupada.rowCount) {
    throw error(409, `El código ${codigo} ya lo tiene "${ocupada.rows[0].nombre}".`,
      { ocupado_por: ocupada.rows[0].machine_id, sugerido: formatearKMT(region.id, await siguienteNumero(client, region.id)) });
  }
  await client.query(
    'UPDATE maquinas SET region_id = $1, numero_kmt = $2, codigo_kmt = $3 WHERE machine_id = $4',
    [region.id, n, codigo, machineId]);
  return { anterior: fila.rows[0].codigo_kmt || null, codigo, region, numero: n };
}

async function quitarKMT(client, machineId) {
  const fila = await client.query(
    'SELECT codigo_kmt FROM maquinas WHERE machine_id = $1 FOR UPDATE', [machineId]);
  if (!fila.rowCount) throw error(404, 'La máquina no existe. Recarga la página.');
  await client.query(
    'UPDATE maquinas SET region_id = NULL, numero_kmt = NULL, codigo_kmt = NULL WHERE machine_id = $1', [machineId]);
  return { anterior: fila.rows[0].codigo_kmt || null };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Cómo se muestra una máquina (igual en toda la app)
// ─────────────────────────────────────────────────────────────────────────────
// Nombre: el que le pusieron; si no tiene, su código KMT; si tampoco, el ID del equipo.
async function sqlNombre(a = 'm') {
  return `COALESCE(NULLIF(btrim(${a}.name), ''), ${(await hayKMT()) ? `${a}.codigo_kmt, ` : ''}${a}.machine_id)`;
}
// Código que ven las pantallas actuales ("code"): el KMT si ya lo tiene
async function sqlCodigo(a = 'm') {
  return `COALESCE(${(await hayKMT()) ? `${a}.codigo_kmt, ` : ''}NULLIF(btrim(${a}.code), ''), ${a}.machine_id)`;
}
// Campos del código KMT para un SELECT
async function sqlCamposKMT(a = 'm') {
  if (!(await hayKMT())) {
    return `NULL::text AS codigo_kmt, NULL::int AS region_id, NULL::int AS numero_kmt, NULL::text AS region_nombre`;
  }
  return `${a}.codigo_kmt, ${a}.region_id, ${a}.numero_kmt,
          (SELECT r.nombre FROM regiones r WHERE r.id = ${a}.region_id) AS region_nombre`;
}

// Agrega a una fila de máquina los campos calculados que usa la app
function decorar(fila) {
  if (!fila) return fila;
  const equipo = fila.machine_id || fila.equipo_id || fila.id;
  const nombre = fila.nombre !== undefined ? fila.nombre : (limpiar(fila.name) || null);
  return {
    ...fila,
    equipo_id: equipo,
    nombre: nombre || null,
    codigo_kmt: fila.codigo_kmt || null,
    codigo_pendiente: !fila.codigo_kmt,
    codigo_descripcion: fila.codigo_kmt
      ? describirKMT(fila.region_nombre || (fila.region_id ? `Región ${fila.region_id}` : null), fila.numero_kmt)
      : null,
    equipo_pendiente: esEquipoPendiente(equipo),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  2) ID DEL EQUIPO (machine_id)
// ─────────────────────────────────────────────────────────────────────────────
// Letras, números y - _ : . (sin espacios ni / # +, que rompen los tópicos MQTT). 2 a 40 caracteres.
const FORMATO_EQUIPO = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,39}$/;
const PROVISIONAL = /^(PEND-|TEMP_)/i;
const SQL_EQUIPO_PENDIENTE = (a = 'm') => `(${a}.machine_id ILIKE 'PEND-%' OR ${a}.machine_id ILIKE 'TEMP\\_%')`;
const esEquipoPendiente = (id) => PROVISIONAL.test(String(id || ''));

function validarEquipo(id) {
  if (!id) return 'Escribe el ID del equipo (el MACHINE_ID de la placa).';
  if (PROVISIONAL.test(id)) return 'Los IDs que empiezan con PEND- o TEMP_ son provisionales; usa el ID real de la placa.';
  if (!FORMATO_EQUIPO.test(id)) {
    return 'El ID del equipo solo puede tener letras, números, guion (-), guion bajo (_), dos puntos (:) o punto (.), ' +
      'sin espacios, de 2 a 40 caracteres. Ejemplo: TCN-0003';
  }
  return null;
}

async function nuevoEquipoPendiente(q = pool) {
  for (let i = 0; i < 8; i++) {
    const id = 'PEND-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
    const { rowCount } = await q.query('SELECT 1 FROM maquinas WHERE machine_id = $1 OR code = $1', [id]);
    if (!rowCount) return id;
  }
  return 'PEND-' + Date.now().toString(36).toUpperCase();
}

// ¿Ya hay OTRA máquina con ese ID? (sin distinguir mayúsculas: TCN-0003 = tcn-0003)
async function equipoOcupado(q, id, excepto = null) {
  const { rows } = await q.query(
    `SELECT machine_id FROM maquinas
     WHERE (lower(machine_id) = lower($1) OR lower(code) = lower($1)) AND machine_id IS DISTINCT FROM $2
     LIMIT 1`, [id, excepto]);
  return rows[0] ? rows[0].machine_id : null;
}

// Estructura de la base (columnas de maquinas, columnas únicas y tablas que guardan machine_id).
// Se vuelve a leer cada minuto: la migración puede agregar columnas después de arrancar.
let estructura = null;
async function leerEstructura(q) {
  if (estructura && estructura.vence > Date.now()) return estructura;
  const cols = await q.query(`
    SELECT a.attname AS col
    FROM pg_attribute a
    WHERE a.attrelid = 'maquinas'::regclass AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attgenerated = '' AND a.attidentity <> 'a'
    ORDER BY a.attnum`);
  const unicas = await q.query(`
    SELECT DISTINCT a.attname AS col
    FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
    WHERE i.indrelid = 'maquinas'::regclass AND i.indisunique`);
  // Llaves foráneas que apuntan a maquinas
  const fks = await q.query(`
    SELECT c.conrelid AS oid, quote_ident(n.nspname) || '.' || quote_ident(cl.relname) AS tabla,
           a.attname AS columna, ra.attname AS referencia, array_length(c.conkey, 1) AS n
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = c.confkey[1]
    WHERE c.contype = 'f' AND c.confrelid = 'maquinas'::regclass`);
  // Tablas del mismo esquema con columna machine_id (inventario, historial_ventas, abastecimientos,
  // gastos, auditoría…). Las del esquema kymez NO: ahí el ID es el de la placa, no el de Qhapay.
  const conColumna = await q.query(`
    SELECT cl.oid, quote_ident(n.nspname) || '.' || quote_ident(cl.relname) AS tabla, 'machine_id' AS columna
    FROM pg_class cl
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attname = 'machine_id' AND NOT a.attisdropped
    WHERE n.nspname = current_schema() AND cl.relkind IN ('r', 'p')
      AND cl.relname NOT IN ('maquinas', 'ventas_dia_maquina', 'ventas_mes_maquina')`);

  const noSoportadas = fks.rows.filter((f) => f.n !== 1 || f.referencia !== 'machine_id');
  const hijas = new Map();
  for (const f of [...fks.rows.filter((f) => f.n === 1 && f.referencia === 'machine_id'), ...conColumna.rows]) {
    hijas.set(`${f.oid}.${f.columna}`, { tabla: f.tabla, columna: f.columna });
  }
  estructura = {
    vence: Date.now() + 60 * 1000,
    columnas: cols.rows.map((r) => r.col),
    unicas: unicas.rows.map((r) => r.col).filter((c) => c !== 'machine_id' && c !== 'code'),
    hijas: [...hijas.values()],
    noSoportadas,
  };
  return estructura;
}

/**
 * Cambia el ID del equipo (machine_id) de una máquina y lleva con ella TODO lo que tiene:
 * todas sus columnas (nombre, código KMT, cliente, costo, depreciación, layout, candado…),
 * su inventario, sus ventas, sus abastecimientos, sus gastos y su historial de auditoría.
 * Debe correr dentro de una transacción.
 */
async function cambiarEquipo(client, actual, nuevo) {
  const fila = await client.query('SELECT machine_id FROM maquinas WHERE machine_id = $1 FOR UPDATE', [actual]);
  if (!fila.rowCount) throw error(404, 'La máquina no existe (quizá ya cambió de equipo). Recarga la página.');

  const ocupado = await equipoOcupado(client, nuevo, actual);
  if (ocupado) throw error(409, `El equipo ${nuevo} ya está vinculado a otra máquina (${ocupado}).`);

  if (nuevo === actual) {
    await client.query('UPDATE maquinas SET code = $1 WHERE machine_id = $1', [nuevo]);
    return;
  }

  // Una máquina con muchos años de ventas puede tardar más que el límite normal de 15 s por consulta
  await client.query("SET LOCAL statement_timeout = '180s'");

  const e = await leerEstructura(client);
  if (e.noSoportadas.length) {
    throw error(500, 'La tabla maquinas tiene llaves foráneas que este cambio no sabe mover: ' +
      e.noSoportadas.map((f) => `${f.tabla}.${f.columna}`).join(', ') + '. No se cambió nada.');
  }

  // 1) El código anterior se libera un momento (la columna code es única)
  await client.query('UPDATE maquinas SET code = $1 WHERE machine_id = $2', [`__cambiando__${actual}`, actual]);

  // 2) Copia de la fila con el ID nuevo (todas las columnas; las únicas se restauran al final)
  const copiar = e.columnas.filter((c) => c !== 'machine_id' && c !== 'code' && !e.unicas.includes(c));
  const lista = ['machine_id', 'code', ...copiar].map(qi).join(', ');
  await client.query(
    `INSERT INTO maquinas (${lista}) SELECT $1, $1${copiar.length ? ', ' + copiar.map(qi).join(', ') : ''}
     FROM maquinas WHERE machine_id = $2`, [nuevo, actual]);

  // 3) Inventario, ventas, abastecimientos, gastos… pasan al ID nuevo.
  //    El trigger de totales se pausa SOLO en esta transacción: los totales se mueven en el paso 5
  //    de una vez (fila por fila, una máquina con muchas ventas tardaría minutos).
  await client.query("SET LOCAL qhapay.sin_resumen = 'on'");
  for (const h of e.hijas) {
    await client.query(`UPDATE ${h.tabla} SET ${qi(h.columna)} = $1 WHERE ${qi(h.columna)} = $2`, [nuevo, actual]);
  }
  await client.query("SET LOCAL qhapay.sin_resumen = 'off'");

  // 4) Se borra la fila anterior (ya no queda nada apuntándole) y se restauran las columnas únicas
  let unicasAnteriores = null;
  if (e.unicas.length) {
    unicasAnteriores = (await client.query(
      `SELECT ${e.unicas.map(qi).join(', ')} FROM maquinas WHERE machine_id = $1`, [actual])).rows[0];
  }
  await client.query('DELETE FROM maquinas WHERE machine_id = $1', [actual]);
  if (unicasAnteriores) {
    const sets = e.unicas.map((c, i) => `${qi(c)} = $${i + 1}`).join(', ');
    await client.query(`UPDATE maquinas SET ${sets} WHERE machine_id = $${e.unicas.length + 1}`,
      [...e.unicas.map((c) => unicasAnteriores[c]), nuevo]);
  }

  // 5) Totales por día y por mes de la máquina pasan al ID nuevo (los de producto son por dueño
  //    y no cambian). Si el trigger no se pausó (versión anterior de la función), ya los movió él y
  //    aquí solo se suman ceros: el resultado es el mismo.
  await moverTotalesMaquina(client, actual, nuevo);
}

async function moverTotalesMaquina(client, desde, hacia) {
  const t = await client.query(
    "SELECT to_regclass('ventas_dia_maquina') IS NOT NULL AS d, to_regclass('ventas_mes_maquina') IS NOT NULL AS m");
  for (const [tabla, col, existe] of [['ventas_dia_maquina', 'dia', t.rows[0].d], ['ventas_mes_maquina', 'mes', t.rows[0].m]]) {
    if (!existe) continue;
    await client.query(`
      INSERT INTO ${tabla} AS t (machine_id, ${col}, unidades, monto)
      SELECT $1, ${col}, unidades, monto FROM ${tabla} WHERE machine_id = $2
      ON CONFLICT (machine_id, ${col}) DO UPDATE SET unidades = t.unidades + EXCLUDED.unidades, monto = t.monto + EXCLUDED.monto`,
      [hacia, desde]);
    await client.query(`DELETE FROM ${tabla} WHERE machine_id = $1`, [desde]);
  }
}

// ¿kymez-pagos (Yape) conoce este equipo? null si esa parte no está en esta base de datos.
async function estadoEnKymez(id) {
  try {
    const t = (await pool.query(
      "SELECT to_regclass('kymez.maquinas') IS NOT NULL AS m, to_regclass('kymez.maquinas_estado') IS NOT NULL AS e")).rows[0];
    if (!t.m && !t.e) return null;
    const r = await pool.query(`
      SELECT ${t.m ? 'EXISTS (SELECT 1 FROM kymez.maquinas WHERE machine_id = $1)' : 'false'} AS registrada,
             ${t.m ? '(SELECT cuenta_cobro_id FROM kymez.maquinas WHERE machine_id = $1)' : 'NULL::text'} AS cuenta_cobro_id,
             ${t.e ? `(SELECT online AND actualizado_en > now() - interval '3 minutes' FROM kymez.maquinas_estado WHERE machine_id = $1)` : 'NULL::boolean'} AS online,
             ${t.e ? '(SELECT actualizado_en FROM kymez.maquinas_estado WHERE machine_id = $1)' : 'NULL::timestamptz'} AS visto_en`,
      [id]);
    const k = r.rows[0];
    return { registrada: k.registrada, cuenta_cobro_id: k.cuenta_cobro_id || null, online: k.online === true, visto_en: k.visto_en };
  } catch (e) {
    console.warn('[equipo] no se pudo consultar kymez:', e.message);
    return null;
  }
}

// Equipos que kymez-pagos ya conoce (registrados o que se conectaron) y que todavía no están
// vinculados a ninguna máquina de Qhapay. Así el superadmin elige en vez de escribir.
async function equiposDisponibles() {
  try {
    const t = (await pool.query(
      "SELECT to_regclass('kymez.maquinas') IS NOT NULL AS m, to_regclass('kymez.maquinas_estado') IS NOT NULL AS e")).rows[0];
    if (!t.m && !t.e) return [];
    const fuentes = [];
    if (t.m) fuentes.push('SELECT machine_id FROM kymez.maquinas');
    if (t.e) fuentes.push('SELECT machine_id FROM kymez.maquinas_estado');
    const { rows } = await pool.query(`
      WITH k AS (${fuentes.join(' UNION ')})
      SELECT k.machine_id AS equipo_id,
             ${t.m ? 'EXISTS (SELECT 1 FROM kymez.maquinas km WHERE km.machine_id = k.machine_id)' : 'false'} AS registrada,
             ${t.m ? '(SELECT km.cuenta_cobro_id FROM kymez.maquinas km WHERE km.machine_id = k.machine_id)' : 'NULL::text'} AS cuenta_cobro_id,
             ${t.e ? `COALESCE(e.online AND e.actualizado_en > now() - interval '3 minutes', false)` : 'false'} AS online,
             ${t.e ? 'e.actualizado_en' : 'NULL::timestamptz'} AS visto_en
      FROM k
      ${t.e ? 'LEFT JOIN kymez.maquinas_estado e ON e.machine_id = k.machine_id' : ''}
      WHERE k.machine_id IS NOT NULL AND k.machine_id <> ''
        AND NOT EXISTS (SELECT 1 FROM maquinas m
                        WHERE lower(m.machine_id) = lower(k.machine_id) OR lower(m.code) = lower(k.machine_id))
      ORDER BY 4 DESC, 5 DESC NULLS LAST, 1
      LIMIT 200`);
    return rows;
  } catch (e) {
    console.warn('[equipo] no se pudo leer los equipos de kymez:', e.message);
    return [];
  }
}

module.exports = {
  error, limpiar,
  // código KMT
  PREFIJO, EMPRESA, NUMERO_MAX, formatearKMT, describirKMT, hayKMT, siguienteNumero, leerRegion,
  asignarKMT, quitarKMT,
  // cómo se muestra
  sqlNombre, sqlCodigo, sqlCamposKMT, decorar,
  // equipo
  FORMATO_EQUIPO, SQL_EQUIPO_PENDIENTE, esEquipoPendiente, validarEquipo, nuevoEquipoPendiente, equipoOcupado,
  cambiarEquipo, moverTotalesMaquina, estadoEnKymez, equiposDisponibles,
};
