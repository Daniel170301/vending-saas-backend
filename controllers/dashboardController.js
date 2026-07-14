// controllers/dashboardController.js
const pool = require('../config/database'); // <-- Ajusta esta ruta si tu archivo de conexión se llama diferente

const getDashboardMetrics = async (req, res) => {
    try {
        const usuarioSolicitante = req.query.user;

        // Filtro de seguridad
        if (!usuarioSolicitante || usuarioSolicitante === 'desconocido') {
            return res.json({ today: 0, week: 0, month: 0, year: 0, machinesCount: 0, totalCoin: 0, profit: 0 });
        }

        // 1. Consulta SQL para sumar las ventas filtrando por el correo del dueño
        const queryVentas = `
            SELECT 
                COALESCE(SUM(CASE WHEN v.fecha >= CURRENT_DATE THEN v.precio ELSE 0 END), 0) AS today,
                COALESCE(SUM(CASE WHEN v.fecha >= date_trunc('week', CURRENT_DATE) THEN v.precio ELSE 0 END), 0) AS week,
                COALESCE(SUM(CASE WHEN v.fecha >= date_trunc('month', CURRENT_DATE) THEN v.precio ELSE 0 END), 0) AS month,
                COALESCE(SUM(CASE WHEN v.fecha >= date_trunc('year', CURRENT_DATE) THEN v.precio ELSE 0 END), 0) AS year
            FROM historial_ventas v
            JOIN maquinas m ON v.machine_id = m.machine_id
            JOIN usuarios_duenos u ON m.id_dueno = u.id
            WHERE u.email = $1;
        `;

        // 2. Consulta SQL para contar cuántas máquinas tiene este usuario
        const queryMaquinas = `
            SELECT COUNT(*) as machine_count
            FROM maquinas m
            JOIN usuarios_duenos u ON m.id_dueno = u.id
            WHERE u.email = $1;
        `;

        // Ejecutamos ambas consultas al mismo tiempo para mayor velocidad
        const [resVentas, resMaquinas] = await Promise.all([
            pool.query(queryVentas, [usuarioSolicitante]),
            pool.query(queryMaquinas, [usuarioSolicitante])
        ]);

        const ventas = resVentas.rows[0];
        const maquinas = resMaquinas.rows[0];

        // 3. Empaquetamos los datos reales para el Frontend
        const dashboardData = {
            today: parseFloat(ventas.today),
            week: parseFloat(ventas.week),
            month: parseFloat(ventas.month),
            year: parseFloat(ventas.year),
            machinesCount: parseInt(maquinas.machine_count),
            totalCoin: 0, // Se puede vincular a una columna de "saldo" futuro
            profit: parseFloat(ventas.year) // Por ahora, la ganancia refleja el ingreso total anual
        };

        res.json(dashboardData);
    } catch (error) {
        console.error("Error obteniendo métricas reales:", error);
        res.status(500).json({ success: false, message: "Error del servidor" });
    }
};

module.exports = {
    getDashboardMetrics
};