// routes/machineRoutes.js
const express = require('express');
const router = express.Router();

// 1. IMPORTACIÓN CORREGIDA: Traemos todas las funciones, incluyendo deleteMachine
const { getMachines, updateMachine, createMachine, deleteMachine } = require('../controllers/machineController');

// GET /api/machines (Para leer la lista)
router.get('/', getMachines);

// POST /api/machines (Para CREAR una nueva máquina)
router.post('/', createMachine);

// PUT /api/machines/:id (Para actualizar una máquina específica)
router.put('/:id', updateMachine);

// DELETE /api/machines/:id (Para ELIMINAR una máquina) <-- ¡Arreglado!
router.delete('/:id', deleteMachine);

module.exports = router;