const express = require('express');
const router = express.Router();

// Importamos TODAS las funciones que creamos en el controlador, incluyendo las nuevas
const { 
    registerPurchase, 
    getExpenses, 
    getExpenseDetails, 
    deleteExpense, 
    updateExpense,
    eliminarDetalleGasto,
    agregarDetalleGasto,
    crearGasto // 🔥 1. AQUÍ AGREGAMOS LA NUEVA FUNCIÓN
} = require('../controllers/expenseController');

// Rutas originales
router.get('/', getExpenses);

// 🔥 2. AQUÍ AGREGAMOS LA RUTA QUE SOLUCIONA EL ERROR 404
// Esta ruta recibe los gastos operativos (Logística, Nómina, etc.)
router.post('/', crearGasto); 

// Esta ruta sigue intacta para la mercadería
router.post('/purchase', registerPurchase);

// NUEVAS RUTAS para el modal general (Detalle, Eliminar todo, Editar concepto/proveedor)
router.get('/:id/detalle', getExpenseDetails);
router.delete('/:id', deleteExpense);
router.put('/:id', updateExpense);

// RUTAS DINÁMICAS para el Modo Edición por fila (Eliminar/Agregar un solo producto)
router.delete('/:id_transaccion/detalles/:id_detalle', eliminarDetalleGasto);
router.post('/:id_transaccion/detalles', agregarDetalleGasto);

module.exports = router;