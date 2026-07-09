// controllers/reportController.js
const pool = require('../config/database');

const obtenerHistorialVentas = async (req, res) => {
    const { machine_id } = req.params;

    try {
        const result = await pool.query(
            'SELECT codigo_motor, nombre_producto, precio, fecha FROM historial_ventas WHERE machine_id = $1 ORDER BY fecha DESC',
            [machine_id]
        );
        
        res.json({ success: true, ventas: result.rows });
    } catch (error) {
        console.error("Error obteniendo el historial de ventas:", error);
        res.status(500).json({ success: false, message: 'Error al obtener los reportes' });
    }
};

module.exports = {
    obtenerHistorialVentas
};