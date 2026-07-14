// routes/machineRoutes.js
const express = require('express');
const router = express.Router();
const { getMachines } = require('../controllers/machineController');

// Esta ruta será accesible en: /api/machines
router.get('/', getMachines);

module.exports = router;