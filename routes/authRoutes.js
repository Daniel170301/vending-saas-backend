const express = require('express');
const router = express.Router();

const pool = require('../config/database'); 
const authController = require('../controllers/authController');

router.post('/login', authController.login);

router.post('/google', async (req, res) => {
  try {
    const { email, nombre } = req.body;
    
    const q = await pool.query('SELECT * FROM usuarios_duenos WHERE email = $1', [email]);
    
    if (q.rows.length > 0) {
      return res.json({ user: q.rows[0] });
    }

    // AQUÍ ESTÁ LA MAGIA: Le pasamos 'google_oauth' como contraseña para que la BD no explote
    const ins = await pool.query(
      'INSERT INTO usuarios_duenos (email, nombre, rol, password) VALUES ($1, $2, $3, $4) RETURNING *',
      [email, nombre || email, 'dueno', 'google_oauth']
    );
    
    res.json({ user: ins.rows[0] });
  } catch (error) {
    console.error("Error en auth de Google:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

module.exports = router;