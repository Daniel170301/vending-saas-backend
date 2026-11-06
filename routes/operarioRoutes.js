// routes/operarioRoutes.js  (v3.6)  · ver controllers/operarioController.js
// /registro y /login no piden sesión (app.js); todo lo demás sí.
const express = require('express');
const router = express.Router();
const c = require('../controllers/operarioController');

// Públicas
router.post('/registro', c.registro);
router.post('/login', c.login);

// Del operario
router.get('/yo', c.soloOperario, c.yo);
router.post('/vincular', c.soloOperario, c.vincular);
router.post('/desvincular', c.soloOperario, c.desvincular);
router.post('/yo/contrasena', c.soloOperario, c.cambiarMiContrasena);
router.post('/yo/eliminar', c.soloOperario, c.eliminarMiCuenta);

// Del dueño
router.get('/codigo', c.soloDueno, c.verCodigo);
router.post('/codigo/nuevo', c.soloDueno, c.renovarCodigo);
router.get('/', c.soloDueno, c.listar);
router.patch('/:id', c.soloDueno, c.cambiarEstado);
router.delete('/:id', c.soloDueno, c.quitar);
router.post('/:id/clave', c.soloDueno, c.nuevaClave);

module.exports = router;
