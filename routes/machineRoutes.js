// routes/machineRoutes.js
const express = require('express');
const router = express.Router();
const machineController = require('../controllers/machineController');

// Ruta: GET /api/maquinas/:id_dueno
router.get('/:id_dueno', machineController.obtenerMaquinas);

module.exports = router;