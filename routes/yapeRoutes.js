const express = require('express');
const router = express.Router();
const { recibirPagoYape } = require('../controllers/paymentController');

// Aplicamos express.text() EXCLUSIVAMENTE a esta ruta para no afectar el express.json() global
router.post('/:machine_id', express.text({ type: '*/*' }), recibirPagoYape);

module.exports = router;