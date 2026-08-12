// controllers/inventoryController.js
const pool = require('../config/database');
const mqttService = require('../services/mqttService');

// 1. OBTENER INVENTARIO
// 1. OBTENER INVENTARIO
// 1. OBTENER INVENTARIO
const obtenerInventario = async (req, res) => {
    // Capturamos cualquier variante de parámetro que use tu archivo de rutas
    const machine_id = req.params.machine_id || req.params.machineId || req.params.id || req.params.mac || Object.values(req.params)[0] || req.query.machine_id; 
    
    console.log("MAC / ID solicitada por React:", machine_id);
    console.log("Parámetros completos recibidos en la ruta:", req.params);

    if (!machine_id) {
        return res.status(400).json({ success: false, message: 'No se envió la MAC de la máquina' });
    }

    try {
        const query = `
            SELECT 
                id,
                machine_id,
                codigo_motor,
                codigo_motor AS slot,
                nombre_producto,
                nombre_producto AS product_name,
                nombre_producto AS name,
                precio,
                precio AS price,
                stock,
                capacidad,
                capacidad AS capacity
            FROM inventario 
            WHERE machine_id = $1;
        `;

        const result = await pool.query(query, [machine_id]);
        
        console.log(`Se encontraron ${result.rowCount} productos para esta máquina`);

        // Devolvemos el ARRAY DIRECTO que espera el frontend de Lovable
        res.json(result.rows);
    } catch (error) {
        console.error("Error obteniendo inventario:", error);
        res.status(500).json({ success: false, message: 'Error al obtener inventario' });
    }
};

// 2. ACTUALIZAR INVENTARIO (O CREAR RESORTE NUEVO)
const actualizarInventario = async (req, res) => {
    try {
        const { machine_id, codigo_motor, nombre_producto, precio, stock, capacidad } = req.body;
        const precioFormateado = parseFloat(precio).toFixed(2);
        const capacidadFinal = capacidad ? parseInt(capacidad) : 10;

        // 1. Guardamos o actualizamos el resorte específico
        const motorExiste = await pool.query(
            'SELECT * FROM inventario WHERE machine_id = $1 AND codigo_motor = $2',
            [machine_id, codigo_motor]
        );

        if (motorExiste.rows.length === 0) {
            await pool.query(
                'INSERT INTO inventario (machine_id, codigo_motor, nombre_producto, precio, stock, capacidad) VALUES ($1, $2, $3, $4, $5, $6)',
                [machine_id, codigo_motor, nombre_producto, precioFormateado, stock, capacidadFinal]
            );
        } else {
            await pool.query(
                'UPDATE inventario SET nombre_producto = $1, precio = $2, stock = $3, capacidad = $4 WHERE machine_id = $5 AND codigo_motor = $6',
                [nombre_producto, precioFormateado, stock, capacidadFinal, machine_id, codigo_motor]
            );
        }

        // 2. SINCRONIZACIÓN SEGURA: Actualiza el precio en otros resortes, pero SÓLO DENTRO DE ESTA MAC
        if (nombre_producto && nombre_producto.trim() !== "") {
            await pool.query(
                'UPDATE inventario SET precio = $1 WHERE machine_id = $2 AND nombre_producto = $3',
                [precioFormateado, machine_id, nombre_producto]
            );
        }

        // 3. Enviamos el precio formateado al servicio MQTT
        mqttService.enviarComandoPrecio(machine_id, codigo_motor, precioFormateado);

        // MUY IMPORTANTE: Mandamos los datos actualizados para que React los pueda leer y renderizar
        res.json({ success: true, message: 'Producto guardado y precios sincronizados en esta máquina' });
    } catch (error) {
        console.error("Error en DB:", error);
        res.status(500).json({ success: false, message: 'Error guardando inventario' });
    }
};

// 3. REGISTRAR VENTA
const registrarVenta = async (req, res) => {
    try {
        const { machine_id, codigo_motor } = req.body;

        // Le pedimos a PostgreSQL que reste 1 al stock actual, SOLO si hay stock mayor a 0
        const query = `
            UPDATE inventario 
            SET stock = stock - 1 
            WHERE machine_id = $1 AND codigo_motor = $2 AND stock > 0
            RETURNING *;
        `;
        
        const result = await pool.query(query, [machine_id, codigo_motor]);

        // Si rowCount es 0, significa que el resorte estaba vacío o el código no existe
        if (result.rowCount === 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'No hay stock disponible o el motor no existe' 
            });
        }

        // Aquí más adelante podremos agregar el aviso por MQTT al ESP32 para que gire el motor
        // mqttService.enviarComandoGiro(machine_id, codigo_motor);

        res.json({ 
            success: true, 
            message: 'Venta exitosa, stock reducido en 1',
            nuevo_stock: result.rows[0].stock
        });

    } catch (error) {
        console.error("Error al registrar la venta:", error);
        res.status(500).json({ success: false, message: 'Error interno del servidor' });
    }
};

// 4. NUEVO: ELIMINAR UN RESORTE ESPECIFICO DEL INVENTARIO
const deleteSpring = async (req, res) => {
    try {
        const { machine_id, codigo_motor } = req.params;
        console.log(`Eliminando resorte #${codigo_motor} de la máquina: ${machine_id}`);
        const deleteQuery = `
            DELETE FROM inventario
            WHERE machine_id = $1 AND codigo_motor = $2
            RETURNING *;
        `;
        const result = await pool.query(deleteQuery, [machine_id, codigo_motor]);
        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'El resorte no existía en la base de datos.' });
        }
        res.json({
            success: true,
            message: `Resorte #${codigo_motor} eliminado correctamente.`
        });
    } catch (error) {
        console.error('Error al eliminar resorte:', error);
        res.status(500).json({ success: false, message: 'Error al eliminar el resorte en el servidor.' });
    }
};

// 5. NUEVO: QUITAR STOCK Y DEVOLVER AL ALMACÉN
const quitarStockYDevolverAlmacen = async (req, res) => {
    const client = await pool.connect();
    try {
        const { machine_id, codigo_motor } = req.body;
        
        await client.query('BEGIN'); // Iniciamos la transacción

        // 1. Buscamos qué producto había en ese motor y cuánto stock tenía
        const invRes = await client.query(
            'SELECT nombre_producto, stock FROM inventario WHERE machine_id = $1 AND codigo_motor = $2',
            [machine_id, codigo_motor]
        );

        if (invRes.rows.length > 0) {
            const { nombre_producto, stock } = invRes.rows[0];

            // 2. Si había stock, lo devolvemos sumándolo al almacén general
            if (stock > 0 && nombre_producto) {
                await client.query(
                    'UPDATE productos_almacen SET stock_warehouse = stock_warehouse + $1 WHERE name = $2',
                    [stock, nombre_producto]
                );
            }

            // 3. Vaciamos el motor en la máquina
            await client.query(
                "UPDATE inventario SET stock = 0, nombre_producto = NULL, precio = 0 WHERE machine_id = $1 AND codigo_motor = $2",
                [machine_id, codigo_motor]
            );
        }

        await client.query('COMMIT'); // Guardamos los cambios
        res.json({ success: true, message: 'Stock devuelto al almacén y motor vaciado.' });

    } catch (error) {
        await client.query('ROLLBACK'); // Si hay error, deshacemos todo para no perder inventario
        console.error("Error devolviendo stock:", error);
        res.status(500).json({ success: false, message: 'Error interno del servidor.' });
    } finally {
        client.release(); // Liberamos la conexión
    }
};
module.exports = {
    obtenerInventario,
    actualizarInventario,
    registrarVenta,
    deleteSpring,
    quitarStockYDevolverAlmacen// <-- Ahora sí la exportamos correctamente
};