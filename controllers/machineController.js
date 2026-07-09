// controllers/machineController.js
const pool = require('../config/database');

const obtenerMaquinas = async (req, res) => {
    const { id_dueno } = req.params;
    try {
        const userResult = await pool.query('SELECT rol FROM usuarios_duenos WHERE id = $1', [id_dueno]);
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
        }
        
        const rolUsuario = userResult.rows[0].rol;
        let query = rolUsuario === 'superadmin'
            ? 'SELECT m.*, u.nombre AS nombre_dueno FROM maquinas m LEFT JOIN usuarios_duenos u ON m.id_dueno = u.id'
            : 'SELECT m.*, u.nombre AS nombre_dueno FROM maquinas m LEFT JOIN usuarios_duenos u ON m.id_dueno = u.id WHERE m.id_dueno = $1';
            
        const result = await pool.query(query, rolUsuario === 'superadmin' ? [] : [id_dueno]);
        res.json({ success: true, maquinas: result.rows });
    } catch (error) {
        console.error("Error al consultar máquinas:", error);
        res.status(500).json({ success: false, message: 'Error al consultar máquinas' });
    }
};

module.exports = { obtenerMaquinas };