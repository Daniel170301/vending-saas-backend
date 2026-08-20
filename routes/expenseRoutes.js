// routes/expenseRoutes.js
const express = require('express');
const router = express.Router();
const { registerPurchase } = require('../controllers/expenseController');

// Ruta para guardar una nueva compra de mercadería
router.post('/purchase', registerPurchase);

module.exports = router;