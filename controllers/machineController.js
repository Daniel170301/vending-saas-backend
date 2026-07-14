// controllers/machineController.js
const pool = require('../config/database');

const getMachines = async (req, res) => {
    try {
        const usuarioSolicitante = req.query.user;

        if (!usuarioSolicitante || usuarioSolicitante === 'desconocido') {
            return res.json([]); // Si no hay usuario, devolvemos un arreglo vacío
        }

        console.log(`Buscando máquinas para el usuario: ${usuarioSolicitante}`);

        // Consulta SQL: Unimos las tablas para traer solo las máquinas de este dueño
        const query = `
            SELECT 
                m.machine_id AS id,
                m.machine_id AS name, -- Usamos la MAC como nombre temporal si no hay columna nombre
                m.ubicacion AS location,
                m.numero_celular AS phone,
                'online' AS status -- Temporalmente simulamos que está online
            FROM maquinas m
            JOIN usuarios_duenos u ON m.id_dueno = u.id
            WHERE u.email = $1;
        `;

        const resultado = await pool.query(query, [usuarioSolicitante]);

        // Devolvemos el arreglo de máquinas al frontend
        res.json(resultado.rows);
    } catch (error) {
        console.error("Error obteniendo máquinas:", error);
        res.status(500).json({ success: false, message: "Error del servidor" });
    }
};

module.exports = {
    getMachines
};