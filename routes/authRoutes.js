// routes/authRoutes.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken'); 

const pool = require('../config/database'); 
const authController = require('../controllers/authController');

// 1. INICIO DE SESIÓN NORMAL
router.post('/login', authController.login);

// 2. NUEVO: REGISTRO MANUAL (Formulario)
router.post('/register', async (req, res) => {
  try {
    const { nombre, email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ success: false, message: "Correo y contraseña son requeridos" });
    }

    // Buscamos si el usuario ya existe para no duplicarlo
    const check = await pool.query('SELECT * FROM usuarios_duenos WHERE email = $1', [email]);
    if (check.rows.length > 0) {
        return res.status(400).json({ success: false, message: "El usuario ya existe" });
    }

    // Lo insertamos guardando su contraseña
    const ins = await pool.query(
        'INSERT INTO usuarios_duenos (nombre, email, password, rol) VALUES ($1, $2, $3, $4) RETURNING *',
        [nombre || 'Usuario', email, password, 'dueno']
    );
    const user = ins.rows[0];

    // Fabricamos el token para que entre directamente sin tener que volver a loguearse
    const token = jwt.sign(
      { id: user.id, email: user.email, rol: user.rol, nombre: user.nombre },
      process.env.JWT_SECRET || 'super_secreto_inventaxo_2026',
      { expiresIn: '12h' }
    );

    res.json({
      success: true,
      message: "Registro exitoso",
      token: token,
      user: { id: user.id, nombre: user.nombre, email: user.email, rol: user.rol }
    });
  } catch (error) {
    console.error("Error en registro:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// 3. INICIO DE SESIÓN / REGISTRO CON GOOGLE (Intacto)
router.post('/google', async (req, res) => {
  try {
    const { email, nombre } = req.body;
    let user;
    
    const q = await pool.query('SELECT * FROM usuarios_duenos WHERE email = $1', [email]);
    
    if (q.rows.length > 0) {
      user = q.rows[0]; 
    } else {
      const ins = await pool.query(
        'INSERT INTO usuarios_duenos (email, nombre, rol, password) VALUES ($1, $2, $3, $4) RETURNING *',
        [email, nombre || email, 'dueno', 'google_oauth']
      );
      user = ins.rows[0]; 
    }

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