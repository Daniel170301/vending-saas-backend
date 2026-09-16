// services/cronJobs.js
const cron = require('node-cron');
const pool = require('../config/database'); // Ajustado para salir de 'services' y entrar a 'config'

// Se ejecuta todos los días a la 00:01 AM
cron.schedule('1 0 * * *', async () => {
    try {
        const hoy = new Date().getDate(); // Obtiene el día actual (1-31)
        
        // Buscamos las máquinas que deben depreciarse hoy
        const maquinas = await pool.query(`
            SELECT machine_id, name, costo_maquina, anos_depreciar 
            FROM maquinas 
            WHERE dia_depreciacion = $1 AND costo_maquina > 0 AND anos_depreciar > 0
        `, [hoy]);

        for (let maquina of maquinas.rows) {
            const depreciacionMensual = (maquina.costo_maquina / maquina.anos_depreciar) / 12;
            
            await pool.query(`
                INSERT INTO gastos (categoria, concepto, monto, fecha, machine_id) 
                VALUES ($1, $2, $3, CURRENT_DATE, $4)
            `, ['Mantenimiento', `Depreciación mensual automática - ${maquina.name}`, depreciacionMensual, maquina.machine_id]);
        }
        console.log(`[CRON] Depreciación ejecutada para ${maquinas.rowCount} máquinas.`);
    } catch (error) {
        console.error("[CRON] Error ejecutando depreciación mensual:", error);
    }
});