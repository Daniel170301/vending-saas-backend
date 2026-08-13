// routes/authRoutes.js
const express = require('express');
const router = express.Router();
const { login } = require('../controllers/authController');
// Necesitamos importar 'pool' para conectar a la BD
const pool = require('../config/db'); // Ajusta esta ruta si tu conexión está en otro lado

// Ruta original
router.post('/login', login);

// NUEVA RUTA DE GOOGLE
router.post('/google', async (req, res) => {
  try {
    const { email, nombre } = req.body;
    
    // 1. Buscamos si el usuario ya existe
    const q = await pool.query('SELECT * FROM usuarios_duenos WHERE correo = $1', [email]);
    
    if (q.rows.length > 0) {
      return res.json({ user: q.rows[0] });
    }

    // 2. Si no existe, lo insertamos
    const ins = await pool.query(
      'INSERT INTO usuarios_duenos (correo, nombre, rol) VALUES ($1, $2, $3) RETURNING *',
      [email, nombre || email, 'dueno']
    );
    
    res.json({ user: ins.rows[0] });
  } catch (error) {
    console.error("Error en auth de Google:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

module.exports = router;