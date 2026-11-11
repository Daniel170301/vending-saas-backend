// routes/solicitudesRoutes.js  (v3.6.6) · formulario público /registro (sin sesión)
const express = require('express');
const router = express.Router();
const c = require('../controllers/solicitudesController');
router.post('/', express.json({ limit: '32kb' }), c.crear);
module.exports = router;
