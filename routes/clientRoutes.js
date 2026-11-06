// routes/clientRoutes.js
const express = require('express');
const router = express.Router();

// v3.5: los IDs de la dirección deben ser del dueño de la sesión (si no, 404)
const propiedad = require('../utils/propiedad');
router.param('id', propiedad.cliente);

// Importamos TODAS las funciones del controlador, incluyendo updateClient
const { createClient, getClients, updateClientStatus, updateClient, deleteClient } = require('../controllers/clientController');

// 1. Rutas principales de la tabla y formulario
router.get('/', getClients); 
router.post('/', createClient); 

// 2. Ruta para el Switch (Habilitar/Deshabilitar)
router.put('/:id/status', updateClientStatus); 

// 3. Ruta para editar toda la información del cliente (ESTA SOLUCIONA EL 404)
router.put('/:id', updateClient);

// 4. Ruta para eliminar un cliente
router.delete('/:id', deleteClient); 

module.exports = router;