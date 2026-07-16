// routes/salesRoutes.js
const express = require('express');
const router = express.Router();
const salesController = require('../controllers/salesController');

// Ruta 1: Confirmar el despacho físico y registrar la venta
router.post('/confirm-dispense/:machine_id', salesController.confirmarDespacho);

// Ruta 2: NUEVA - Obtener el historial de ventas para el Frontend
router.get('/historial', salesController.obtenerHistorialVentas);

module.exports = router;