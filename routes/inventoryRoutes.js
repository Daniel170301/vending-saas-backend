// routes/inventoryRoutes.js
const express = require('express');
const router = express.Router();
const inventoryController = require('../controllers/inventoryController');
const { obtenerInventario, actualizarInventario, registrarVenta } = require('../controllers/inventoryController');

// Aquí defines que el GET (leer inventario) y el PUT (actualizar) pasen por ahí
router.get('/:machine_id', inventoryController.obtenerInventario); 
router.put('/actualizar', inventoryController.actualizarInventario);
router.post('/vender', registrarVenta);
module.exports = router;