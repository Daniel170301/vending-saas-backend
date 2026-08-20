// routes/clientRoutes.js
const express = require('express');
const router = express.Router();

// Importamos las 4 funciones del controlador (agregamos deleteClient)
const { createClient, getClients, updateClientStatus, deleteClient } = require('../controllers/clientController');

// 1. Rutas principales de la tabla y formulario
router.get('/', getClients); 
router.post('/', createClient); 

// 2. Ruta para el Switch (Habilitar/Deshabilitar)
router.put('/:id/status', updateClientStatus); 

// 3. Ruta para eliminar un cliente (NUEVA)
router.delete('/:id', deleteClient); 

module.exports = router;