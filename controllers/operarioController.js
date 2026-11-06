// controllers/operarioController.js
// v3.6 · Operarios: registro e ingreso con usuario y contraseña, vínculo con el dueño por código,
// y la administración que hace el dueño (código, lista, pausar, quitar, nueva contraseña).
const crypto = require('crypto');
const pool = require('../config/database');
const clave = require('../utils/clave');
const limite = require('../utils/limite');
const { firmarTokenOperario } = require('../utils/auth');
const ops = require('../utils/operarios');

const err500 = (res, e, donde) => {
  if (e && e.status === 503) return res.status(503).json({ success: false, message: e.message });
  console.error(`[operarios] ${donde}:`, e && e.message);
  res.status(500).json({ success: false, message: 'Error del servidor' });
};
const esOperario = (req) => !!(req.usuario && req.usuario.operario);
const esDueno = (req) => !!(req.usuario && !req.usuario.operario && req.usuario.id);

async function respuestaSesion(res, idOperario, message) {
  ops.olvidarOperario(idOperario);
  const op = await ops.buscarOperario(idOperario);
  res.json({ success: true, message, token: firmarTokenOperario(op), user: ops.usuarioSesion(op) });
}

// ===================================================================  PÚBLICAS
// POST /api/operarios/registro { usuario, password, nombre? }
const registro = async (req, res) => {
  try {
    await ops.asegurarTablas();
    const b = req.body || {};
    const usuario = ops.normalizarUsuario(b.usuario);
    if (!ops.USUARIO_OK.test(usuario)) {
      return res.status(400).json({ success: false,
        message: 'El usuario debe tener de 3 a 30 caracteres: letras, números, punto, guion o guion bajo (sin espacios).' });
    }
    const malo = clave.validarNueva(b.password);
    if (malo) return res.status(400).json({ success: false, message: malo });
    const nombre = String(b.nombre || '').trim().slice(0, 60) || null;
    const ins = await pool.query(
      `INSERT INTO operarios (usuario, nombre, password) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING id`, [usuario, nombre, await clave.hashear(String(b.password))]);
    if (!ins.rowCount) return res.status(409).json({ success: false, message: 'Ese usuario ya existe. Elige otro.' });
    await respuestaSesion(res, ins.rows[0].id, 'Cuenta de operario creada');
  } catch (e) { err500(res, e, 'registro'); }
};

// POST /api/operarios/login { usuario, password }
const login = async (req, res) => {
  try {
    await ops.asegurarTablas();
    const b = req.body || {};
    const usuario = ops.normalizarUsuario(b.usuario);
    const password = String(b.password ?? '');
    if (!usuario || !password) return res.status(400).json({ success: false, message: 'Usuario y contraseña son requeridos' });
    const espera = limite.bloqueado(req, `op:${usuario}`);
    if (espera) return res.status(429).json({ success: false, message: `Demasiados intentos. Espera ${espera} min y vuelve a intentar.` });

    const r = await pool.query('SELECT id, password, activo FROM operarios WHERE lower(usuario) = $1', [usuario]);
    const f = r.rows[0];
    const v = f ? await clave.verificar(password, f.password) : { ok: false };
    if (!v.ok) {
      limite.fallo(req, `op:${usuario}`);
      return res.status(401).json({ success: false, message: 'Usuario o contraseña incorrectos' });
    }
    limite.exito(req, `op:${usuario}`);
    if (!f.activo) return res.status(403).json({ success: false, message: 'El dueño pausó tu acceso. Pídele que lo vuelva a activar.' });
    await pool.query('UPDATE operarios SET ultimo_ingreso = now() WHERE id = $1', [f.id]);
    await respuestaSesion(res, f.id, 'Bienvenido');
  } catch (e) { err500(res, e, 'login'); }
};

// ===================================================================  DEL OPERARIO
const soloOperario = (req, res, next) => (esOperario(req) ? next()
  : res.status(403).json({ success: false, message: 'Esta opción es para cuentas de operario.' }));

// GET /api/operarios/yo
const yo = async (req, res) => {
  try {
    ops.olvidarOperario(req.usuario.operario.id);
    const op = await ops.buscarOperario(req.usuario.operario.id);
    res.json({ success: true, user: ops.usuarioSesion(op) });
  } catch (e) { err500(res, e, 'yo'); }
};

// POST /api/operarios/vincular { codigo }
const vincular = async (req, res) => {
  try {
    const idOp = req.usuario.operario.id;
    const llave = `vinc:${idOp}`;
    const espera = limite.bloqueado(req, llave);
    if (espera) return res.status(429).json({ success: false, message: `Demasiados intentos. Espera ${espera} min.` });
    const codigo = ops.normalizarCodigo(req.body && req.body.codigo);
    const r = codigo.length === 8
      ? await pool.query('SELECT id_dueno FROM operario_codigos WHERE codigo = $1', [codigo]) : { rows: [] };
    if (!r.rows.length) {
      limite.fallo(req, llave);
      return res.status(404).json({ success: false, message: 'Ese código no existe. Revísalo con el dueño de las máquinas.' });
    }
    limite.exito(req, llave);
    await pool.query('UPDATE operarios SET id_dueno = $1, vinculado_en = now(), activo = true WHERE id = $2',
      [r.rows[0].id_dueno, idOp]);
    await respuestaSesion(res, idOp, 'Listo: ya puedes rellenar las máquinas');
  } catch (e) { err500(res, e, 'vincular'); }
};

// POST /api/operarios/desvincular
const desvincular = async (req, res) => {
  try {
    const idOp = req.usuario.operario.id;
    await pool.query('UPDATE operarios SET id_dueno = NULL, vinculado_en = NULL WHERE id = $1', [idOp]);
    await respuestaSesion(res, idOp, 'Ya no trabajas para ese dueño');
  } catch (e) { err500(res, e, 'desvincular'); }
};

// POST /api/operarios/yo/contrasena { actual, nueva }
const cambiarMiContrasena = async (req, res) => {
  try {
    const b = req.body || {};
    const f = (await pool.query('SELECT password FROM operarios WHERE id = $1', [req.usuario.operario.id])).rows[0];
    const v = f ? await clave.verificar(String(b.actual ?? ''), f.password) : { ok: false };
    if (!v.ok) return res.status(401).json({ success: false, message: 'La contraseña actual no es correcta.' });
    const malo = clave.validarNueva(b.nueva);
    if (malo) return res.status(400).json({ success: false, message: malo });
    await pool.query('UPDATE operarios SET password = $1 WHERE id = $2', [await clave.hashear(String(b.nueva)), req.usuario.operario.id]);
    res.json({ success: true, message: 'Contraseña actualizada' });
  } catch (e) { err500(res, e, 'contraseña'); }
};

// POST /api/operarios/yo/eliminar { password, confirmacion: "ELIMINAR" }   (lo exige Google Play)
const eliminarMiCuenta = async (req, res) => {
  try {
    const b = req.body || {};
    if (String(b.confirmacion || '').trim().toUpperCase() !== 'ELIMINAR') {
      return res.status(400).json({ success: false, message: 'Escribe ELIMINAR para confirmar.' });
    }
    const idOp = req.usuario.operario.id;
    const f = (await pool.query('SELECT password FROM operarios WHERE id = $1', [idOp])).rows[0];
    const v = f ? await clave.verificar(String(b.password ?? ''), f.password) : { ok: false };
    if (!v.ok) return res.status(401).json({ success: false, message: 'La contraseña no es correcta.' });
    await pool.query('DELETE FROM operarios WHERE id = $1', [idOp]);
    ops.olvidarOperario(idOp);
    console.log(`[operarios] el operario ${idOp} eliminó su cuenta`);
    res.json({ success: true, message: 'Tu cuenta de operario fue eliminada.' });
  } catch (e) { err500(res, e, 'eliminar'); }
};

// ===================================================================  DEL DUEÑO
const soloDueno = (req, res, next) => (esDueno(req) ? next()
  : res.status(403).json({ success: false, message: 'Solo el dueño de las máquinas puede hacer esto.' }));

async function codigoDe(idDueno, renovar = false) {
  await ops.asegurarTablas();
  if (!renovar) {
    const r = await pool.query('SELECT codigo FROM operario_codigos WHERE id_dueno = $1', [idDueno]);
    if (r.rows.length) return r.rows[0].codigo;
  }
  for (let i = 0; i < 5; i++) {
    const c = ops.nuevoCodigo();
    try {
      await pool.query(`INSERT INTO operario_codigos (id_dueno, codigo) VALUES ($1, $2)
                        ON CONFLICT (id_dueno) DO UPDATE SET codigo = EXCLUDED.codigo, creado_en = now()`, [idDueno, c]);
      return c;
    } catch (e) {
      if (e.code !== '23505') throw e;   // el código ya lo tenía otro dueño: se intenta otro
    }
  }
  throw new Error('No se pudo crear el código');
}

// GET /api/operarios/codigo
const verCodigo = async (req, res) => {
  try { res.json({ success: true, codigo: ops.mostrarCodigo(await codigoDe(req.usuario.id)) }); }
  catch (e) { err500(res, e, 'código'); }
};

// POST /api/operarios/codigo/nuevo   (el código anterior deja de servir para nuevos operarios)
const renovarCodigo = async (req, res) => {
  try { res.json({ success: true, codigo: ops.mostrarCodigo(await codigoDe(req.usuario.id, true)) }); }
  catch (e) { err500(res, e, 'código nuevo'); }
};

// GET /api/operarios
const listar = async (req, res) => {
  try {
    await ops.asegurarTablas();
    const r = await pool.query(
      `SELECT id, usuario, nombre, activo, vinculado_en, ultimo_ingreso
         FROM operarios WHERE id_dueno = $1 ORDER BY lower(coalesce(nombre, usuario))`, [req.usuario.id]);
    res.json({ success: true, operarios: r.rows });
  } catch (e) { err500(res, e, 'listar'); }
};

async function operarioDelDueno(req, res) {
  const id = String(req.params.id || '');
  if (!/^\d+$/.test(id)) { res.status(404).json({ success: false, message: 'No encontrado' }); return null; }
  const r = await pool.query('SELECT id FROM operarios WHERE id = $1 AND id_dueno = $2', [id, req.usuario.id]);
  if (!r.rows.length) { res.status(404).json({ success: false, message: 'No encontrado' }); return null; }
  return id;
}

// PATCH /api/operarios/:id { activo }
const cambiarEstado = async (req, res) => {
  try {
    const id = await operarioDelDueno(req, res); if (!id) return;
    const activo = !!(req.body && req.body.activo);
    await pool.query('UPDATE operarios SET activo = $1 WHERE id = $2', [activo, id]);
    ops.olvidarOperario(id);
    res.json({ success: true, message: activo ? 'Operario activado' : 'Operario pausado' });
  } catch (e) { err500(res, e, 'estado'); }
};

// DELETE /api/operarios/:id   (lo desvincula; su cuenta sigue existiendo pero ya no ve tus máquinas)
const quitar = async (req, res) => {
  try {
    const id = await operarioDelDueno(req, res); if (!id) return;
    await pool.query('UPDATE operarios SET id_dueno = NULL, vinculado_en = NULL WHERE id = $1', [id]);
    ops.olvidarOperario(id);
    res.json({ success: true, message: 'Operario quitado' });
  } catch (e) { err500(res, e, 'quitar'); }
};

// POST /api/operarios/:id/clave   (contraseña temporal para el operario que la olvidó)
const nuevaClave = async (req, res) => {
  try {
    const id = await operarioDelDueno(req, res); if (!id) return;
    const temporal = crypto.randomBytes(6).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 6) +
      String(crypto.randomInt(10, 99));
    await pool.query('UPDATE operarios SET password = $1 WHERE id = $2', [await clave.hashear(temporal), id]);
    res.json({ success: true, contrasena_temporal: temporal,
      message: 'Dásela al operario. Puede cambiarla en su perfil.' });
  } catch (e) { err500(res, e, 'clave'); }
};

module.exports = {
  registro, login,
  soloOperario, yo, vincular, desvincular, cambiarMiContrasena, eliminarMiCuenta,
  soloDueno, verCodigo, renovarCodigo, listar, cambiarEstado, quitar, nuevaClave,
};
