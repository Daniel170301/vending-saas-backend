// routes/cobrosRoutes.js  (v3.6.1) · siempre con sesión (ver app.js)
const express = require('express');
const router = express.Router();
const c = require('../controllers/cobrosAccesoController');

router.get('/acceso', c.estado);
router.post('/acceso', c.abrir);

module.exports = router;
