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
const superadminRoutes = require('./routes/superadminRoutes');
const { version } = require('./package.json');
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

// v3.5 · Sesión obligatoria en todo lo que es información de un dueño (utils/sesion.js) y
// revisión de que las máquinas de la consulta o del cuerpo sean suyas (utils/propiedad.js)
const { sesion, MODO: MODO_SESION } = require('./utils/sesion');
const { maquinasPropias, productosPropios } = require('./utils/propiedad');
const conSesion = [sesion(), maquinasPropias];
// Las fotos de productos se cargan con <img src="..."> y el navegador no puede mandar el token
const fotosPublicas = sesion({ publicas: [['GET', /^\/\d+\/imagen\/?$/]] });

// Rutas
app.use('/api/auth', authRoutes);                              // login, registro y Google (sin sesión)
app.use('/api/inventario', conSesion, inventoryRoutes);
// confirm-dispense lo llaman equipos antiguos sin sesión (solo máquinas antiguas registradas)
app.use('/api/ventas', sesion({ publicas: [['POST', /^\/confirm-dispense\/[^/]+\/?$/]] }), maquinasPropias, salesRoutes);
app.use('/api/reportes', conSesion, reportRoutes);
app.use('/api/machines', conSesion, machineRoutes);
app.use('/api/webhook/yape', yapeRoutes);                      // equipos antiguos (Becall): igual que antes; ver CAMBIOS-v3.6
app.use('/api/dashboard', conSesion, dashboardRoutes);
app.use('/api/productos-almacen', fotosPublicas, maquinasPropias, warehouseRoutes);
app.use('/api/clients', conSesion, clientRoutes);
app.use('/api/gastos', conSesion, productosPropios, expenseRoutes);
app.use('/api/proveedores', conSesion, proveedorRoutes);
app.use('/api/perfil', conSesion, profileRoutes);
app.use('/api/cuenta', sesion({ siempre: true }), require('./routes/cuentaRoutes'));   // eliminar cuenta (v3.5)
app.use('/api/superadmin', superadminRoutes);   // entorno superadmin (exige su sesión)
app.use('/api/company', conSesion, require('./routes/companyRoutes')(pool));   // Mi empresa
app.use('/api/convenio', require('./routes/convenioRoutes'));   // convenios y ventas de prueba (ya exige sesión)
// v3.6 · Operarios (registro e ingreso sin sesión; lo demás con sesión) y asistente con IA
app.use('/api/operarios', sesion({ siempre: true, publicas: [['POST', /^\/(registro|login)\/?$/]] }), require('./routes/operarioRoutes'));
app.use('/api/asistente', sesion({ siempre: true }), maquinasPropias, require('./routes/asistenteRoutes'));
app.use('/api/cobros', sesion({ siempre: true }), require('./routes/cobrosRoutes'));   // v3.6.1: acceso a Celular de cobro

// Ruta base de prueba
app.get('/', (req, res) => {
  res.send('Servidor SaaS de Máquinas Expendedoras 100% Operativo (Arquitectura Modular)');
});

// Health check para Render (Settings -> Health Check Path: /salud)
app.get('/salud', async (req, res) => {
  const t0 = Date.now();
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, version, db_ms: Date.now() - t0, uptime_s: Math.round(process.uptime()),
      sesion: process.env.JWT_SECRET ? MODO_SESION : 'falta JWT_SECRET',
      equipos_antiguos: String(process.env.MQTT_LEGADO || '').trim().toLowerCase() === 'no' ? 'apagado' : 'encendido',
      asistente: process.env.ANTHROPIC_API_KEY ? 'activo' : 'sin clave' });
  } catch (e) {
    res.status(503).json({ ok: false, error: 'sin conexión a la base de datos' });
  }
});

module.exports = app;
