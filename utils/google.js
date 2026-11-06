// utils/google.js
// Comprueba de verdad que la persona inició sesión con Google.
// QhaPay hace el login de Google con Supabase Auth y manda al servidor el access_token de esa
// sesión (Authorization: Bearer <token>). Aquí se le pregunta a Supabase de quién es ese token:
// el correo sale de Supabase, NO de lo que diga el cuerpo de la petición.
// (Antes /api/auth/google entregaba la sesión de cualquier correo que le escribieran, incluso
//  la del superadmin.)
//
// Variables de entorno (opcionales; por defecto, el proyecto de Supabase que usa qhapay.com):
//   SUPABASE_URL        https://xxxx.supabase.co
//   SUPABASE_ANON_KEY   clave pública (publishable/anon) de ese proyecto. Es pública: va en la web.
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://gycsvlpiaprdpyaloiln.supabase.co').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_nNKLgIkDVmJzKKZuk9LA6Q_ImIPSHA7';

/**
 * Devuelve { email, nombre, proveedor } si el token es válido, o { error, status }.
 */
async function verificarTokenGoogle(accessToken) {
  if (!accessToken) return { status: 401, error: 'Falta la sesión de Google. Vuelve a entrar con el botón de Google.' };
  let r;
  try {
    r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.error('[google] no se pudo consultar Supabase:', e.message);
    return { status: 503, error: 'No se pudo verificar tu cuenta de Google. Intenta de nuevo en un momento.' };
  }
  if (r.status === 401 || r.status === 403) return { status: 401, error: 'Tu sesión de Google venció. Vuelve a entrar con el botón de Google.' };
  if (!r.ok) {
    console.error('[google] Supabase respondió', r.status);
    return { status: 503, error: 'No se pudo verificar tu cuenta de Google. Intenta de nuevo en un momento.' };
  }
  const u = await r.json().catch(() => null);
  const email = String((u && u.email) || '').trim().toLowerCase();
  const confirmado = u && (u.email_confirmed_at || u.confirmed_at);
  if (!email || !confirmado) return { status: 401, error: 'Google no confirmó tu correo.' };
  const meta = (u && u.user_metadata) || {};
  return {
    email,
    nombre: meta.full_name || meta.name || null,
    proveedor: (u.app_metadata && u.app_metadata.provider) || null,
  };
}

module.exports = { verificarTokenGoogle };
