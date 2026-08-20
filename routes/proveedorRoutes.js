// routes/proveedorRoutes.js
const express = require('express');
const router = express.Router();

// Importamos las 3 funciones ahora
const { getProveedores, createProveedor, deleteProveedor } = require('../controllers/proveedorController');

// Ruta para obtener la lista
router.get('/', getProveedores);

// Ruta para guardar uno nuevo
router.post('/', createProveedor);

// Ruta para eliminar un proveedor por su ID
router.delete('/:id', deleteProveedor);

module.exports = router;