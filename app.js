// app.js
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const authRoutes = require('./routes/authRoutes');
const inventoryRoutes = require('./routes/inventoryRoutes');
const salesRoutes = require('./routes/salesRoutes');
const reportRoutes = require('./routes/reportRoutes');
const machineRoutes = require('./routes/machineRoutes');
const yapeRoutes = require('./routes/yapeRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const warehouseRoutes = require('./routes/warehouseRoutes');
const clientRoutes = require('./routes/clientRoutes');
const expenseRoutes = require('./routes/expenseRoutes');
const proveedorRoutes = require('./routes/proveedorRoutes');
const profileRoutes = require('./routes/profileRoutes');
const pool = require('./config/database');

// === SERVICIOS EN SEGUNDO PLANO (CRON JOBS) ===
require('./services/cronJobs');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);   // Render va detrás de un proxy: protocolo e IP reales

// Middlewares
app.use(cors());
// Comprime las respuestas JSON (las listas pesan entre 5 y 10 veces menos por la red)
app.use(compression({ threshold: 1024 }));

// Límite de JSON y URL-encoded a 10mb
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Rutas
app.use('/api/auth', authRoutes);
app.use('/api/inventario', inventoryRoutes);
app.use('/api/ventas', salesRoutes);
app.use('/api/reportes', reportRoutes);
app.use('/api/machines', machineRoutes);
app.use('/api/webhook/yape', yapeRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/productos-almacen', warehouseRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/gastos', expenseRoutes);
app.use('/api/proveedores', proveedorRoutes);
app.use('/api/perfil', profileRoutes);

// Ruta base de prueba
app.get('/', (req, res) => {
  res.send('Servidor SaaS de Máquinas Expendedoras 100% Operativo (Arquitectura Modular)');
});

// Health check para Render (Settings -> Health Check Path: /salud)
app.get('/salud', async (req, res) => {
  const t0 = Date.now();
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db_ms: Date.now() - t0, uptime_s: Math.round(process.uptime()) });
  } catch (e) {
    res.status(503).json({ ok: false, error: 'sin conexión a la base de datos' });
  }
});

module.exports = app;
