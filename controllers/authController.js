// controllers/authController.js
const pool = require('../config/database'); // Importamos la conexión a la BD

const login = async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query(
            'SELECT id, nombre, email, rol FROM usuarios_duenos WHERE email = $1 AND password = $2', 
            [email, password]
        );
        
        if (result.rows.length > 0) {
            res.json({ success: true, user: result.rows[0] });
        } else {
            res.json({ success: false, message: 'Credenciales incorrectas' });
        }
    } catch (error) {
        console.error("Error en login:", error);
        res.status(500).json({ success: false, message: 'Error de servidor' });
    }
};

module.exports = {
    login
};