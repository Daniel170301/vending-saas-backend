// routes/salesRoutes.js
const express = require('express');
const router = express.Router();
const salesController = require('../controllers/salesController');

// Ruta: POST /api/ventas/confirm-dispense/:machine_id
router.post('/confirm-dispense/:machine_id', salesController.confirmarDespacho);

module.exports = router;