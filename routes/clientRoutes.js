// routes/clientRoutes.js
const express = require('express');
const router = express.Router();
const { getUsers, createClient, getClients, updateClientStatus } = require('../controllers/clientController');

// 1. Ruta para el selector de usuarios en el modal
router.get('/users', getUsers); 

// 2. Rutas principales de la tabla y formulario
router.get('/', getClients); 
router.post('/', createClient); 

// 3. Ruta para el Switch (Habilitar/Deshabilitar)
router.put('/:id/status', updateClientStatus); 

module.exports = router;