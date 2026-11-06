// routes/salesRoutes.js
const express = require('express');
const router = express.Router();

// v3.5: los IDs de la dirección deben ser del dueño de la sesión (si no, 404)
const propiedad = require('../utils/propiedad');
router.param('machine_id', propiedad.maquina);
const salesController = require('../controllers/salesController');

// 1. PUERTA GLOBAL: Cuando Lovable pide todas las ventas (/api/ventas?email=...)
router.get('/', salesController.obtenerHistorialVentas);

// 2. PUERTA POR MÁQUINA: Cuando Lovable pide las ventas de una sola MAC (/api/ventas/B0-CB...)
router.get('/:machine_id', salesController.obtenerHistorialVentas);

// 3. Ruta para confirmar el despacho físico y registrar la venta (dejamos la tuya intacta)
// Lo llaman equipos antiguos (sin sesión, como siempre); v3.6: solo máquinas antiguas registradas
const { soloEquipoLegado } = require('../utils/equipoLegado');
router.post('/confirm-dispense/:machine_id', soloEquipoLegado, salesController.confirmarDespacho);

module.exports = router;