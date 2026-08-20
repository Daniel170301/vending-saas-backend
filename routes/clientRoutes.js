// routes/clientRoutes.js
const express = require('express');
const router = express.Router();

// Importamos SOLO las 3 funciones que existen ahora en el controlador
const { createClient, getClients, updateClientStatus } = require('../controllers/clientController');

// 1. Rutas principales de la tabla y formulario
router.get('/', getClients); 
router.post('/', createClient); 

// 2. Ruta para el Switch (Habilitar/Deshabilitar)
router.put('/:id/status', updateClientStatus); 

module.exports = router;