// routes/inventoryRoutes.js
const express = require('express');
const router = express.Router();

const {
  obtenerInventario,
  actualizarInventario,
  abastecerLote,
  resumenInventario,
  registrarVenta,
  deleteSpring,
  quitarStockYDevolverAlmacen,
  obtenerHistorialAbastecimiento,
  eliminarHistorialAbastecimiento,
} = require('../controllers/inventoryController');

// === RUTAS FIJAS (deben ir ANTES de "/:machine_id") ===

// Resumen por máquina: unidades, faltantes, costo y venta futura
router.get('/resumen', resumenInventario);

// Relleno en grupo: varios resortes en una sola petición
router.post('/lote', abastecerLote);

// Guardar / actualizar un resorte
router.post('/', actualizarInventario);
router.post('/actualizar', actualizarInventario);
router.put('/actualizar', actualizarInventario);

// Registrar venta
router.post('/vender', registrarVenta);

// Quitar stock
router.post('/quitar-stock', quitarStockYDevolverAlmacen);

// Revertir un abastecimiento
router.delete('/abastecimiento/:id', eliminarHistorialAbastecimiento);

// === RUTAS DINÁMICAS ===

// Inventario por MAC
router.get('/:machine_id', obtenerInventario);

// Historial de abastecimiento
router.get('/:machine_id/abastecimiento', obtenerHistorialAbastecimiento);

// Eliminar un resorte
router.delete('/:machine_id/:codigo_motor', deleteSpring);

module.exports = router;
