// routes/reportRoutes.js
const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');

// Ruta: GET /api/reportes/:machine_id
router.get('/:machine_id', reportController.obtenerHistorialVentas);

module.exports = router;