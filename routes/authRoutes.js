// routes/authRoutes.js
const express = require('express');
const router = express.Router();
const pool = require('../config/database'); 

// 1. IMPORTACIÓN A PRUEBA DE BALAS
// Traemos todo el archivo en lugar de desestructurar, así evitamos que se pierda la función
const authController = require('../controllers/authController');

// 2. Ruta de login normal (Llamamos a la función explícitamente)
router.post('/login', authController.login);

// 3. Ruta de Google
router.post('/google', async (req, res) => {
  try {
    const { email, nombre } = req.body;
    
    // Buscamos si el usuario ya existe
    const q = await pool.query('SELECT * FROM usuarios_duenos WHERE email = $1', [email]);
    
    if (q.rows.length > 0) {
      return res.json({ user: q.rows[0] });
    }

    // Si no existe, lo insertamos
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