// routes/dashboardRoutes.js
const express = require('express');
const router = express.Router();

// Importamos ambas funciones del controlador
const { 
    getDashboardMetrics, 
    obtenerTopProductos 
} = require('../controllers/dashboardController');

// 1. Ruta original para las métricas generales (Accesible en: /api/dashboard)
router.get('/', getDashboardMetrics);

// 2. NUEVA RUTA para las estadísticas del Top 20 (Accesible en: /api/dashboard/top-productos)
router.get('/top-productos', obtenerTopProductos);

module.exports = router;