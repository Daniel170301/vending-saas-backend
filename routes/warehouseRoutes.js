// routes/warehouseRoutes.js
const express = require('express');
const router = express.Router();
const warehouseController = require('../controllers/warehouseController');

// Ruta GET para obtener los productos
router.get('/', warehouseController.obtenerAlmacen);

// Ruta POST para crear un producto
router.post('/', warehouseController.crearProductoAlmacen);
// NUEVO: Ruta PUT para actualizar/editar un producto existente
router.put('/:id', warehouseController.editarProductoAlmacen);

// NUEVO: Ruta PUT para actualizar (descontar) exclusivamente el stock
router.put('/:id/stock', warehouseController.actualizarStock);
module.exports = router;