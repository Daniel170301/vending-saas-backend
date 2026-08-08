// routes/inventoryRoutes.js
const express = require('express');
const router = express.Router();

// Importamos todas las funciones desde el controlador de inventario
const { 
    obtenerInventario, 
    actualizarInventario, 
    registrarVenta,
    deleteSpring // <-- Importamos la nueva función
} = require('../controllers/inventoryController');

// Rutas base (asumiendo que en app.js esto está montado en /api/inventario)
router.get('/:machine_id', obtenerInventario); 
router.put('/actualizar', actualizarInventario);
router.post('/vender', registrarVenta);

// NUEVA RUTA PARA ELIMINAR EL RESORTE (Ruta corregida)
router.delete('/:machine_id/:codigo_motor', deleteSpring);

module.exports = router;