// controllers/authController.js
// Inicio de sesión, registro y entrada con Google.
// v3.5: contraseñas con hash, Google verificado de verdad, freno a intentos repetidos y
// sin clave de respaldo para los tokens.
const pool = require('../config/database');
const { firmarToken } = require('../utils/auth');
const clave = require('../utils/clave');
const limite = require('../utils/limite');
const { verificarTokenGoogle } = require('../utils/google');
const { verificarIdTokenGoogle } = require('../utils/googleId');
const { olvidar } = require('../utils/usuarios');

const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const correoDe = (b) => String((b && (b.email || b.correo)) || '').trim().toLowerCase();
const claveDe = (b) => (b && (b.password ?? b.contrasena ?? b['contraseña'])) ?? '';
const tokenBearer = (req) => {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.get('authorization') || '').trim());
  return m ? m[1] : null;
};

function responderSesion(res, user, message) {
  const token = firmarToken(user);
  res.json({
    success: true,
    message,
    token,
    user: { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol },
  });
}

function errorServidor(res, error, donde) {
  if (error && error.status === 503) return res.status(503).json({ success: false, message: error.message });
  console.error(`Error en ${donde}:`, error);
  res.status(500).json({ success: false, message: 'Error interno del servidor' });
}

// ==========================================
// 1. INICIO DE SESIÓN  POST /api/auth/login { email, password }
// ==========================================
const login = async (req, res) => {
  try {
    const email = correoDe(req.body);
    const password = String(claveDe(req.body));
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Correo y contraseña son requeridos' });
    }
    const espera = limite.bloqueado(req, email);
    if (espera) {
      return res.status(429).json({ success: false, message: `Demasiados intentos. Espera ${espera} min y vuelve a intentar.` });
    }

    const { rows } = await pool.query('SELECT * FROM usuarios_duenos WHERE lower(email) = $1 ORDER BY id LIMIT 1', [email]);
    const user = rows[0];

    // Las cuentas creadas con Google no tienen contraseña: se entra con el botón de Google.
    if (user && user.password === clave.MARCA_GOOGLE) {
      return res.status(401).json({ success: false, message: 'Esta cuenta se creó con Google. Entra con el botón de Google.' });
    }

    const r = user ? await clave.verificar(password, user.password) : { ok: false };
    if (!r.ok) {
      limite.fallo(req, email);
      return res.status(401).json({ success: false, message: 'Correo o contraseña incorrectos' });
    }
    limite.exito(req, email);

    // Contraseña antigua en texto plano: se guarda con hash desde ahora (la persona no nota nada)
    if (r.migrar) {
      try {
        await pool.query('UPDATE usuarios_duenos SET password = $1 WHERE id = $2', [await clave.hashear(password), user.id]);
      } catch (e) {
        console.warn('[auth] no se pudo pasar la contraseña a hash:', e.message);
      }
    }
    responderSesion(res, user, 'Login exitoso');
  } catch (error) {
    errorServidor(res, error, 'el login');
  }
};

// ==========================================
// 2. REGISTRO  POST /api/auth/register { nombre, email, password }
// ==========================================
const register = async (req, res) => {
  try {
    const email = correoDe(req.body);
    const password = String(claveDe(req.body));
    const nombre = String((req.body && (req.body.nombre || req.body.full_name)) || '').trim().slice(0, 100) || 'Usuario';
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Correo y contraseña son requeridos' });
    }
    if (!EMAIL_OK.test(email) || email.length > 100) {
      return res.status(400).json({ success: false, message: 'El correo no es válido' });
    }
    const malo = clave.validarNueva(password);
    if (malo) return res.status(400).json({ success: false, message: malo });

    const check = await pool.query('SELECT 1 FROM usuarios_duenos WHERE lower(email) = $1', [email]);
    if (check.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'El usuario ya existe' });
    }
    const ins = await pool.query(
      'INSERT INTO usuarios_duenos (nombre, email, password, rol) VALUES ($1, $2, $3, $4) RETURNING id, nombre, email, rol',
      [nombre, email, await clave.hashear(password), 'dueno']);
    olvidar(email);
    responderSesion(res, ins.rows[0], 'Registro exitoso');
  } catch (error) {
    errorServidor(res, error, 'el registro');
  }
};

// ==========================================
// 3. ENTRAR CON GOOGLE  POST /api/auth/google
//    v3.6: { credential } = ID token del botón oficial de Google (la pantalla dice "QhaPay").
//    Sigue aceptando la forma anterior: Authorization: Bearer <access_token de Supabase>.
//    El correo lo confirma Google o Supabase; el del cuerpo se ignora.
// ==========================================
const google = async (req, res) => {
  try {
    const credential = req.body && (req.body.credential || req.body.id_token);
    const g = credential ? await verificarIdTokenGoogle(credential) : await verificarTokenGoogle(tokenBearer(req));
    if (g.error) return res.status(g.status).json({ success: false, message: g.error });

    const q = await pool.query('SELECT * FROM usuarios_duenos WHERE lower(email) = $1 ORDER BY id LIMIT 1', [g.email]);
    let user = q.rows[0];
    if (!user) {
      const nombre = String(g.nombre || (req.body && (req.body.nombre || req.body.full_name)) || g.email).slice(0, 100);
      const ins = await pool.query(
        'INSERT INTO usuarios_duenos (email, nombre, rol, password) VALUES ($1, $2, $3, $4) RETURNING *',
        [g.email, nombre, 'dueno', clave.MARCA_GOOGLE]);
      user = ins.rows[0];
      olvidar(g.email);
    }
    responderSesion(res, user, 'Login con Google exitoso');
  } catch (error) {
    errorServidor(res, error, 'el login con Google');
  }
};

// ==========================================
// 4. RESTABLECER CONTRASEÑA  POST /api/auth/restablecer { nueva }
//    v3.6: "¿Olvidaste tu contraseña?" antes cambiaba la clave en Supabase y no en este servidor,
//    así que nunca funcionaba. Ahora la web pide a Supabase un enlace al correo (solo prueba que
//    el correo es de esa persona) y manda aquí: Authorization: Bearer <access_token de esa sesión>.
// ==========================================
const restablecer = async (req, res) => {
  try {
    const g = await verificarTokenGoogle(tokenBearer(req));   // valida cualquier sesión de Supabase con correo confirmado
    if (g.error) return res.status(g.status === 401 ? 401 : g.status).json({ success: false,
      message: g.status === 401 ? 'El enlace venció. Pide uno nuevo desde "¿Olvidaste tu contraseña?".' : g.error });
    const malo = clave.validarNueva(req.body && req.body.nueva);
    if (malo) return res.status(400).json({ success: false, message: malo });
    const { rows } = await pool.query('SELECT * FROM usuarios_duenos WHERE lower(email) = $1 ORDER BY id LIMIT 1', [g.email]);
    const user = rows[0];
    if (!user || user.rol === 'eliminado') {
      return res.status(404).json({ success: false, message: 'No hay una cuenta de QhaPay con ese correo. Crea una cuenta.' });
    }
    await pool.query('UPDATE usuarios_duenos SET password = $1 WHERE id = $2', [await clave.hashear(String(req.body.nueva)), user.id]);
    limite.exito(req, g.email);
    olvidar(g.email);
    responderSesion(res, user, 'Contraseña actualizada');
  } catch (error) {
    errorServidor(res, error, 'restablecer contraseña');
  }
};

module.exports = { login, register, google, restablecer };
