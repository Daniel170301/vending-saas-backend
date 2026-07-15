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
// Consulta SQL: Unimos las tablas para traer solo las máquinas de este dueño
        const query = `
            SELECT 
                m.machine_id AS id,
                COALESCE(m.name, m.machine_id) AS name, 
                COALESCE(m.code, m.machine_id) AS code,
                COALESCE(m.location, m.ubicacion) AS location,
                m.numero_celular AS phone,
                'online' AS status,
                -- Agregamos TODAS las columnas nuevas que necesita React
                m.brand,
                m.model,
                m.plate,
                m.coin_base,
                m.coin_current,
                m.coin_brand,
                m.coin_plate,
                m.bill_enabled,
                m.bill_brand,
                m.bill_model,
                m.bill_plate,
                m.layout
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
const updateMachine = async (req, res) => {
    try {
        const { id } = req.params; // Esta es la MAC (machine_id) que viene en la URL
        const data = req.body;     // Estos son los datos que enviaste desde React

        const query = `
            UPDATE maquinas 
            SET 
                name = $1,
                code = $2,
                location = $3,
                coin_base = $4,
                brand = $5,
                model = $6,
                plate = $7,
                coin_brand = $8,
                coin_plate = $9,
                bill_enabled = $10,
                bill_brand = $11,
                bill_model = $12,
                bill_plate = $13,
                layout = $14
            WHERE machine_id = $15
        `;
        
        const values = [
            data.name, data.code, data.location, data.coin_base,
            data.brand, data.model, data.plate, data.coin_brand, data.coin_plate,
            data.bill_enabled, data.bill_brand, data.bill_model, data.bill_plate,
            data.layout, id
        ];

        await pool.query(query, values);
        
        res.json({ success: true, message: "Máquina actualizada correctamente" });
    } catch (error) {
        console.error("Error al actualizar la máquina:", error);
        res.status(500).json({ success: false, message: "Error interno del servidor" });
    }
};

// Recuerda exportarla al final del archivo:
module.exports = {
    getMachines,
    updateMachine // <-- Agrega esto
};
