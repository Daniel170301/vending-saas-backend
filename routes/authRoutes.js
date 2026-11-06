// routes/authRoutes.js
const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

// 1. Inicio de sesión con correo y contraseña
router.post('/login', authController.login);

// 2. Registro con formulario (la contraseña se guarda con hash)
router.post('/register', authController.register);

// 3. Entrar o registrarse con Google (exige el token de la sesión de Google)
router.post('/google', authController.google);

// 4. Restablecer la contraseña tras confirmar el correo con el enlace de Supabase (v3.6)
router.post('/restablecer', authController.restablecer);

module.exports = router;
