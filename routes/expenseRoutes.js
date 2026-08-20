// routes/expenseRoutes.js
const express = require('express');
const router = express.Router();

// AQUÍ ESTÁ EL CAMBIO: Agregamos getExpenses dentro de las llaves
const { registerPurchase, getExpenses } = require('../controllers/expenseController');

// Ruta para obtener la lista
router.get('/', getExpenses);

// Ruta para guardar una nueva compra de mercadería
router.post('/purchase', registerPurchase);

module.exports = router;