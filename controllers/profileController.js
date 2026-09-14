const pool = require('../config/database'); // Ajusta la ruta a tu conexión de BD si es diferente

const getProfile = async (req, res) => {
    const { email } = req.params;
    try {
        const result = await pool.query('SELECT * FROM usuarios_duenos WHERE email = $1', [email]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error al obtener perfil:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
};

const updateProfile = async (req, res) => {
    const { email_actual } = req.params; // Usamos el correo actual para buscar al usuario
    const { nombre, apellido, tipo_documento, documento, celular, correo, imagen_perfil } = req.body;

    try {
        const updateQuery = `
            UPDATE usuarios_duenos
            SET nombre = $1,
                apellido = $2,
                tipo_documento = $3,
                documento = $4,
                celular = $5,
                email = $6,
                imagen_perfil = $7
            WHERE email = $8
            RETURNING *;
        `;
        const values = [nombre, apellido, tipo_documento, documento, celular, correo, imagen_perfil, email_actual];

        const result = await pool.query(updateQuery, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        res.json({ message: 'Perfil actualizado correctamente', user: result.rows[0] });
    } catch (error) {
        console.error('Error actualizando perfil:', error);
        res.status(500).json({ error: 'Error actualizando perfil en la base de datos' });
    }
};

module.exports = { getProfile, updateProfile };