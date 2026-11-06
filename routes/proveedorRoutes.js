// routes/proveedorRoutes.js
const express = require('express');
const router = express.Router();

// v3.5: los IDs de la dirección deben ser del dueño de la sesión (si no, 404)
const propiedad = require('../utils/propiedad');
router.param('id', propiedad.proveedor);

// Importamos las 4 funciones ahora (incluyendo updateProveedor)
const { getProveedores, createProveedor, deleteProveedor, updateProveedor } = require('../controllers/proveedorController');

// Ruta para obtener la lista
router.get('/', getProveedores);

// Ruta para guardar uno nuevo
router.post('/', createProveedor);

// Ruta para editar/actualizar un proveedor por su ID
router.put('/:id', updateProveedor);

// Ruta para eliminar un proveedor por su ID
router.delete('/:id', deleteProveedor);

module.exports = router;