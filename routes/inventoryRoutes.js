// routes/inventoryRoutes.js
const express = require('express');
const router = express.Router();
const inventoryController = require('../controllers/inventoryController');

// La ruta final será /api/inventario/actualizar
router.put('/actualizar', inventoryController.actualizarInventario);

module.exports = router;