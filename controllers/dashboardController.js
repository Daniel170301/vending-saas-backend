// controllers/dashboardController.js
const pool = require('../config/database'); 

const getDashboardMetrics = async (req, res) => {
    try {
        const usuarioSolicitante = req.query.user || req.query.email || req.query.user_id;

        if (!usuarioSolicitante || usuarioSolicitante === 'desconocido') {
            return res.json({ today: 0, week: 0, month: 0, year: 0, machinesCount: 0, totalCoin: 0, profit: 0 });
        }

        const queryVentas = `
            SELECT 
                COALESCE(SUM(CASE WHEN v.fecha >= CURRENT_DATE THEN v.precio ELSE 0 END), 0) AS today,
                COALESCE(SUM(CASE WHEN v.fecha >= date_trunc('week', CURRENT_DATE) THEN v.precio ELSE 0 END), 0) AS week,
                COALESCE(SUM(CASE WHEN v.fecha >= date_trunc('month', CURRENT_DATE) THEN v.precio ELSE 0 END), 0) AS month,
                COALESCE(SUM(CASE WHEN v.fecha >= date_trunc('year', CURRENT_DATE) THEN v.precio ELSE 0 END), 0) AS year
            FROM historial_ventas v
            JOIN maquinas m ON v.machine_id = m.machine_id
            JOIN usuarios_duenos u ON m.id_dueno::text = u.id::text
            WHERE u.email = $1;
        `;

        const queryMaquinas = `
            SELECT COUNT(*) as machine_count
            FROM maquinas m
            JOIN usuarios_duenos u ON m.id_dueno::text = u.id::text
            WHERE u.email = $1;
        `;

        const [resVentas, resMaquinas] = await Promise.all([
            pool.query(queryVentas, [usuarioSolicitante]),
            pool.query(queryMaquinas, [usuarioSolicitante])
        ]);

        const ventas = resVentas.rows[0];
        const maquinas = resMaquinas.rows[0];

        const dashboardData = {
            today: parseFloat(ventas.today),
            week: parseFloat(ventas.week),
            month: parseFloat(ventas.month),
            year: parseFloat(ventas.year),
            machinesCount: parseInt(maquinas.machine_count),
            totalCoin: 0, 
            profit: parseFloat(ventas.year) 
        };

        res.json(dashboardData);

    } catch (error) {
        console.error("Error obteniendo métricas reales:", error);
        res.status(500).json({ success: false, message: "Error del servidor" });
    }
};

// =========================================================================
// NUEVO: OBTENER TOP 20 PRODUCTOS MÁS VENDIDOS (Con filtro de máquina y fechas)
// =========================================================================
const obtenerTopProductos = async (req, res) => {
    try {
        const user_email = req.query.email || req.query.user_id || req.query.user;
        const machine_id = req.query.machine_id; 
        
        // 1. Nuevas variables de fecha que enviará Lovable
        const fecha_inicio = req.query.fecha_inicio;
        const fecha_fin = req.query.fecha_fin;

        if (!user_email) {
            return res.status(400).json({ success: false, message: 'Falta el correo del usuario' });
        }

        // 2. Construcción dinámica de la condición WHERE
        let values = [user_email];
        let whereClause = "WHERE u.email = $1";
        let paramIndex = 2;

        if (machine_id && machine_id !== 'general' && machine_id !== 'Todas') {
            whereClause += ` AND v.machine_id = $${paramIndex}`;
            values.push(machine_id);
            paramIndex++;
        }

        if (fecha_inicio) {
            whereClause += ` AND v.fecha >= $${paramIndex}`;
            values.push(fecha_inicio);
            paramIndex++;
        }

        if (fecha_fin) {
            whereClause += ` AND v.fecha <= $${paramIndex}`;
            values.push(`${fecha_fin} 23:59:59`); // Asegura cubrir todo el día
            paramIndex++;
        }

        // 3. Tu misma consulta, pero inyectando el WHERE dinámico
        const query = `
            SELECT 
                v.nombre_producto, 
                COUNT(*) as total_unidades, 
                SUM(v.precio) as ingresos
            FROM historial_ventas v
            JOIN maquinas m ON v.machine_id = m.machine_id
            JOIN usuarios_duenos u ON m.id_dueno::text = u.id::text
            ${whereClause}
            GROUP BY v.nombre_producto
            ORDER BY total_unidades DESC
            LIMIT 20;
        `;

        const { rows } = await pool.query(query, values);
        res.json({ success: true, top_productos: rows });

    } catch (error) {
        console.error('Error obteniendo top productos:', error);
        res.status(500).json({ success: false, message: 'Error interno del servidor' });
    }
};

module.exports = {
    getDashboardMetrics,
    obtenerTopProductos // <-- Exportamos la nueva función
};