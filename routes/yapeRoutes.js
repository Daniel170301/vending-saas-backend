// routes/yapeRoutes.js
const express = require('express');
const router = express.Router();
const yapeController = require('../controllers/yapeController');

// Ruta: POST /api/webhook/yape
router.post('/', yapeController.recibirPagoYape);

module.exports = router;