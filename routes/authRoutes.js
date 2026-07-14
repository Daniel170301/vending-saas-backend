// routes/authRoutes.js
const express = require('express');
const router = express.Router();
const { login } = require('../controllers/authController');

// Esta ruta será accesible por método POST en: /api/auth/login
router.post('/login', login);

module.exports = router;