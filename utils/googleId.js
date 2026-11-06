// utils/googleId.js
// v3.6 · "Continuar con Google" con el botón oficial de Google (Google Identity Services).
// La web recibe un ID token firmado por Google y lo manda aquí; se verifica la firma con las
// claves públicas de Google, que el token sea para TU app (GOOGLE_CLIENT_ID) y que el correo
// esté verificado. Así la pantalla de Google dice "QhaPay" y no el dominio de Supabase.
//
//   GOOGLE_CLIENT_ID   el "ID de cliente" web de Google Cloud (xxxx.apps.googleusercontent.com).
//                      Puedes poner varios separados por coma (web y Android).
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const CERTS_URL = process.env.GOOGLE_CERTS_URL || 'https://www.googleapis.com/oauth2/v3/certs';
const EMISORES = ['accounts.google.com', 'https://accounts.google.com'];
const clientes = () => String(process.env.GOOGLE_CLIENT_ID || '').split(',').map((s) => s.trim()).filter(Boolean);

let cache = { claves: null, vence: 0 };
async function clavesGoogle(forzar = false) {
  if (!forzar && cache.claves && Date.now() < cache.vence) return cache.claves;
  const r = await fetch(CERTS_URL, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Google respondió ${r.status} al pedir sus claves`);
  const j = await r.json();
  const edad = /max-age=(\d+)/.exec(r.headers.get('cache-control') || '');
  const claves = new Map();
  for (const k of j.keys || []) {
    try { claves.set(k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })); } catch { /* clave rara: se ignora */ }
  }
  cache = { claves, vence: Date.now() + (edad ? Number(edad[1]) * 1000 : 3600 * 1000) };
  return claves;
}

/** Devuelve { email, nombre } o { status, error }. */
async function verificarIdTokenGoogle(idToken) {
  const ids = clientes();
  if (!ids.length) return { status: 503, error: 'Falta GOOGLE_CLIENT_ID en el servidor.' };
  const dec = jwt.decode(String(idToken || ''), { complete: true });
  if (!dec || !dec.header || !dec.header.kid) return { status: 401, error: 'La respuesta de Google no es válida. Intenta de nuevo.' };
  let clave;
  try {
    clave = (await clavesGoogle()).get(dec.header.kid) || (await clavesGoogle(true)).get(dec.header.kid);
  } catch (e) {
    console.error('[google] claves:', e.message);
    return { status: 503, error: 'No se pudo verificar tu cuenta de Google. Intenta de nuevo en un momento.' };
  }
  if (!clave) return { status: 401, error: 'La respuesta de Google no es válida. Intenta de nuevo.' };
  let p;
  try {
    p = jwt.verify(idToken, clave, { algorithms: ['RS256'], audience: ids, issuer: EMISORES });
  } catch (e) {
    return { status: 401, error: e.name === 'TokenExpiredError' ? 'Tu inicio con Google venció. Vuelve a intentarlo.' : 'La respuesta de Google no es válida.' };
  }
  const email = String(p.email || '').trim().toLowerCase();
  if (!email || !(p.email_verified === true || p.email_verified === 'true')) {
    return { status: 401, error: 'Google no confirmó tu correo.' };
  }
  return { email, nombre: p.name || null };
}

module.exports = { verificarIdTokenGoogle };
