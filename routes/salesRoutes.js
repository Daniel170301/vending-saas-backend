// routes/salesRoutes.js
const express = require('express');
const router = express.Router();
const salesController = require('../controllers/salesController');

// 1. PUERTA GLOBAL: Cuando Lovable pide todas las ventas (/api/ventas?email=...)
router.get('/', salesController.obtenerHistorialVentas);

// 2. PUERTA POR MÁQUINA: Cuando Lovable pide las ventas de una sola MAC (/api/ventas/B0-CB...)
router.get('/:machine_id', salesController.obtenerHistorialVentas);

// 3. Ruta para confirmar el despacho físico y registrar la venta (dejamos la tuya intacta)
router.post('/confirm-dispense/:machine_id', salesController.confirmarDespacho);

module.exports = router;