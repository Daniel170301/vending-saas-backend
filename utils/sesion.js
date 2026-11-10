// utils/sesion.js
// v3.5 · Toda la información de QhaPay exige la sesión (Authorization: Bearer <token>).
//
// Antes las rutas confiaban en el correo que venía en la dirección (?user=, ?email=, ?user_id=)
// o en el cuerpo (user_email, id_usuario): cambiando ese correo se podían ver o modificar los datos
// de otro dueño. Ahora:
//   1. Se exige un token válido (firmado con JWT_SECRET) y la cuenta debe seguir existiendo.
//   2. El correo y el id de la petición se REEMPLAZAN por los de la sesión (salvo el superadmin).
//   3. Las máquinas y registros con ID se revisan contra el dueño de la sesión (utils/propiedad.js).
//
// v3.6 · Sesiones de OPERARIO (utils/operarios.js): trabajan con los datos de su dueño, pero solo
// pueden usar el Planograma, el relleno y la lista del almacén (lista OPERARIO_PERMITIDO).
//
// AUTH_MODO (variable de entorno):
//   exigir  (por defecto) sin sesión válida -> 401
//   avisar  deja pasar las peticiones sin sesión como antes, pero las anota en el log
//           ("[sesion] SIN SESIÓN ..."). Solo para la transición: úsalo 1 o 2 días mientras
//           actualizas QhaPay en Lovable y luego bórralo.
const { leerToken, revocado, MENSAJES, ROLES_SUPERADMIN } = require('./auth');
const { usuarioPorEmail } = require('./usuarios');
const { buscarOperario } = require('./operarios');

const MODO = String(process.env.AUTH_MODO || 'exigir').trim().toLowerCase() === 'avisar' ? 'avisar' : 'exigir';
if (MODO === 'avisar') {
  console.warn('[sesion] AUTH_MODO=avisar: las peticiones SIN sesión todavía pasan (solo se anotan). ' +
    'Bórralo en Render cuando QhaPay ya mande el token en todo.');
}

// Campos que identifican al dueño en la dirección y en el cuerpo
const CONSULTA_CORREO = ['email', 'user', 'user_id'];
const CUERPO_CORREO = ['user_email', 'owner_email', 'email_usuario', 'email_dueno'];
const CUERPO_ID = ['id_usuario', 'id_dueno'];

// Reemplaza la identidad que trae la petición por la de la sesión
function atarIdentidad(req) {
  const u = req.usuario;
  const q = { ...req.query };
  for (const k of CONSULTA_CORREO) q[k] = u.email;
  // En Express 5 req.query se vuelve a leer de la URL cada vez: se fija una copia ya corregida
  Object.defineProperty(req, 'query', { value: q, writable: true, configurable: true, enumerable: true });

  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    for (const k of CUERPO_CORREO) if (k in req.body) req.body[k] = u.email;
    for (const k of CUERPO_ID) if (k in req.body) req.body[k] = u.id;
  }
}

const sinDatos = (url) => String(url || '').split('?')[0];

// ---- Operarios: qué pueden usar ------------------------------------------------------------
// [método, ruta completa]. "*" = cualquier método. Todo lo demás responde 403.
const OPERARIO_PERMITIDO = [
  ['GET', /^\/api\/machines\/?$/],
  ['GET', /^\/api\/machines\/[^/]+\/?$/],
  ['PUT', /^\/api\/machines\/[^/]+\/?$/],                       // solo el layout (se recorta abajo)
  ['GET', /^\/api\/inventario(\/.*)?$/],
  ['POST', /^\/api\/inventario\/(?!vender\/?$).*$/],            // lote, actualizar, quitar-stock… (no vender)
  ['POST', /^\/api\/inventario\/?$/],
  ['PUT', /^\/api\/inventario\/(?!vender\/?$).*$/],
  ['GET', /^\/api\/productos-almacen\/?$/],
  ['GET', /^\/api\/productos-almacen\/\d+\/imagen\/?$/],
  ['PUT', /^\/api\/productos-almacen\/\d+(\/stock)?\/?$/],      // solo el stock (se recorta abajo)
  ['*', /^\/api\/asistente(\/.*)?$/],
  ['*', /^\/api\/operarios(\/.*)?$/],
];
// Sin dueño todavía (no escribió el código): solo su propia cuenta
const OPERARIO_SIN_DUENO = [['*', /^\/api\/operarios(\/.*)?$/]];

function rutaPermitida(lista, req) {
  const ruta = sinDatos(req.originalUrl);
  return lista.some(([m, re]) => (m === '*' || m === req.method) && re.test(ruta));
}

// Un operario no cambia nombres, precios de compra ni datos de la máquina: solo stock y layout
function recortarCuerpoOperario(req) {
  const ruta = sinDatos(req.originalUrl);
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  if (req.method === 'PUT' && /^\/api\/machines\/[^/]+\/?$/.test(ruta)) {
    req.body = b.layout !== undefined ? { layout: b.layout } : {};
  } else if (req.method === 'PUT' && /^\/api\/productos-almacen\/\d+\/?$/.test(ruta)) {
    req.body = b.stock_warehouse !== undefined ? { stock_warehouse: b.stock_warehouse } : {};
  }
  if (b && typeof req.body === 'object' && 'nombre_operario' in req.body) {
    req.body.nombre_operario = req.usuario.operario.nombre || req.usuario.operario.usuario;
  }
}

async function sesionOperario(req, res, next, datos) {
  const op = await buscarOperario(datos.op);
  if (!op) return res.status(401).json({ success: false, codigo: 'invalido', message: MENSAJES.invalido });
  if (!op.activo) {
    return res.status(401).json({ success: false, codigo: 'operario_pausado',
      message: 'El dueño pausó tu acceso de operario. Pídele que lo vuelva a activar.' });
  }
  req.usuario = {
    id: op.dueno ? op.dueno.id : null,
    email: op.dueno ? op.dueno.email : null,
    rol: 'operario',
    superadmin: false,
    soporte: false,
    operario: { id: op.id, usuario: op.usuario, nombre: op.nombre, dueno: op.dueno },
  };
  req.user = { id: req.usuario.id, email: req.usuario.email, rol: 'operario' };
  if (!rutaPermitida(op.dueno ? OPERARIO_PERMITIDO : OPERARIO_SIN_DUENO, req)) {
    return res.status(403).json({ success: false, codigo: op.dueno ? 'operario_sin_acceso' : 'operario_sin_dueno',
      message: op.dueno ? 'Tu cuenta de operario no tiene acceso a esta sección.'
        : 'Primero escribe el código que te dio el dueño de las máquinas.' });
  }
  if (op.dueno) {
    atarIdentidad(req);
    recortarCuerpoOperario(req);
  }
  return next();
}

/**
 * Middleware. opciones.publicas: lista de [método, /regex sobre req.path/] que no piden sesión
 * (por ejemplo las fotos de productos, que se cargan con <img src> y no pueden mandar el token).
 * opciones.siempre: true = exige sesión aunque AUTH_MODO sea "avisar" (borrar cuenta, etc.).
 */
function sesion(opciones = {}) {
  const publicas = opciones.publicas || [];
  return async function exigirSesion(req, res, next) {
    try {
      if (publicas.some(([m, re]) => (m === '*' || m === req.method) && re.test(req.path))) return next();

      const t = leerToken(req);
      if (t.datos && t.datos.rol === 'operario' && t.datos.op != null) {
        return await sesionOperario(req, res, next, t.datos);
      }
      if (t.datos && t.datos.email) {
        const email = String(t.datos.email).trim().toLowerCase();
        const u = await usuarioPorEmail(email);
        if (!u || u.rol === 'eliminado') {
          return res.status(401).json({ success: false, codigo: 'invalido', message: MENSAJES.invalido });
        }
        if (revocado(u, t.datos)) {   // v3.6.4: "cerrar sesión en todos los dispositivos" o contraseña cambiada
          return res.status(401).json({ success: false, codigo: 'cerrada', message: MENSAJES.cerrada });
        }
        req.usuario = {
          id: String(u.id),
          email,
          rol: u.rol,
          superadmin: ROLES_SUPERADMIN.has(u.rol),
          soporte: !!t.datos.soporte,
        };
        req.user = { id: u.id, email, rol: u.rol };   // lo usa routes/companyRoutes.js
        if (!req.usuario.superadmin) atarIdentidad(req);
        return next();
      }

      if (MODO === 'avisar' && !opciones.siempre) {
        console.warn(`[sesion] SIN SESIÓN (${t.motivo}) ${req.method} ${sinDatos(req.originalUrl)}`);
        req.usuario = null;
        return next();
      }
      const status = t.motivo === 'sin_configurar' ? 503 : 401;
      return res.status(status).json({ success: false, codigo: t.motivo, message: MENSAJES[t.motivo] });
    } catch (e) {
      console.error('[sesion] error:', e.message);
      res.status(500).json({ success: false, message: 'Error del servidor' });
    }
  };
}

module.exports = { sesion, MODO };
