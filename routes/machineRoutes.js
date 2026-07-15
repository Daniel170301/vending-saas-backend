// routes/machineRoutes.js
const express = require('express');
const router = express.Router();

// 1. Importamos la nueva función updateMachine junto con getMachines
const { getMachines, updateMachine } = require('../controllers/machineController');

// Esta ruta será accesible en: GET /api/machines (Para leer la lista)
router.get('/', getMachines);

// 2. Agregamos la ruta PUT (Para actualizar una máquina específica)
// Esta ruta será accesible en: PUT /api/machines/:id
router.put('/:id', updateMachine);

module.exports = router;