// app.js
const express = require('express'); //[cite: 4]
const cors = require('cors'); //[cite: 4]
const authRoutes = require('./routes/authRoutes'); // Importamos la ruta
const inventoryRoutes = require('./routes/inventoryRoutes');
const salesRoutes = require('./routes/salesRoutes');
const reportRoutes = require('./routes/reportRoutes');
const machineRoutes = require('./routes/machineRoutes');
const yapeRoutes = require('./routes/yapeRoutes');
const app = express(); //[cite: 4]

// Middlewares
app.use(cors()); //[cite: 4]
app.use(express.json()); //[cite: 4]
app.use('/api/auth', authRoutes); // Ahora tu endpoint frontend será /api/auth/login
app.use('/api/inventario', inventoryRoutes);
app.use('/api/ventas', salesRoutes);
app.use('/api/reportes', reportRoutes);
app.use('/api/maquinas', machineRoutes);
app.use('/api/webhook/yape', yapeRoutes);
// Ruta base de prueba[cite: 4]
app.get('/', (req, res) => {
  res.send('Servidor SaaS de Máquinas Expendedoras 100% Operativo (Arquitectura Modular)'); //[cite: 4]
});

// ==========================================
// AQUÍ IMPORTAREMOS LAS RUTAS EN EL FUTURO
// ==========================================
// const authRoutes = require('./routes/authRoutes');
// const machineRoutes = require('./routes/machineRoutes');
// 
// app.use('/api/auth', authRoutes);
// app.use('/api/maquinas', machineRoutes);

module.exports = app;