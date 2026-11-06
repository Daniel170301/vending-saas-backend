// routes/cuentaRoutes.js  (v3.5)  · siempre exige la sesión (ver app.js)
const express = require('express');
const router = express.Router();
const { verEliminacion, eliminarCuenta, cambiarContrasena, estadoContrasena } = require('../controllers/cuentaController');

router.get('/eliminar', verEliminacion);     // qué se borrará
router.post('/eliminar', eliminarCuenta);    // { confirmacion: "ELIMINAR", password? }
router.get('/contrasena', estadoContrasena);    // { tiene_contrasena }
router.post('/contrasena', cambiarContrasena); // { actual?, nueva }

module.exports = router;
