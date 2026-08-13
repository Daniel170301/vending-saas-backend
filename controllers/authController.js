const express = require('express');
const router = express.Router();

// 1. Conexión a tu base de datos
const pool = require('../config/database'); 

// 2. CAMBIO CLAVE: Importamos el controlador completo
const authController = require('../controllers/authController');

// 3. CAMBIO CLAVE: Llamamos a la función desde el controlador
router.post('/login', authController.login);

// Ruta de Google
router.post('/google', async (req, res) => {
  try {
    const { email, nombre } = req.body;
    
    // Buscamos si el usuario ya existe (usando "email")
    const q = await pool.query('SELECT * FROM usuarios_duenos WHERE email = $1', [email]);
    
    if (q.rows.length > 0) {
      return res.json({ user: q.rows[0] });
    }

    // Si no existe, lo insertamos (usando "email")
    const ins = await pool.query(
      'INSERT INTO usuarios_duenos (email, nombre, rol) VALUES ($1, $2, $3) RETURNING *',
      [email, nombre || email, 'dueno']
    );
    
    res.json({ user: ins.rows[0] });
  } catch (error) {
    console.error("Error en auth de Google:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

module.exports = router;