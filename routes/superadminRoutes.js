// routes/superadminRoutes.js
// Entorno superadmin. TODAS las rutas exigen la sesión del superadmin (token + rol en la BD).
const express = require('express');
const router = express.Router();
const { soloSuperadmin } = require('../utils/auth');
const flota = require('../controllers/superadminFlotaController');
const yape = require('../controllers/superadminYapeController');
const catalogo = require('../controllers/superadminCatalogoController');
const clientes = require('../controllers/superadminClientesController');

router.use(soloSuperadmin);

// Centro de control y flota
router.get('/resumen', flota.resumen);
router.get('/maquinas', flota.listarMaquinas);
router.get('/maquinas/:id', flota.fichaMaquina);
router.put('/maquinas/:id/datos', flota.editarDatos);
router.put('/maquinas/:id/codigo-kmt', flota.asignarCodigoKMT);
router.delete('/maquinas/:id/codigo-kmt', flota.quitarCodigoKMT);
router.put('/maquinas/:id/equipo', flota.cambiarEquipo);
router.put('/maquinas/:id/yape', flota.vincularYape);
router.get('/codigos/siguiente', flota.siguienteCodigo);
router.get('/equipos-disponibles', flota.equiposDisponibles);
router.get('/huerfanos', flota.listarHuerfanos);
router.post('/huerfanos/mover', flota.moverHuerfanos);

// Cobros Yape, incidencias y sincronización
router.get('/cuentas-yape', yape.listarCuentas);
router.post('/cuentas-yape', yape.crearCuenta);
router.put('/cuentas-yape/:id', yape.editarCuenta);
router.get('/pagos-yape', yape.listarPagos);
router.post('/pagos-yape/:id/reembolsado', yape.marcarReembolsado);
router.get('/incidencias', yape.listarIncidencias);
router.post('/incidencias/resolver', yape.resolverIncidencias);
router.get('/sincronizacion', yape.sincronizacion);
router.post('/sincronizacion/reintentar', yape.reintentarSincronizacion);

// Clientes: mensualidad, suspensión y soporte
router.get('/clientes', clientes.listarClientes);
router.get('/clientes/:id', clientes.fichaCliente);
router.put('/clientes/:id/mensualidad', clientes.guardarMensualidad);
router.post('/clientes/:id/pagos', clientes.registrarPago);
router.put('/clientes/:id/suspension', clientes.suspenderCliente);
router.post('/clientes/:id/entrar', clientes.entrarComoCliente);
router.put('/maquinas/:id/suspension', clientes.suspenderMaquina);

// Catálogos
router.get('/regiones', catalogo.listarRegiones);
router.post('/regiones', catalogo.crearRegion);
router.put('/regiones/:id', catalogo.editarRegion);
router.delete('/regiones/:id', catalogo.eliminarRegion);
router.get('/duenos', catalogo.listarDuenos);
router.get('/auditoria', catalogo.listarAuditoria);

module.exports = router;
