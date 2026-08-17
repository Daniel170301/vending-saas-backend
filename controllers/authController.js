// controllers/authController.js
const pool = require('../config/database');
const jwt = require('jsonwebtoken');

// ==========================================
// 1. TU FUNCIÓN DE LOGIN (INTACTA)
// ==========================================
const login = async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: "Correo y contraseña son requeridos" });
        }

        const query = 'SELECT * FROM usuarios_duenos WHERE email = $1';
        const result = await pool.query(query, [email]);
        const user = result.rows[0];

        if (!user || user.password !== password) {
            return res.status(401).json({ success: false, message: "Correo o contraseña incorrectos" });
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
            message: "Login exitoso",
            token: token,
            user: {
                id: user.id,
                nombre: user.nombre,
                email: user.email,
                rol: user.rol
            }
        });

    } catch (error) {
        console.error("Error en el login:", error);
        res.status(500).json({ success: false, message: "Error interno del servidor" });
    }
};

// ==========================================
// 2. NUEVA FUNCIÓN DE REGISTRO
// ==========================================
const registerUser = async (req, res) => {
    try {
        const { nombre, email } = req.body;

        if (!email) {
            return res.status(400).json({ success: false, message: 'El email es obligatorio' });
        }

        // Verificamos si el usuario ya existe
        const checkUser = await pool.query('SELECT * FROM usuarios_duenos WHERE email = $1', [email]);
        
        if (checkUser.rows.length > 0) {
            return res.json({ 
                success: true, 
                message: 'El usuario ya existe', 
                user: checkUser.rows[0] 
            });
        }

        // Si no existe, lo insertamos con el rol por defecto de 'dueno'
        const insertQuery = `
            INSERT INTO usuarios_duenos (nombre, email, rol) 
            VALUES ($1, $2, 'dueno') 
            RETURNING *;
        `;
        const result = await pool.query(insertQuery, [nombre || 'Usuario Nuevo', email]);

        res.json({ 
            success: true, 
            message: 'Usuario registrado correctamente en la base de datos', 
            user: result.rows[0] 
        });

    } catch (error) {
        console.error('Error al registrar usuario en la BD:', error);
        res.status(500).json({ success: false, message: 'Error interno del servidor' });
    }
};

// ==========================================
// 3. EXPORTAMOS AMBAS FUNCIONES
// ==========================================
module.exports = {
    login,
    registerUser // <-- Asegúrate de que esta línea esté aquí
};