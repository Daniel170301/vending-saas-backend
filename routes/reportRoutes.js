// routes/reportRoutes.js
const express = require('express');
const router = express.Router();

// v3.5: los IDs de la dirección deben ser del dueño de la sesión (si no, 404)
const propiedad = require('../utils/propiedad');
router.param('machine_id', propiedad.maquina);
const reportController = require('../controllers/reportController');

// Ruta: GET /api/reportes/:machine_id
router.get('/:machine_id', reportController.obtenerHistorialVentas);

module.exports = router;