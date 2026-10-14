// routes/warehouseRoutes.js
const express = require('express');
const router = express.Router();
const warehouseController = require('../controllers/warehouseController');

// Lista de productos (sin las fotos dentro: cada foto llega por su propia URL)
router.get('/', warehouseController.obtenerAlmacen);

// Foto de un producto, con caché del navegador
router.get('/:id/imagen', warehouseController.obtenerImagen);

// Crear producto
router.post('/', warehouseController.crearProductoAlmacen);

// Editar producto (solo cambia los campos que llegan)
router.put('/:id', warehouseController.editarProductoAlmacen);

// Eliminar producto
router.delete('/:id', warehouseController.eliminarProductoAlmacen);

// Stock del almacén: { stock_warehouse } fija el valor, { delta } suma/resta de forma atómica
router.put('/:id/stock', warehouseController.actualizarStock);

// Sincronizar todos los precios del planograma con la máquina ESP32
router.post('/machines/:machine_id/sincronizar-precios', warehouseController.sincronizarPreciosMaquina);

module.exports = router;
