const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken'); // 1. IMPORTAMOS EL CREADOR DE TOKENS

const pool = require('../config/database'); 
const authController = require('../controllers/authController');

router.post('/login', authController.login);

router.post('/google', async (req, res) => {
  try {
    const { email, nombre } = req.body;
    let user;
    
    // Buscamos si el usuario ya existe
    const q = await pool.query('SELECT * FROM usuarios_duenos WHERE email = $1', [email]);
    
    if (q.rows.length > 0) {
      user = q.rows[0]; // Si existe, lo guardamos en la variable
    } else {
      // Si no existe, lo insertamos
      const ins = await pool.query(
        'INSERT INTO usuarios_duenos (email, nombre, rol, password) VALUES ($1, $2, $3, $4) RETURNING *',
        [email, nombre || email, 'dueno', 'google_oauth']
      );
      user = ins.rows[0]; // Lo guardamos en la variable
    }

    // 2. FABRICAMOS EL TOKEN (El pase VIP) IGUAL QUE EN EL LOGIN NORMAL
    const token = jwt.sign(
      { 
          id: user.id, 
          email: user.email, 
          rol: user.rol, 
          nombre: user.nombre 
      },
      process.env.JWT_SECRET || 'super_secreto_inventaxo_2026',
      { expiresIn: '12h' }
    );

    // 3. ENVIAMOS LA RESPUESTA EXACTAMENTE COMO EL FRONTEND LA ESPERA
    res.json({
      success: true,
      message: "Login con Google exitoso",
      token: token,
      user: {
          id: user.id,
          nombre: user.nombre,
          email: user.email,
          rol: user.rol
      }
    });
    
  } catch (error) {
    console.error("Error en auth de Google:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

module.exports = router;