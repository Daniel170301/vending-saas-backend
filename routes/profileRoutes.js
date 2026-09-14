const express = require('express');
const router = express.Router();
const profileController = require('../controllers/profileController');

// Ruta para obtener los datos del usuario (GET)
router.get('/:email', profileController.getProfile);

// Ruta para actualizar los datos del usuario (PUT)
router.put('/:email_actual', profileController.updateProfile);

module.exports = router;