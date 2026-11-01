/**
 * QhaPay · "Mi empresa" (datos del negocio del usuario)
 * ---------------------------------------------------------------------------
 *   GET  /api/company?email=usuario@correo.com   -> datos de la empresa de esa cuenta
 *   POST /api/company                             -> crea o actualiza (una por cuenta)
 *
 * Usa los MISMOS nombres de campos que ya envía la pantalla "Mi empresa":
 *   business_name, legal_name, doc_type, doc_number, address, phone, email,
 *   currency, business_type, logo_url, user_email
 *
 * Cómo conectarlo (en el archivo principal del servidor, donde están las otras rutas):
 *   app.use('/api/company', require('./company')(pool));
 *   (usa el mismo "pool" de PostgreSQL que usan tus otras rutas)
 *
 * La tabla public.mi_empresa se crea sola la primera vez si no existe.
 */
const express = require('express');

const CAMPOS = ['business_name', 'legal_name', 'doc_type', 'doc_number', 'address', 'phone',
                'email', 'currency', 'business_type', 'logo_url'];

const VACIA = Object.fromEntries(CAMPOS.map((c) => [c, null]));

// Texto limpio o null; recorta y limita el largo para no guardar basura
const texto = (v, max) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

const emailValido = (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 100;

module.exports = (pool) => {
  const router = express.Router();
  let tablaLista = false;

  async function asegurarTabla() {
    if (tablaLista) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.mi_empresa (
        id               SERIAL PRIMARY KEY,
        email_usuario    VARCHAR(100) UNIQUE NOT NULL,
        nombre_comercial VARCHAR(255) NOT NULL,
        razon_social     VARCHAR(255),
        tipo_documento   VARCHAR(20) DEFAULT 'RUC',
        numero_documento VARCHAR(50),
        direccion_fiscal TEXT,
        telefono         VARCHAR(50),
        email_contacto   VARCHAR(100),
        moneda           VARCHAR(10) DEFAULT 'PEN',
        tipo_negocio     VARCHAR(50),
        logo_url         TEXT,
        actualizado_en   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
    tablaLista = true;
  }

  // Fila de la base -> el formato que espera la pantalla
  const aRespuesta = (f) => ({
    business_name: f.nombre_comercial,
    legal_name:    f.razon_social,
    doc_type:      f.tipo_documento,
    doc_number:    f.numero_documento,
    address:       f.direccion_fiscal,
    phone:         f.telefono,
    email:         f.email_contacto,
    currency:      f.moneda,
    business_type: f.tipo_negocio,
    logo_url:      f.logo_url,
    updated_at:    f.actualizado_en,
  });

  // Si el servidor ya identifica al usuario con su sesión (req.user), se usa ESE correo y se
  // ignora el que viene en la dirección: así nadie puede leer ni cambiar la empresa de otro.
  const emailDe = (req) => {
    const sesion = req.user && (req.user.email || req.user.correo);
    return String(sesion || req.query.email || (req.body && req.body.user_email) || '').trim().toLowerCase();
  };

  router.get('/', async (req, res) => {
    const email = emailDe(req);
    if (!emailValido(email)) return res.status(400).json({ message: 'Falta el correo de la cuenta' });
    try {
      await asegurarTabla();
      const r = await pool.query('SELECT * FROM public.mi_empresa WHERE email_usuario = $1', [email]);
      // Sin empresa todavía: se responde vacío (no es un error)
      res.json(r.rowCount ? aRespuesta(r.rows[0]) : { ...VACIA });
    } catch (e) {
      console.error('[company] GET', e.message);
      res.status(500).json({ message: 'No se pudo leer la empresa' });
    }
  });

  router.post('/', async (req, res) => {
    const email = emailDe(req);
    if (!emailValido(email)) return res.status(400).json({ message: 'Falta el correo de la cuenta' });
    const b = req.body || {};
    const nombre = texto(b.business_name, 255);
    if (!nombre) return res.status(400).json({ message: 'El nombre comercial es obligatorio' });

    const logo = texto(b.logo_url, 2000);
    if (logo && !/^https:\/\//i.test(logo)) {
      return res.status(400).json({ message: 'El logo debe ser una dirección que empiece con https://' });
    }
    const correo = texto(b.email, 100);
    if (correo && !emailValido(correo)) return res.status(400).json({ message: 'El email no es válido' });

    try {
      await asegurarTabla();
      const r = await pool.query(
        `INSERT INTO public.mi_empresa
           (email_usuario, nombre_comercial, razon_social, tipo_documento, numero_documento,
            direccion_fiscal, telefono, email_contacto, moneda, tipo_negocio, logo_url, actualizado_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
         ON CONFLICT (email_usuario) DO UPDATE SET
           nombre_comercial = EXCLUDED.nombre_comercial,
           razon_social     = EXCLUDED.razon_social,
           tipo_documento   = EXCLUDED.tipo_documento,
           numero_documento = EXCLUDED.numero_documento,
           direccion_fiscal = EXCLUDED.direccion_fiscal,
           telefono         = EXCLUDED.telefono,
           email_contacto   = EXCLUDED.email_contacto,
           moneda           = EXCLUDED.moneda,
           tipo_negocio     = EXCLUDED.tipo_negocio,
           logo_url         = EXCLUDED.logo_url,
           actualizado_en   = now()
         RETURNING *`,
        [email, nombre, texto(b.legal_name, 255), texto(b.doc_type, 20) || 'RUC', texto(b.doc_number, 50),
         texto(b.address, 500), texto(b.phone, 50), correo, texto(b.currency, 10) || 'PEN',
         texto(b.business_type, 50), logo]);
      res.json({ message: 'Empresa guardada', ...aRespuesta(r.rows[0]) });
    } catch (e) {
      console.error('[company] POST', e.message);
      res.status(500).json({ message: 'No se pudo guardar la empresa' });
    }
  });

  // Por si la pantalla usa PUT en otra versión: mismo comportamiento que POST
  router.put('/', (req, res, next) => { req.method = 'POST'; router.handle(req, res, next); });

  return router;
};