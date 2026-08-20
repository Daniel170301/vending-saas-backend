// controllers/expenseController.js
const pool = require('../config/database');

const registerPurchase = async (req, res) => {
    // Iniciamos una conexión especial para la "Transacción"
    const client = await pool.connect();
    
    try {
        const { 
            id_usuario, // Para enlazarlo a la cuenta del cliente/dueño
            proveedor, 
            tipo_comprobante, 
            numero_documento, 
            fecha_compra,
            total, 
            productos // Este será un arreglo (lista) con lo que compraste
        } = req.body;

        if (!id_usuario || !productos || productos.length === 0) {
            return res.status(400).json({ success: false, message: 'Faltan datos o productos en la compra' });
        }

        // 1. Iniciamos la transacción (Si algo falla, no se guarda nada)
        await client.query('BEGIN');

        // 2. Guardamos el Gasto Principal
        const concepto = `Compra de mercadería - ${tipo_comprobante} ${numero_documento || 'Sin N°'}`;
        const gastoQuery = `
            INSERT INTO transacciones_gastos (id_dueno, concepto, proveedor, metodo_pago, total, fecha) 
            VALUES ($1, $2, $3, $4, $5, $6) 
            RETURNING id;
        `;
        // Asumimos el pago por defecto como 'Efectivo' para compras directas, puedes adaptarlo luego
        const gastoResult = await client.query(gastoQuery, [id_usuario, concepto, proveedor, 'Efectivo', total, fecha_compra || new Date()]);
        const id_transaccion = gastoResult.rows[0].id;

        // 3. Guardamos el detalle y SUMAMOS EL STOCK por cada producto
        for (let prod of productos) {
            // A. Guardamos el registro de qué se compró exactamente
            await client.query(`
                INSERT INTO compras_detalle (id_transaccion, id_producto, cantidad, costo_unitario, total)
                VALUES ($1, $2, $3, $4, $5)
            `, [id_transaccion, prod.id_producto, prod.cantidad, prod.costo_compra, prod.subtotal]);

            // B. ¡LA MAGIA AQUÍ! Sumamos la cantidad comprada al stock actual del almacén
            // También actualizamos el unit_cost al nuevo precio de compra para tener un buen costeo
            await client.query(`
                UPDATE productos_almacen 
                SET stock_warehouse = stock_warehouse + $1,
                    unit_cost = $2
                WHERE id = $3
            `, [prod.cantidad, prod.costo_compra, prod.id_producto]);
        }

        // 4. Confirmamos que todo salió perfecto y guardamos de verdad
        await client.query('COMMIT');
        res.json({ success: true, message: 'Compra registrada y stock actualizado correctamente' });

    } catch (error) {
        // Si hay cualquier error (ej. se va el internet), revertimos todo
        await client.query('ROLLBACK');
        console.error('Error registrando la compra:', error);
        res.status(500).json({ success: false, message: 'Error interno al procesar la compra' });
    } finally {
        // Liberamos la conexión
        client.release();
    }
};
// Obtener la lista de gastos para mostrar en la pantalla
const getExpenses = async (req, res) => {
    try {
        const query = `
            SELECT id, concepto, proveedor, metodo_pago, total, fecha 
            FROM transacciones_gastos 
            ORDER BY fecha DESC;
        `;
        const result = await pool.query(query);
        res.json({ success: true, gastos: result.rows, data: result.rows });
    } catch (error) {
        console.error('Error al obtener gastos:', error);
        res.status(500).json({ success: false, message: 'Error en BD' });
    }
};
module.exports = {
    registerPurchase,
    getExpenses 
};