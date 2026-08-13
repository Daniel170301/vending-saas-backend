// controllers/authController.js
const pool = require('../config/database');
const jwt = require('jsonwebtoken');

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

module.exports = {
    login
};