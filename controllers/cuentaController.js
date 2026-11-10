// controllers/cuentaController.js
// v3.5 · Eliminar la cuenta (lo exige Google Play para apps que permiten crear cuenta).
//
//   GET  /api/cuenta/eliminar        qué se borrará (para mostrarlo antes de confirmar)
//   POST /api/cuenta/eliminar        { confirmacion: "ELIMINAR", password? }
//        - Cuentas con contraseña: hay que escribirla.
//        - Cuentas de Google: basta la confirmación (la sesión ya prueba quién es).
//        - No se permite en modo soporte ni para el superadmin.
//
// Qué pasa:
//   SE BORRA      gastos y compras (con su detalle), proveedores, productos del almacén,
//                 clientes que creó, "Mi empresa" y los datos personales de la cuenta.
//   SE DESVINCULA cada máquina queda sin dueño en QhaPay (con su historial de ventas, que no
//                 tiene datos de la cuenta). La placa física la recoge o reasigna el superadmin.
//   SE CONSERVA   el historial de mensualidades pagadas a KYMEZ (obligación contable), ligado a
//                 un registro anónimo "Cuenta eliminada" sin correo, nombre, documento ni teléfono.
const pool = require('../config/database');
const clave = require('../utils/clave');
const { olvidar, cerrarSesiones } = require('../utils/usuarios');
const { firmarToken } = require('../utils/auth');
const auditoria = require('../utils/auditoria');

const existeTabla = async (c, t) => (await c.query('SELECT to_regclass($1) AS r', [`public.${t}`])).rows[0].r !== null;
const columnasDe = async (c, t) => new Set((await c.query(
  `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [t])).rows.map((r) => r.column_name));

// Ejecuta un paso dentro de un SAVEPOINT: si falla (tabla o columna que no existe en tu BD),
// se deshace solo ese paso y se sigue. Devuelve las filas afectadas o null.
async function paso(c, nombre, sql, params) {
  await c.query('SAVEPOINT paso');
  try {
    const r = await c.query(sql, params);
    await c.query('RELEASE SAVEPOINT paso');
    return r.rowCount;
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT paso');
    console.warn(`[cuenta] paso "${nombre}" omitido: ${e.message}`);
    return null;
  }
}

async function contar(c, sql, params) {
  try { return Number((await c.query(sql, params)).rows[0].n) || 0; } catch { return 0; }
}

// Lo que tiene la cuenta (para el resumen previo)
async function resumen(c, id, email) {
  const n = {};
  n.maquinas = await contar(c, 'SELECT count(*) AS n FROM maquinas WHERE id_dueno::text = $1', [id]);
  n.productos = (await existeTabla(c, 'productos_almacen'))
    ? await contar(c, 'SELECT count(*) AS n FROM productos_almacen WHERE id_dueno::text = $1', [id]) : 0;
  n.proveedores = (await existeTabla(c, 'proveedores'))
    ? await contar(c, 'SELECT count(*) AS n FROM proveedores WHERE id_usuario::text = $1', [id]) : 0;
  n.gastos = ((await existeTabla(c, 'gastos')) ? await contar(c, 'SELECT count(*) AS n FROM gastos WHERE id_dueno::text = $1', [id]) : 0)
    + ((await existeTabla(c, 'transacciones_gastos'))
      ? await contar(c, 'SELECT count(*) AS n FROM transacciones_gastos WHERE id_dueno::text = $1', [id]) : 0);
  n.clientes = (await existeTabla(c, 'empresas_clientes')) && (await columnasDe(c, 'empresas_clientes')).has('id_dueno')
    ? await contar(c, 'SELECT count(*) AS n FROM empresas_clientes WHERE id_dueno = $1', [id]) : 0;
  n.mi_empresa = (await existeTabla(c, 'mi_empresa'))
    ? await contar(c, 'SELECT count(*) AS n FROM mi_empresa WHERE lower(email_usuario) = $1', [email]) : 0;
  return n;
}

function puedeEliminar(req) {
  if (!req.usuario) return 'Inicia sesión para eliminar tu cuenta.';
  if (req.usuario.operario) return 'Los operarios eliminan su cuenta desde su perfil de operario.';
  if (req.usuario.soporte) return 'En modo soporte no se puede eliminar la cuenta del cliente.';
  if (req.usuario.superadmin) return 'La cuenta superadmin no se elimina desde aquí.';
  return null;
}

// GET /api/cuenta/eliminar
const verEliminacion = async (req, res) => {
  const no = puedeEliminar(req);
  if (no) return res.status(403).json({ success: false, message: no });
  const c = await pool.connect();
  try {
    const u = (await c.query('SELECT id, email, password FROM usuarios_duenos WHERE id::text = $1', [req.usuario.id])).rows[0];
    if (!u) return res.status(404).json({ success: false, message: 'La cuenta no existe' });
    res.json({
      success: true,
      email: u.email,
      pide_contrasena: u.password !== clave.MARCA_GOOGLE && !!u.password,
      se_borrara: await resumen(c, req.usuario.id, req.usuario.email),
    });
  } catch (e) {
    console.error('[cuenta] resumen:', e.message);
    res.status(500).json({ success: false, message: 'Error del servidor' });
  } finally { c.release(); }
};

// POST /api/cuenta/eliminar
const eliminarCuenta = async (req, res) => {
  const no = puedeEliminar(req);
  if (no) return res.status(403).json({ success: false, message: no });
  const b = req.body || {};
  if (String(b.confirmacion || '').trim().toUpperCase() !== 'ELIMINAR') {
    return res.status(400).json({ success: false, message: 'Escribe ELIMINAR para confirmar.' });
  }

  const id = req.usuario.id;
  const email = req.usuario.email;
  const c = await pool.connect();
  try {
    const u = (await c.query('SELECT * FROM usuarios_duenos WHERE id::text = $1', [id])).rows[0];
    if (!u) return res.status(404).json({ success: false, message: 'La cuenta no existe' });

    // Cuentas con contraseña: hay que escribirla (evita que alguien con el celular desbloqueado la borre)
    if (u.password && u.password !== clave.MARCA_GOOGLE) {
      const r = await clave.verificar(String(b.password ?? ''), u.password);
      if (!r.ok) return res.status(401).json({ success: false, message: 'La contraseña no es correcta.' });
    }

    const antes = await resumen(c, id, email);
    await c.query('BEGIN');

    // 1. Máquinas: quedan sin dueño (el historial de ventas es de la máquina, no de la persona)
    const colsM = await columnasDe(c, 'maquinas');
    const setM = ['id_dueno = NULL'];
    if (colsM.has('id_cliente_punto')) setM.push('id_cliente_punto = NULL');
    if (colsM.has('mensaje_bloqueo')) setM.push(`mensaje_bloqueo = 'Cuenta del dueño eliminada'`);
    if (colsM.has('suspendida_en')) setM.push('suspendida_en = COALESCE(suspendida_en, now())');
    if (colsM.has('pago_al_dia')) setM.push('pago_al_dia = false');
    const maquinasDesvinculadas = await paso(c, 'máquinas', `UPDATE maquinas SET ${setM.join(', ')} WHERE id_dueno::text = $1`, [id]);

    // 2. Gastos y compras (primero el detalle de cada compra)
    await paso(c, 'detalle de compras', `DELETE FROM compras_detalle WHERE id_transaccion IN
                 (SELECT id FROM transacciones_gastos WHERE id_dueno::text = $1)`, [id]);
    await paso(c, 'compras', 'DELETE FROM transacciones_gastos WHERE id_dueno::text = $1', [id]);
    await paso(c, 'gastos', 'DELETE FROM gastos WHERE id_dueno::text = $1', [id]);

    // 3. Proveedores
    await paso(c, 'proveedores', 'DELETE FROM proveedores WHERE id_usuario::text = $1', [id]);

    // 4. Productos del almacén (si algo los sigue usando, se desvinculan en vez de borrarse)
    if ((await paso(c, 'productos', 'DELETE FROM productos_almacen WHERE id_dueno::text = $1', [id])) === null) {
      await paso(c, 'productos (desvincular)', 'UPDATE productos_almacen SET id_dueno = NULL, image_url = NULL WHERE id_dueno::text = $1', [id]);
    }

    // 5. Clientes (puntos de venta) que creó
    await paso(c, 'clientes', 'DELETE FROM empresas_clientes WHERE id_dueno = $1', [id]);

    // 6. Mi empresa
    await paso(c, 'mi empresa', 'DELETE FROM mi_empresa WHERE lower(email_usuario) = $1', [email]);

    // 6b. Operarios (v3.6): pierden el acceso y el código deja de existir
    await paso(c, 'operarios', 'UPDATE operarios SET id_dueno = NULL, vinculado_en = NULL WHERE id_dueno = $1', [id]);
    await paso(c, 'código de operarios', 'DELETE FROM operario_codigos WHERE id_dueno = $1', [id]);
    await paso(c, 'uso del asistente', 'DELETE FROM asistente_uso WHERE clave = $1', [`d:${id}`]);

    // 7. La cuenta: se borra; si otra tabla la necesita (p. ej. mensualidades pagadas), se anonimiza
    let modo = 'borrada';
    if ((await paso(c, 'cuenta', 'DELETE FROM usuarios_duenos WHERE id::text = $1', [id])) === null) {
      const colsU = await columnasDe(c, 'usuarios_duenos');
      const anon = { email: `eliminada-${id}@cuenta-eliminada.invalid`, nombre: 'Cuenta eliminada', rol: 'eliminado' };
      const set = [], vals = [];
      for (const [k, v] of Object.entries(anon)) if (colsU.has(k)) { vals.push(v); set.push(`${k} = $${vals.length}`); }
      for (const k of ['password', 'apellido', 'tipo_documento', 'documento', 'celular', 'imagen_perfil', 'telefono', 'direccion']) {
        if (colsU.has(k)) set.push(`${k} = NULL`);
      }
      vals.push(id);
      await c.query(`UPDATE usuarios_duenos SET ${set.join(', ')} WHERE id::text = $${vals.length}`, vals);
      modo = 'anonimizada';
    }

    await c.query('COMMIT');
    olvidar(email);
    require('../utils/operarios').olvidarTodos();
    await auditoria.registrar({ usuario: `cuenta ${id}`, accion: 'cuenta_eliminada',
      detalle: { id_dueno: id, modo, maquinas_desvinculadas: maquinasDesvinculadas || 0 } });
    console.log(`[cuenta] cuenta ${id} eliminada (${modo})`);
    res.json({ success: true, message: 'Tu cuenta y tus datos fueron eliminados.', eliminado: antes });
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* ya no había transacción */ }
    console.error('[cuenta] eliminar:', e.message);
    res.status(500).json({ success: false, message: 'No se pudo eliminar la cuenta. Escríbenos a soporte.' });
  } finally { c.release(); }
};

// POST /api/cuenta/contrasena  { actual, nueva }   (v3.5)
// Las cuentas de clientes se crean con su número de documento como contraseña: con esto la cambian.
const cambiarContrasena = async (req, res) => {
  try {
    if (!req.usuario) return res.status(401).json({ success: false, message: 'Inicia sesión.' });
    if (req.usuario.operario) return res.status(403).json({ success: false, message: 'Los operarios cambian su contraseña en su perfil de operario.' });
    if (req.usuario.soporte) return res.status(403).json({ success: false, message: 'En modo soporte no se cambia la contraseña del cliente.' });
    const b = req.body || {};
    const u = (await pool.query('SELECT id, email, nombre, rol, password FROM usuarios_duenos WHERE id::text = $1', [req.usuario.id])).rows[0];
    if (!u) return res.status(404).json({ success: false, message: 'La cuenta no existe' });
    // v3.6: una cuenta creada con Google puede CREAR su contraseña (sin "actual"), para entrar
    // también con correo y contraseña (por ejemplo, en la app del celular)
    const esGoogle = u.password === clave.MARCA_GOOGLE || !u.password;
    if (!esGoogle) {
      const r = await clave.verificar(String(b.actual ?? ''), u.password);
      if (!r.ok) return res.status(401).json({ success: false, message: 'La contraseña actual no es correcta.' });
    }
    const malo = clave.validarNueva(b.nueva);
    if (malo) return res.status(400).json({ success: false, message: malo });
    await pool.query('UPDATE usuarios_duenos SET password = $1 WHERE id = $2', [await clave.hashear(String(b.nueva)), u.id]);
    // v3.6.4: al CAMBIAR la clave se cierran las sesiones de los otros dispositivos; este recibe un token nuevo.
    // Al CREARLA (cuenta de Google) no hace falta: nadie más podía conocerla.
    let token;
    if (!esGoogle) {
      await cerrarSesiones(u.id, u.email);
      token = firmarToken(u);
    }
    res.json({ success: true, token,
      message: esGoogle ? 'Contraseña creada: ya puedes entrar también con tu correo'
        : 'Contraseña actualizada. Se cerró la sesión en tus otros dispositivos.' });
  } catch (e) {
    console.error('[cuenta] contraseña:', e.message);
    res.status(500).json({ success: false, message: 'Error del servidor' });
  }
};

// GET /api/cuenta/contrasena → { tiene_contrasena }   (v3.6: para mostrar "Cambiar" o "Crear" contraseña)
const estadoContrasena = async (req, res) => {
  try {
    if (!req.usuario || req.usuario.operario) return res.status(403).json({ success: false, message: 'Solo para cuentas de dueño.' });
    const u = (await pool.query('SELECT password FROM usuarios_duenos WHERE id::text = $1', [req.usuario.id])).rows[0];
    if (!u) return res.status(404).json({ success: false, message: 'La cuenta no existe' });
    res.json({ success: true, tiene_contrasena: !!u.password && u.password !== clave.MARCA_GOOGLE, soporte: !!req.usuario.soporte });
  } catch (e) {
    console.error('[cuenta] estado contraseña:', e.message);
    res.status(500).json({ success: false, message: 'Error del servidor' });
  }
};

// POST /api/cuenta/cerrar-sesiones  (v3.6.4) → cierra la sesión en TODOS los dispositivos y
// devuelve un token nuevo para el que hizo el pedido (así este sigue dentro).
const cerrarOtrasSesiones = async (req, res) => {
  try {
    if (!req.usuario || req.usuario.operario) return res.status(403).json({ success: false, message: 'Solo para cuentas de dueño.' });
    if (req.usuario.soporte) return res.status(403).json({ success: false, message: 'En modo soporte no se cierran las sesiones del cliente.' });
    const u = (await pool.query('SELECT id, email, nombre, rol FROM usuarios_duenos WHERE id::text = $1', [req.usuario.id])).rows[0];
    if (!u) return res.status(404).json({ success: false, message: 'La cuenta no existe' });
    await cerrarSesiones(u.id, u.email);
    res.json({ success: true, token: firmarToken(u), message: 'Listo: se cerró la sesión en tus otros dispositivos.' });
  } catch (e) {
    console.error('[cuenta] cerrar sesiones:', e.message);
    res.status(500).json({ success: false, message: 'Error del servidor' });
  }
};

module.exports = { verEliminacion, eliminarCuenta, cambiarContrasena, estadoContrasena, cerrarOtrasSesiones };
