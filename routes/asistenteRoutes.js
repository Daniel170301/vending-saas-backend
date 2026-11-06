// routes/asistenteRoutes.js  (v3.6) · siempre con sesión (ver app.js)
const express = require('express');
const router = express.Router();
const c = require('../controllers/asistenteController');

router.get('/estado', c.estado);
router.post('/mensaje', c.mensaje);
router.post('/confirmar', c.confirmar);

module.exports = router;
