const pool = require('../config/database'); // Ajusta la ruta a tu conexión de BD si es diferente
const { olvidar } = require('../utils/usuarios');
const { firmarToken } = require('../utils/auth');
const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Nunca devolver la contraseña (antes GET /api/perfil/:email la entregaba a cualquiera)
const sinClave = ({ password, contrasena, ...resto }) => resto;

const getProfile = async (req, res) => {
    const { email } = req.params;
    try {
        const result = await pool.query('SELECT * FROM usuarios_duenos WHERE lower(email) = lower($1) ORDER BY id LIMIT 1', [email]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }
        res.json(sinClave(result.rows[0]));
    } catch (error) {
        console.error('Error al obtener perfil:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

const updateProfile = async (req, res) => {
    const { email_actual } = req.params; // Usamos el correo actual para buscar al usuario
    const { nombre, apellido, tipo_documento, documento, celular, imagen_perfil } = req.body;
    const correo = String(req.body.correo || email_actual || '').trim().toLowerCase();

    try {
        // v3.5: el correo nuevo no puede ser el de otra cuenta (antes se podía "copiar" el correo
        // de otro dueño y quedar con dos cuentas iguales)
        if (!EMAIL_OK.test(correo)) return res.status(400).json({ error: 'El correo no es válido' });
        const otro = await pool.query('SELECT 1 FROM usuarios_duenos WHERE lower(email) = $1 AND lower(email) <> lower($2)', [correo, email_actual]);
        if (otro.rowCount) return res.status(409).json({ error: 'Ese correo ya está en uso por otra cuenta' });

        const updateQuery = `
            UPDATE usuarios_duenos
            SET nombre = $1,
                apellido = $2,
                tipo_documento = $3,
                documento = $4,
                celular = $5,
                email = $6,
                imagen_perfil = $7
            WHERE lower(email) = lower($8)
            RETURNING *;
        `;
        const values = [nombre, apellido, tipo_documento, documento, celular, correo, imagen_perfil, email_actual];

        const result = await pool.query(updateQuery, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        olvidar(email_actual);
        olvidar(correo);
        const u = result.rows[0];
        // Si cambió el correo, la sesión anterior deja de valer: se entrega una nueva
        const cambio = correo !== String(email_actual).trim().toLowerCase();
        const token = cambio && req.usuario && !req.usuario.soporte ? firmarToken(u) : undefined;
        res.json({ message: 'Perfil actualizado correctamente', user: sinClave(u), ...(token ? { token } : {}) });
    } catch (error) {
        console.error('Error actualizando perfil:', error);
        res.status(500).json({ error: 'Error actualizando perfil en la base de datos' });
    }
};

module.exports = { getProfile, updateProfile };