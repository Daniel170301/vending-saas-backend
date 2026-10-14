// config/database.js
const { Pool } = require('pg');
require('dotenv').config();

const url = process.env.DATABASE_URL || '';
// Igual que antes: SSL siempre, salvo en una BD local (pruebas) o si DB_SSL=false.
const usarSSL = process.env.DB_SSL
  ? process.env.DB_SSL === 'true'
  : !/@(localhost|127\.0\.0\.1)[:/]/.test(url);

const pool = new Pool({
  connectionString: url,
  ssl: usarSSL ? { rejectUnauthorized: false } : false,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30000,          // libera conexiones que no se usan
  connectionTimeoutMillis: 5000,     // no quedarse colgado si la BD no responde
  keepAlive: true,
  statement_timeout: 15000,          // ninguna consulta bloquea al servidor más de 15 s
  application_name: 'vending-api',
});

// Sin este manejador, un corte de la BD en una conexión inactiva tumba el proceso entero.
pool.on('error', (err) => console.error('❌ Error en una conexión inactiva de la BD:', err.message));

// Verificamos la conexión al arrancar (antes se tomaba una conexión y nunca se devolvía).
pool.query('SELECT 1')
  .then(() => console.log('✅ Conectado a la Base de Datos SaaS exitosamente'))
  .catch((err) => console.error('❌ Error de conexión a la BD', err.message));

module.exports = pool;
