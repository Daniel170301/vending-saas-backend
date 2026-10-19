// routes/machineRoutes.js
const express = require('express');
const router = express.Router();
const { soloSuperadmin } = require('../utils/auth');

// 1. IMPORTACIÓN CORREGIDA: Traemos todas las funciones, incluyendo updateMachineSettings
const { 
    getMachines, 
    getMachine,
    updateMachine, 
    createMachine, 
    deleteMachine,
    updateMachineSettings // <-- ¡ESTA ES LA PALABRA QUE FALTABA!
} = require('../controllers/machineController');

// 2. TUS RUTAS
router.get('/', getMachines);
router.get('/:id', getMachine);   // una máquina completa (con layout)
router.post('/', createMachine);
router.put('/:id', updateMachine);
router.delete('/:id', deleteMachine);

// 3. LA NUEVA RUTA PARA EL CANDADO
router.put('/:id/settings', soloSuperadmin, updateMachineSettings);   // solo superadmin (antes cualquiera)

module.exports = router;