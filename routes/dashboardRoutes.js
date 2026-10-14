// routes/dashboardRoutes.js
const express = require('express');
const router = express.Router();

const {
  getDashboardMetrics,
  obtenerTopProductos,
  obtenerResumen,
} = require('../controllers/dashboardController');

// Métricas generales (/api/dashboard)
router.get('/', getDashboardMetrics);

// Top 20 productos (/api/dashboard/top-productos)
router.get('/top-productos', obtenerTopProductos);

// NUEVO: todo el Inicio en una sola respuesta (/api/dashboard/resumen?email=...)
router.get('/resumen', obtenerResumen);

module.exports = router;
