// utils/equipoLegado.js
// v3.6 · ¿Es una máquina con el equipo ANTIGUO (ESP32 v1: MacroDroid → este servidor → broker
// público jaimez/expendedora)? Ejemplo: Snakky Becall (B4-BF-E9-62-21-28).
// Regla (la misma que usa el superadmin para mostrar "ESP32 v1"): está registrada en QhaPay
// (public.maquinas) y NO es una placa KYMEZ (no está en kymez.maquinas).
const pool = require('../config/database');

const cache = new Map();   // machine_id -> { t, ok }
const TTL_MS = 60 * 1000;

async function esEquipoLegado(machineId) {
  const id = String(machineId || '').trim();
  if (!id || id.length > 64) return false;
  const c = cache.get(id);
  if (c && Date.now() - c.t < TTL_MS) return c.ok;
  let ok = false;
  const r = await pool.query('SELECT 1 FROM maquinas WHERE machine_id = $1', [id]);
  if (r.rowCount) {
    ok = true;
    const k = await pool.query(`SELECT to_regclass('kymez.maquinas') AS t`);
    if (k.rows[0].t) {
      const kz = await pool.query('SELECT 1 FROM kymez.maquinas WHERE machine_id = $1', [id]);
      ok = kz.rowCount === 0;
    }
  }
  cache.set(id, { t: Date.now(), ok });
  if (cache.size > 2000) cache.clear();
  return ok;
}

// Middleware: deja pasar solo a máquinas antiguas registradas (sin sesión, como siempre)
function soloEquipoLegado(req, res, next) {
  esEquipoLegado(req.params.machine_id)
    .then((ok) => (ok ? next() : res.status(404).send('Máquina no registrada como equipo antiguo')))
    .catch((e) => { console.error('[legado]', e.message); res.status(500).send('Error del servidor'); });
}

module.exports = { esEquipoLegado, soloEquipoLegado };
