const express = require('express');
const router = express.Router();

// Importamos TODAS las funciones que creamos en el controlador, incluyendo las nuevas
const { 
    registerPurchase, 
    getExpenses, 
    getExpenseDetails, 
    deleteExpense, 
    updateExpense,
    eliminarDetalleGasto, // <-- Nueva
    agregarDetalleGasto   // <-- Nueva
} = require('../controllers/expenseController');

// Rutas originales
router.get('/', getExpenses);
router.post('/purchase', registerPurchase);

// NUEVAS RUTAS para el modal general (Detalle, Eliminar todo, Editar concepto/proveedor)
router.get('/:id/detalle', getExpenseDetails);
router.delete('/:id', deleteExpense);
router.put('/:id', updateExpense);

// RUTAS DINÁMICAS para el Modo Edición por fila (Eliminar/Agregar un solo producto)
router.delete('/:id_transaccion/detalles/:id_detalle', eliminarDetalleGasto);
router.post('/:id_transaccion/detalles', agregarDetalleGasto);

module.exports = router;