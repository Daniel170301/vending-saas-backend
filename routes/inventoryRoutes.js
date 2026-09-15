// routes/inventoryRoutes.js
const express = require('express');
const router = express.Router();

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

// 2. GUARDAR / ACTUALIZAR RESORTE
router.post('/', actualizarInventario);          
router.post('/actualizar', actualizarInventario); 
router.put('/actualizar', actualizarInventario);  

// 3. REGISTRAR venta
router.post('/vender', registrarVenta);

// 4. QUITAR STOCK
router.post('/quitar-stock', quitarStockYDevolverAlmacen); 

// === RUTAS FIJAS O CON PREFIJOS (DEBEN IR ANTES QUE LAS DINÁMICAS DOBLES) ===

// 6. HISTORIAL DE ABASTECIMIENTO
router.get('/:machine_id/abastecimiento', obtenerHistorialAbastecimiento);

// 7. ELIMINAR Y REVERTIR UN ABASTECIMIENTO (¡Ahora sí la leerá correctamente!)
router.delete('/abastecimiento/:id', eliminarHistorialAbastecimiento);

// === RUTAS ALTAMENTE DINÁMICAS (DEBEN IR AL FINAL) ===

// 5. ELIMINAR un resorte específico
router.delete('/:machine_id/:codigo_motor', deleteSpring);

module.exports = router;