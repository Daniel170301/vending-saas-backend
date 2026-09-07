// controllers/expenseController.js
const pool = require('../config/database');

// 1. REGISTRAR COMPRA (Mejorado con Costo Promedio Ponderado)
const registerPurchase = async (req, res) => {
    const client = await pool.connect();
    try {
        const { id_usuario, proveedor, tipo_comprobante, numero_documento, fecha_compra, total, productos } = req.body;

        if (!id_usuario || !productos || productos.length === 0) {
            return res.status(400).json({ success: false, message: 'Faltan datos o productos en la compra' });
        }

        await client.query('BEGIN');

        const concepto = `Compra de mercadería - ${tipo_comprobante} ${numero_documento || 'Sin N°'}`;
        const gastoResult = await client.query(`
            INSERT INTO transacciones_gastos (id_dueno, concepto, proveedor, metodo_pago, total, fecha) 
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING id;
        `, [id_usuario, concepto, proveedor, 'Efectivo', total, fecha_compra || new Date()]);
        
        const id_transaccion = gastoResult.rows[0].id;

        for (let prod of productos) {
            // A. Guardamos el detalle
            await client.query(`
                INSERT INTO compras_detalle (id_transaccion, id_producto, cantidad, costo_unitario, total)
                VALUES ($1, $2, $3, $4, $5)
            `, [id_transaccion, prod.id_producto, prod.cantidad, prod.costo_compra, prod.subtotal]);

            // B. Traemos stock y costo actual para hacer la matemática
            const prodData = await client.query('SELECT stock_warehouse, unit_cost FROM productos_almacen WHERE id = $1', [prod.id_producto]);
            const stockActual = parseInt(prodData.rows[0].stock_warehouse) || 0;
            const costoActual = parseFloat(prodData.rows[0].unit_cost) || 0;
            const cantidadComprada = parseInt(prod.cantidad) || 0;
            const costoCompra = parseFloat(prod.costo_compra) || 0;

            const nuevoStock = stockActual + cantidadComprada;
            let nuevoCostoPromedio = costoActual;

            // C. La Magia: Costo Promedio Ponderado
            if (nuevoStock > 0) {
                const valorInventarioActual = stockActual * costoActual;
                const valorNuevoLote = cantidadComprada * costoCompra;
                nuevoCostoPromedio = (valorInventarioActual + valorNuevoLote) / nuevoStock;
            }

            // D. Actualizamos almacén con stock sumado y precio promediado
            await client.query(`
                UPDATE productos_almacen 
                SET stock_warehouse = $1, unit_cost = $2
                WHERE id = $3
            `, [nuevoStock, nuevoCostoPromedio.toFixed(2), prod.id_producto]);
        }

        await client.query('COMMIT');
        res.json({ success: true, message: 'Compra registrada, stock sumado y costo promediado' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error registrando la compra:', error);
        res.status(500).json({ success: false, message: 'Error interno al procesar la compra' });
    } finally {
        client.release();
    }
};

// 2. OBTENER LISTA DE GASTOS (Tu código original con candado intacto)
const getExpenses = async (req, res) => {
    try {
        const user_id = req.query.user_id || req.query.user || req.query.email;
        let userRol = 'dueno';
        
        if (user_id) {
            const userRes = await pool.query('SELECT rol FROM usuarios_duenos WHERE email = $1', [user_id]);
            if (userRes.rows.length > 0) {
                userRol = userRes.rows[0].rol;
            }
        }

        let query = `
            SELECT t.id, t.concepto, t.proveedor, t.metodo_pago, t.total, t.fecha 
            FROM transacciones_gastos t
            LEFT JOIN usuarios_duenos u ON t.id_dueno::text = u.id::text
        `;
        let values = [];

        if (userRol === 'superadmin') {
            // Ve todo
        } else if (user_id) {
            query += ` WHERE u.email::text = $1 OR t.id_dueno::text = $1`;
            values.push(String(user_id));
        } else {
            query += ` WHERE 1 = 0`; 
        }

        query += ` ORDER BY t.fecha DESC;`;
        
        const result = await pool.query(query, values);
        res.json({ success: true, gastos: result.rows, data: result.rows });
        
    } catch (error) {
        console.error('Error al obtener gastos:', error);
        res.status(500).json({ success: false, message: 'Error en BD' });
    }
};

// 3. NUEVO: OBTENER DETALLE DEL GASTO (Para el modal de visualización)
const getExpenseDetails = async (req, res) => {
    try {
        const { id } = req.params;
        const query = `
            SELECT cd.id, cd.cantidad, cd.costo_unitario, cd.total as subtotal, pa.name as nombre_producto
            FROM compras_detalle cd
            LEFT JOIN productos_almacen pa ON cd.id_producto = pa.id
            WHERE cd.id_transaccion = $1;
        `;
        const result = await pool.query(query, [id]);
        res.json({ success: true, detalles: result.rows });
    } catch (error) {
        console.error('Error al obtener detalles:', error);
        res.status(500).json({ success: false, message: 'Error en BD' });
    }
};

// 4. NUEVO: ELIMINAR GASTO Y DEVOLVER STOCK (La reversión que pediste)
const deleteExpense = async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        await client.query('BEGIN');

        // Buscamos qué se compró para restarlo
        const detalles = await client.query('SELECT id_producto, cantidad FROM compras_detalle WHERE id_transaccion = $1', [id]);

        // Restamos el stock (evitando negativos)
        for (let det of detalles.rows) {
            await client.query(`
                UPDATE productos_almacen 
                SET stock_warehouse = GREATEST(stock_warehouse - $1, 0) 
                WHERE id = $2
            `, [det.cantidad, det.id_producto]);
        }

        // Eliminamos el rastro
        await client.query('DELETE FROM compras_detalle WHERE id_transaccion = $1', [id]);
        await client.query('DELETE FROM transacciones_gastos WHERE id = $1', [id]);

        await client.query('COMMIT');
        res.json({ success: true, message: 'Gasto eliminado y stock devuelto a su estado anterior' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error eliminando gasto:', error);
        res.status(500).json({ success: false, message: 'Error al eliminar el gasto' });
    } finally {
        client.release();
    }
};

// 5. NUEVO: EDITAR GASTO
const updateExpense = async (req, res) => {
    try {
        const { id } = req.params;
        const { concepto, proveedor } = req.body;
        
        await pool.query(`
            UPDATE transacciones_gastos SET concepto = $1, proveedor = $2 WHERE id = $3
        `, [concepto, proveedor, id]);
        
        res.json({ success: true, message: 'Datos actualizados' });
    } catch (error) {
        console.error('Error editando gasto:', error);
        res.status(500).json({ success: false, message: 'Error al editar' });
    }
};

module.exports = {
    registerPurchase,
    getExpenses,
    getExpenseDetails,
    deleteExpense,
    updateExpense
};