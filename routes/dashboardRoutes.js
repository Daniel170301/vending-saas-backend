// routes/dashboardRoutes.js
const express = require('express');
const router = express.Router();
const { getDashboardMetrics } = require('../controllers/dashboardController');

// Esta ruta será accesible en: /api/dashboard
router.get('/', getDashboardMetrics);

module.exports = router;