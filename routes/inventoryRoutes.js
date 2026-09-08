// routes/inventoryRoutes.js
const express = require('express');
const router = express.Router();

// Importamos todas las funciones desde el controlador de inventario
const { 
    obtenerInventario, 
    actualizarInventario, 
    registrarVenta,
    deleteSpring,
    quitarStockYDevolverAlmacen,
    obtenerHistorialAbastecimiento,
    eliminarHistorialAbastecimiento
} = require('../controllers/inventoryController');

// 1. OBTENER inventario por MAC
router.get('/:machine_id', obtenerInventario); 

// 2. GUARDAR / ACTUALIZAR RESORTE (Cubrimos POST y PUT en todas sus variantes)
router.post('/', actualizarInventario);          
router.post('/actualizar', actualizarInventario); 
router.put('/actualizar', actualizarInventario);  

// 3. REGISTRAR venta
router.post('/vender', registrarVenta);

// 4. QUITAR STOCK
router.post('/quitar-stock', quitarStockYDevolverAlmacen); 

// 5. ELIMINAR un resorte específico
router.delete('/:machine_id/:codigo_motor', deleteSpring);

// 6. HISTORIAL DE ABASTECIMIENTO
router.get('/:machine_id/abastecimiento', obtenerHistorialAbastecimiento);

// 7. ELIMINAR Y REVERTIR UN ABASTECIMIENTO
router.delete('/abastecimiento/:id', eliminarHistorialAbastecimiento);

module.exports = router;