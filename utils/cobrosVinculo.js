// utils/cobrosVinculo.js  (v3.6.5)
// Vincular un celular de cobro SIN que nadie escriba claves ni direcciones:
//   1. El superadmin pulsa "Vincular celular" en la cuenta (cel-N) → sale un código de un solo uso.
//   2. El cliente lo escribe en QhaPay → este módulo crea una clave nueva para esa cuenta,
//      guarda solo su huella en kymez.cuentas_cobro.token_sha256 (la misma que revisa kymez-pagos)
//      y le entrega la clave a la app UNA vez. La app la guarda en el celular y no la muestra.
//   3. Si el celular se pierde: "Desvincular" cambia la huella y ese celular deja de enviar pagos.
// Vincular otra vez (otro código) cambia la clave: el celular anterior queda fuera.
// Ojo: al vincular, MacroDroid en ese celular deja de funcionar (usaba la clave general). Es lo
// que se quiere: MacroDroid y QhaPay a la vez acreditarían dos veces el mismo pago.
const crypto = require('crypto');
const pool = require('../config/database');
const kymez = require('../services/kymez');
const acceso = require('./cobrosAcceso');

// Igual que kymez-pagos/firma.js
const sha256 = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

let listo = null;
// Columnas nuevas de kymez.cuentas_cobro (solo informativas; kymez-pagos no las usa)
function asegurarColumnas() {
  if (!listo) {
    listo = (async () => {
      if (!(await kymez.tiene('cuentas_cobro', 'token_sha256'))) return false;
      if (!(await kymez.tiene('cuentas_cobro', 'desvinculado_en'))) {
        await pool.query(`ALTER TABLE kymez.cuentas_cobro
          ADD COLUMN IF NOT EXISTS vinculado_en TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS vinculado_por TEXT,
          ADD COLUMN IF NOT EXISTS vinculado_equipo TEXT,
          ADD COLUMN IF NOT EXISTS desvinculado_en TIMESTAMPTZ`);
        kymez.olvidar();
      }
      return true;
    })().catch((e) => { listo = null; throw e; });
  }
  return listo;
}

// Estado del vínculo de una cuenta (fila con token propio sí/no y las columnas de arriba)
function estadoVinculo(c) {
  if (c.activa === false) return 'desactivado';
  if (c.vinculado_en) return 'vinculado';            // se configuró con código desde QhaPay
  if (c.desvinculado_en) return 'desvinculado';      // bloqueado: ningún celular puede enviar
  return c.tiene_token_propio ? 'clave_propia'       // clave puesta a mano (MacroDroid con token propio)
    : 'clave_general';                               // MacroDroid con YAPE_WEBHOOK_TOKEN
}

/**
 * Gasta el código y entrega la configuración del celular.
 * Devuelve null si el código no sirve; { error } si la cuenta ya no existe o está desactivada
 * (en ese caso el código NO se gasta).
 */
async function vincular({ codigo, email, equipo }) {
  if (!(await asegurarColumnas())) return { error: 'sin_kymez' };
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    const k = await acceso.canjear(codigo, email, { cli, vinculo: true });
    if (!k) { await cli.query('ROLLBACK'); return null; }
    const conDesc = await kymez.tiene('cuentas_cobro', 'descripcion');
    const c = await cli.query(
      `SELECT id, ${conDesc ? 'descripcion' : 'NULL::text AS descripcion'}, COALESCE(activa, true) AS activa
         FROM kymez.cuentas_cobro WHERE id = $1 FOR UPDATE`, [k.cuenta_id]);
    if (!c.rowCount || !c.rows[0].activa) { await cli.query('ROLLBACK'); return { error: 'cuenta', cuenta_id: k.cuenta_id }; }
    const token = crypto.randomBytes(32).toString('hex');
    await cli.query(
      `UPDATE kymez.cuentas_cobro
          SET token_sha256 = $2, vinculado_en = now(), vinculado_por = $3, vinculado_equipo = $4, desvinculado_en = NULL
        WHERE id = $1`,
      [k.cuenta_id, sha256(token), email || null, equipo ? String(equipo).slice(0, 80) : null]);
    await cli.query('COMMIT');
    return { codigo_id: k.id, telefono: c.rows[0].id, nombre: c.rows[0].descripcion || c.rows[0].id, token };
  } catch (e) {
    await cli.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { cli.release(); }
}

/**
 * modo 'bloquear' (por defecto): nadie puede enviar pagos con esa cuenta hasta vincular de nuevo.
 * modo 'clave_general': vuelve a aceptar la clave general (MacroDroid). Solo para volver atrás.
 */
async function desvincular(cuentaId, modo = 'bloquear') {
  if (!(await asegurarColumnas())) return null;
  const general = modo === 'clave_general';
  const r = await pool.query(
    `UPDATE kymez.cuentas_cobro
        SET token_sha256 = $2, vinculado_en = NULL, vinculado_por = NULL, vinculado_equipo = NULL,
            desvinculado_en = ${general ? 'NULL' : 'now()'}
      WHERE id = $1 RETURNING id`,
    [String(cuentaId), general ? null : sha256(crypto.randomBytes(32).toString('hex'))]);
  if (!r.rowCount) return null;
  const anulados = await acceso.anularDeCuenta(cuentaId);
  return { id: r.rows[0].id, modo: general ? 'clave_general' : 'bloquear', codigos_anulados: anulados };
}

module.exports = { asegurarColumnas, estadoVinculo, vincular, desvincular, sha256 };
