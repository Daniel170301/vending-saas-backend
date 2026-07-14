// controllers/dashboardController.js

const getDashboardMetrics = async (req, res) => {
    try {
        // En el siguiente paso reemplazaremos esto con consultas reales a PostgreSQL (SUM, COUNT, etc.)
        // Por ahora, inyectamos datos de prueba para verificar la conexión con el panel de Lovable.
        const dashboardData = {
            today: 125.50,
            week: 850.20,
            month: 3450.00,
            year: 14200.00,
            machinesCount: 5,
            totalCoin: 200.00,
            profit: 4250.00
        };

        res.json(dashboardData);
    } catch (error) {
        console.error("Error obteniendo métricas del dashboard:", error);
        res.status(500).json({ success: false, message: "Error del servidor" });
    }
};

module.exports = {
    getDashboardMetrics
};