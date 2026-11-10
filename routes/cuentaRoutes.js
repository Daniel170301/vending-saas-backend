// routes/cuentaRoutes.js  (v3.5)  · siempre exige la sesión (ver app.js)
const express = require('express');
const router = express.Router();
const { verEliminacion, eliminarCuenta, cambiarContrasena, estadoContrasena, cerrarOtrasSesiones } = require('../controllers/cuentaController');

router.get('/eliminar', verEliminacion);     // qué se borrará
router.post('/eliminar', eliminarCuenta);    // { confirmacion: "ELIMINAR", password? }
router.get('/contrasena', estadoContrasena);    // { tiene_contrasena }
router.post('/contrasena', cambiarContrasena); // { actual?, nueva } → v3.6.4 devuelve token nuevo
router.post('/cerrar-sesiones', cerrarOtrasSesiones); // v3.6.4

module.exports = router;
