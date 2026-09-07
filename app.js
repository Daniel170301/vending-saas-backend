// app.js
const express = require('express'); 
const cors = require('cors'); 
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
const app = express(); 

// Middlewares
app.use(cors()); 

// LA CORRECCIÓN ESTÁ AQUÍ: Aumentamos el límite de JSON y URL-encoded a 10mb
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

// Ruta base de prueba
app.get('/', (req, res) => {
  res.send('Servidor SaaS de Máquinas Expendedoras 100% Operativo (Arquitectura Modular)'); 
});

module.exports = app;