// routes/inventoryRoutes.js
const express = require('express');
const router = express.Router();

// Importamos todas las funciones desde el controlador de inventario
const { 
    obtenerInventario, 
    actualizarInventario, 
    registrarVenta,
    deleteSpring,
    quitarStockYDevolverAlmacen // <-- 1. LO AGREGAMOS AQUÍ
} = require('../controllers/inventoryController');

// 1. OBTENER inventario por MAC
router.get('/:machine_id', obtenerInventario); 

// 2. GUARDAR / ACTUALIZAR RESORTE (Cubrimos POST y PUT en todas sus variantes)
router.post('/', actualizarInventario);          // Por si Lovable manda POST a /api/inventario
router.post('/actualizar', actualizarInventario); // Por si manda POST a /api/inventario/actualizar
router.put('/actualizar', actualizarInventario);  // El PUT original que ya tenías

// 3. REGISTRAR venta
router.post('/vender', registrarVenta);

// 4. QUITAR STOCK
router.post('/quitar-stock', quitarStockYDevolverAlmacen); // <-- 2. QUITAMOS "inventoryController." AQUÍ

// 5. ELIMINAR un resorte específico
router.delete('/:machine_id/:codigo_motor', deleteSpring);

module.exports = router;