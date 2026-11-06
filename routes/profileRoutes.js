const express = require('express');
const router = express.Router();

// v3.5: los IDs de la dirección deben ser del dueño de la sesión (si no, 404)
const propiedad = require('../utils/propiedad');
router.param('email', propiedad.correoPropio);
router.param('email_actual', propiedad.correoPropio);
const profileController = require('../controllers/profileController');

// Ruta para obtener los datos del usuario (GET)
router.get('/:email', profileController.getProfile);

// Ruta para actualizar los datos del usuario (PUT)
router.put('/:email_actual', profileController.updateProfile);

module.exports = router;