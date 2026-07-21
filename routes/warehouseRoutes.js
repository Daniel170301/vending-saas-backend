// routes/warehouseRoutes.js
const express = require('express');
const router = express.Router();
const warehouseController = require('../controllers/warehouseController');

// Ruta GET para obtener los productos
router.get('/', warehouseController.obtenerAlmacen);

// Ruta POST para crear un producto
router.post('/', warehouseController.crearProductoAlmacen);

module.exports = router;