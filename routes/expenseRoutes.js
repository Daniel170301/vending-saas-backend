const express = require('express');
const router = express.Router();

// v3.5: los IDs de la dirección deben ser del dueño de la sesión (si no, 404)
const propiedad = require('../utils/propiedad');
router.param('id', propiedad.gasto);
router.param('id_transaccion', propiedad.compra);
router.param('id_detalle', propiedad.detalleCompra);

// Importamos TODAS las funciones que creamos en el controlador, incluyendo las nuevas
const { 
    registerPurchase, 
    getExpenses, 
    getExpenseDetails, 
    getComprobante,
    deleteExpense, 
    updateExpense,
    eliminarDetalleGasto,
    agregarDetalleGasto,
    crearGasto // 🔥 1. AQUÍ AGREGAMOS LA NUEVA FUNCIÓN
} = require('../controllers/expenseController');

// Rutas originales
router.get('/', getExpenses);

// 🔥 2. AQUÍ AGREGAMOS LA RUTA QUE SOLUCIONA EL ERROR 404
// Esta ruta recibe los gastos operativos (Logística, Nómina, etc.)
router.post('/', crearGasto); 

// Esta ruta sigue intacta para la mercadería
router.post('/purchase', registerPurchase);

// NUEVAS RUTAS para el modal general (Detalle, Eliminar todo, Editar concepto/proveedor)
router.get('/:id/detalle', getExpenseDetails);
router.get('/:id/comprobante', getComprobante);
router.delete('/:id', deleteExpense);
router.put('/:id', updateExpense);

// RUTAS DINÁMICAS para el Modo Edición por fila (Eliminar/Agregar un solo producto)
router.delete('/:id_transaccion/detalles/:id_detalle', eliminarDetalleGasto);
router.post('/:id_transaccion/detalles', agregarDetalleGasto);

module.exports = router;