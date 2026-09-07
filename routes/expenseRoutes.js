const express = require('express');
const router = express.Router();

// Importamos TODAS las funciones que creamos en el controlador
const { 
    registerPurchase, 
    getExpenses, 
    getExpenseDetails, 
    deleteExpense, 
    updateExpense 
} = require('../controllers/expenseController');

// Rutas originales
router.get('/', getExpenses);
router.post('/purchase', registerPurchase);

// NUEVAS RUTAS para el modal (Detalle, Eliminar, Editar)
router.get('/:id/detalle', getExpenseDetails);
router.delete('/:id', deleteExpense);
router.put('/:id', updateExpense);

module.exports = router;