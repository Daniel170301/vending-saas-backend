// routes/warehouseRoutes.js
const express = require('express');
const router = express.Router();
const warehouseController = require('../controllers/warehouseController');

// Ruta GET para obtener los productos
router.get('/', warehouseController.obtenerAlmacen);

// Ruta POST para crear un producto
router.post('/', warehouseController.crearProductoAlmacen);

// Ruta PUT para actualizar/editar un producto existente
router.put('/:id', warehouseController.editarProductoAlmacen);

// ✅ CORRECCIÓN: Usamos warehouseController. adelante
router.delete('/:id', warehouseController.eliminarProductoAlmacen);

// Ruta PUT para actualizar (descontar) exclusivamente el stock
router.put('/:id/stock', warehouseController.actualizarStock);
// Ruta POST para sincronizar todos los precios del planograma con la máquina ESP32
router.post('/machines/:machine_id/sincronizar-precios', warehouseController.sincronizarPreciosMaquina);
module.exports = router;