// controllers/authController.js
const pool = require('../config/database');
const jwt = require('jsonwebtoken');

const login = async (req, res) => {
    try {
        // 1. Recibimos las credenciales que enviará la pantalla de Login
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: "Correo y contraseña son requeridos" });
        }

        // 2. Buscamos al usuario en tu tabla usuarios_duenos
        const query = 'SELECT * FROM usuarios_duenos WHERE email = $1';
        const result = await pool.query(query, [email]);
        const user = result.rows[0];

        // 3. Verificamos si existe y si la contraseña es correcta
        // IMPORTANTE: Como insertaste contraseñas en texto plano en DBeaver (Ej: 'kymatic2026'),
        // por ahora las comparamos de forma directa. En producción, usaremos bcrypt para encriptarlas.
        if (!user || user.password !== password) {
            return res.status(401).json({ success: false, message: "Correo o contraseña incorrectos" });
        }

        // 4. Fabricamos el Token JWT (El pase VIP)
        // Guardamos el id, email y rol dentro del token de forma encriptada
        const token = jwt.sign(
            { 
                id: user.id, 
                email: user.email, 
                rol: user.rol, 
                nombre: user.nombre 
            },
            process.env.JWT_SECRET || 'super_secreto_inventaxo_2026', // La llave para firmar (mejor ponerla en el .env)
            { expiresIn: '12h' } // El token caduca en 12 horas
        );

        // 5. Enviamos el token y los datos básicos al Frontend
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