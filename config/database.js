// config/database.js
const { Pool } = require('pg');
require('dotenv').config();

// Configuramos la conexión a la base de datos SaaS
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, //
  ssl: { rejectUnauthorized: false } //[cite: 4]
});

// Verificamos la conexión al arrancar
pool.connect()
  .then(() => console.log('✅ Conectado a la Base de Datos SaaS exitosamente')) //[cite: 4]
  .catch(err => console.error('❌ Error de conexión a la BD', err)); //[cite: 4]

module.exports = pool;