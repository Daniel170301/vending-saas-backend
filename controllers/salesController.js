// controllers/salesController.js
const pool = require('../config/database');

const confirmarDespacho = async (req, res) => {
    const { machine_id } = req.params;
    const { codigo_motor } = req.body;
    try {
        if (codigo_motor) {
            // 1. Obtenemos el producto y leemos quién fue el último cliente
            const prodRes = await pool.query('SELECT nombre_producto, precio, stock FROM inventario WHERE machine_id = $1 AND codigo_motor = $2', [machine_id, codigo_motor]);
            const maqRes = await pool.query('SELECT ultimo_cliente FROM maquinas WHERE machine_id = $1', [machine_id]);
            
            if (prodRes.rows.length > 0) {
                const producto = prodRes.rows[0];
                const cliente = (maqRes.rows.length > 0 && maqRes.rows[0].ultimo_cliente) ? maqRes.rows[0].ultimo_cliente : 'Desconocido';
                const nuevoStock = producto.stock - 1;
                
                // 2. Restamos 1 al stock
                await pool.query('UPDATE inventario SET stock = $1 WHERE machine_id = $2 AND codigo_motor = $3', [nuevoStock, machine_id, codigo_motor]);
                
                // 3. Registramos la venta en el nuevo historial
                await pool.query(
                    'INSERT INTO historial_ventas (machine_id, codigo_motor, nombre_producto, precio, nombre_cliente) VALUES ($1, $2, $3, $4, $5)',
                    [machine_id, codigo_motor, producto.nombre_producto, producto.precio, cliente]
                );
                
                // 4. LIMPIEZA
                await pool.query('UPDATE maquinas SET ultimo_cliente = NULL WHERE machine_id = $1', [machine_id]);
                
                // 5. SISTEMA DE ALARMAS
                if (nuevoStock <= 3) {
                    const nivelAlerta = nuevoStock === 0 ? '🔴 AGOTADO' : '🟡 STOCK BAJO';
                    console.log(`[ALERTA ${nivelAlerta}] Máquina ${machine_id}: El producto ${producto.nombre_producto} (Motor ${codigo_motor}) tiene ${nuevoStock} unidades.`);
                }
            }
        }
        res.json({ success: true, message: "Venta confirmada, stock actualizado y registrada en el historial" });
    } catch (error) {
        console.error("Error confirmando despacho:", error);
        res.status(500).json({ success: false, message: 'Error interno en la confirmación' });
    }
};

// =========================================================================
// OBTENER HISTORIAL (ACTUALIZADO CON MODO DIOS)
// =========================================================================
const obtenerHistorialVentas = async (req, res) => {
    try {
        const machine_id = req.params.machine_id || req.params.machineId || req.params.id || req.query.machine_id;
        const user_id = req.query.user_id || req.query.user || req.query.email;

        let query = '';
        let values = [];

        if (machine_id) {
            query = `
                SELECT v.*, 
                       m.name AS nombre_maquina, 
                       COALESCE(p.unit_cost, 0) AS unit_cost, 
                       COALESCE(p.unit_cost, 0) AS costo
                FROM historial_ventas v
                LEFT JOIN maquinas m ON v.machine_id = m.machine_id 
                LEFT JOIN productos_almacen p ON v.nombre_producto = p.name
                WHERE v.machine_id = $1
                ORDER BY v.fecha DESC
            `;
            values.push(machine_id);
            console.log(`Buscando ventas para la máquina MAC: ${machine_id}`);
        } else if (user_id) {
            
            // 1. Averiguar el rol del usuario que está consultando
            const userRes = await pool.query('SELECT rol FROM usuarios_duenos WHERE email = $1', [user_id]);
            const userRol = userRes.rows.length > 0 ? userRes.rows[0].rol : 'dueno';

            if (userRol === 'superadmin') {
                // MODO DIOS: Traer todas las ventas de todo el sistema
                query = `
                    SELECT v.*, 
                           m.name AS nombre_maquina, 
                           u.email AS owner_email,
                           COALESCE(p.unit_cost, 0) AS unit_cost, 
                           COALESCE(p.unit_cost, 0) AS costo
                    FROM historial_ventas v
                    LEFT JOIN maquinas m ON v.machine_id = m.machine_id
                    LEFT JOIN usuarios_duenos u ON m.id_dueno::text = u.id::text
                    LEFT JOIN productos_almacen p ON v.nombre_producto = p.name
                    ORDER BY v.fecha DESC
                `;
                console.log(`[MODO DIOS] Buscando ventas globales para superadmin: ${user_id}`);
            } else {
                // MODO CLIENTE: Solo las suyas
                query = `
                    SELECT v.*, 
                           m.name AS nombre_maquina, 
                           COALESCE(p.unit_cost, 0) AS unit_cost, 
                           COALESCE(p.unit_cost, 0) AS costo
                    FROM historial_ventas v
                    JOIN maquinas m ON v.machine_id = m.machine_id
                    JOIN usuarios_duenos u ON m.id_dueno::text = u.id::text
                    LEFT JOIN productos_almacen p ON v.nombre_producto = p.name
                    WHERE u.email = $1
                    ORDER BY v.fecha DESC
                `;
                values.push(user_id);
                console.log(`Buscando ventas globales para el usuario: ${user_id}`);
            }
        } else {
            // Consulta base por defecto si no mandan ni maquina ni usuario
            query = `
                SELECT v.*, 
                       COALESCE(p.unit_cost, 0) AS unit_cost, 
                       COALESCE(p.unit_cost, 0) AS costo
                FROM historial_ventas v
                LEFT JOIN productos_almacen p ON v.nombre_producto = p.name
                ORDER BY v.fecha DESC
            `;
        }

        const result = await pool.query(query, values);
        res.json(result.rows);
    } catch (error) {
        console.error('Error al obtener el historial de ventas:', error);
        res.status(500).json({ success: false, message: 'Error en el servidor' });
    }
};

module.exports = {
    confirmarDespacho,
    obtenerHistorialVentas
};