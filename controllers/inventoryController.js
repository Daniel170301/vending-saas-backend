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
                i.id,
                i.machine_id,
                i.codigo_motor,
                i.codigo_motor AS slot,
                i.nombre_producto,
                i.nombre_producto AS product_name,
                i.nombre_producto AS name,
                i.precio,
                i.precio AS price,
                i.stock,
                i.capacidad,
                i.capacidad AS capacity,
                pa.image_url,
                pa.unit_cost AS costo_unitario
            FROM inventario i
            LEFT JOIN maquinas m ON i.machine_id = m.machine_id
            LEFT JOIN productos_almacen pa 
                ON i.nombre_producto = pa.name 
                AND m.id_dueno::text = pa.id_dueno::text
            WHERE i.machine_id = $1;
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

// 2. ACTUALIZAR INVENTARIO E HISTORIAL DE ABASTECIMIENTO
const actualizarInventario = async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); // Iniciamos transacción segura

        const { machine_id, codigo_motor, nombre_producto, precio, stock, capacidad, user_email } = req.body;
        const precioFormateado = parseFloat(precio || 0).toFixed(2);
        const capacidadFinal = capacidad ? parseInt(capacidad) : 10;
        const nuevoStockTotal = parseInt(stock) || 0;

        // 1. Buscamos el estado actual del resorte para calcular cuánto estamos agregando
        const motorActual = await client.query(
            'SELECT stock FROM inventario WHERE machine_id = $1 AND codigo_motor = $2',
            [machine_id, codigo_motor]
        );
        
        const cantidadAnterior = motorActual.rows.length > 0 ? parseInt(motorActual.rows[0].stock) : 0;
        const cantidadAgregada = nuevoStockTotal - cantidadAnterior;

        // 2. Guardamos o actualizamos en el inventario principal
        if (motorActual.rows.length === 0) {
            await client.query(
                'INSERT INTO inventario (machine_id, codigo_motor, nombre_producto, precio, stock, capacidad) VALUES ($1, $2, $3, $4, $5, $6)',
                [machine_id, codigo_motor, nombre_producto, precioFormateado, nuevoStockTotal, capacidadFinal]
            );
        } else {
            await client.query(
                'UPDATE inventario SET nombre_producto = $1, precio = $2, stock = $3, capacidad = $4 WHERE machine_id = $5 AND codigo_motor = $6',
                [nombre_producto, precioFormateado, nuevoStockTotal, capacidadFinal, machine_id, codigo_motor]
            );
        }

        // 3. SINCRONIZACIÓN SEGURA: Actualiza precio en otros resortes de esta MAC
        if (nombre_producto && nombre_producto.trim() !== "") {
            await client.query(
                'UPDATE inventario SET precio = $1 WHERE machine_id = $2 AND nombre_producto = $3',
                [precioFormateado, machine_id, nombre_producto]
            );
        }

        // 4. REGISTRAR HISTORIAL (SÓLO SI SE AGREGÓ MERCADERÍA)
        if (cantidadAgregada > 0 && nombre_producto) {
            // Extraer Costo Unitario de la tabla de almacén
            const costoRes = await client.query('SELECT unit_cost FROM productos_almacen WHERE name = $1 LIMIT 1', [nombre_producto]);
            const costoUnitario = costoRes.rows.length > 0 ? parseFloat(costoRes.rows[0].unit_cost) : 0;
            
            // Extraer nombre de la máquina
            const maqRes = await client.query('SELECT name FROM maquinas WHERE machine_id = $1', [machine_id]);
            const nombreMaquina = maqRes.rows.length > 0 ? maqRes.rows[0].name : 'Máquina Desconocida';

            // Insertar en la bitácora
            await client.query(`
                INSERT INTO historial_abastecimiento 
                (machine_id, nombre_maquina, codigo_motor, nombre_producto, cantidad_anterior, cantidad_agregada, cantidad_total, costo_unitario, responsable_email)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            `, [machine_id, nombreMaquina, codigo_motor, nombre_producto, cantidadAnterior, cantidadAgregada, nuevoStockTotal, costoUnitario, user_email || 'Administrador']);
        }

        await client.query('COMMIT'); // Guardamos todo permanentemente

        // 5. Enviamos comando MQTT al ESP32
        mqttService.enviarComandoPrecio(machine_id, codigo_motor, precioFormateado);

        res.json({ success: true, message: 'Producto guardado, historial registrado y precios sincronizados' });

    } catch (error) {
        await client.query('ROLLBACK'); // Si algo falla, deshacemos todo
        console.error("Error en DB al actualizar inventario:", error);
        res.status(500).json({ success: false, message: 'Error guardando inventario e historial' });
    } finally {
        client.release();
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

// 5. NUEVO: QUITAR STOCK Y DEVOLVER AL ALMACÉN (VERSIÓN PARCIAL)
// 5. NUEVO: QUITAR STOCK Y DEVOLVER AL ALMACÉN (VERSIÓN PARCIAL)
const quitarStockYDevolverAlmacen = async (req, res) => {
    const client = await pool.connect();
    try {
        // Ahora recibimos la cantidad específica que Lovable nos manda
        const { machine_id, codigo_motor, cantidad_a_quitar } = req.body;
        
        await client.query('BEGIN'); // Iniciamos la transacción

        // 1. Buscamos qué producto había en ese motor y cuánto stock total tiene
        const invRes = await client.query(
            'SELECT nombre_producto, stock FROM inventario WHERE machine_id = $1 AND codigo_motor = $2',
            [machine_id, codigo_motor]
        );

        if (invRes.rows.length > 0) {
            const { nombre_producto, stock } = invRes.rows[0];
            
            // Si Lovable no manda cantidad, asumimos que quiere quitar todo el stock
            const cantidadAQuitar = cantidad_a_quitar ? parseInt(cantidad_a_quitar) : stock;

            // 2. Solo hacemos el proceso si la cantidad es válida
            if (cantidadAQuitar > 0 && cantidadAQuitar <= stock && nombre_producto) {
                
                // A. Devolvemos la cantidad exacta al almacén general
                await client.query(
                    'UPDATE productos_almacen SET stock_warehouse = stock_warehouse + $1 WHERE name = $2',
                    [cantidadAQuitar, nombre_producto]
                );

                // B. Verificamos si se vació el motor por completo o si queda algo
                if (cantidadAQuitar === stock) {
                    // Se quitó todo, vaciamos el motor completamente
                    await client.query(
                        "UPDATE inventario SET stock = 0, nombre_producto = NULL, precio = 0 WHERE machine_id = $1 AND codigo_motor = $2",
                        [machine_id, codigo_motor]
                    );
                } else {
                    // Solo se quitó una parte, así que restamos el stock pero mantenemos el producto
                    await client.query(
                        "UPDATE inventario SET stock = stock - $1 WHERE machine_id = $2 AND codigo_motor = $3",
                        [cantidadAQuitar, machine_id, codigo_motor]
                    );
                }
            }
        }

        await client.query('COMMIT'); // Guardamos los cambios
        res.json({ success: true, message: 'Stock actualizado y devuelto al almacén.' });

    } catch (error) {
        await client.query('ROLLBACK'); // Si hay error, deshacemos todo
        console.error("Error devolviendo stock:", error);
        res.status(500).json({ success: false, message: 'Error interno del servidor.' });
    } finally {
        client.release(); // Liberamos la conexión
    }
};
// 6. OBTENER HISTORIAL DE ABASTECIMIENTO POR MÁQUINA
const obtenerHistorialAbastecimiento = async (req, res) => {
    try {
        const { machine_id } = req.params;
        const query = `
            SELECT * FROM historial_abastecimiento 
            WHERE machine_id = $1 
            ORDER BY fecha DESC
        `;
        const result = await pool.query(query, [machine_id]);
        
        res.json({ success: true, historial: result.rows });
    } catch (error) {
        console.error('Error al obtener historial:', error);
        res.status(500).json({ success: false, message: 'Error en el servidor al cargar historial' });
    }
};

// 7. ELIMINAR HISTORIAL, REVERTIR STOCK Y DEVOLVER AL ALMACÉN
const eliminarHistorialAbastecimiento = async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); // Iniciamos transacción segura
        const { id } = req.params;

        // 1. Obtener los detalles del abastecimiento antes de borrarlo
        const histRes = await client.query('SELECT * FROM historial_abastecimiento WHERE id = $1', [id]);
        
        if (histRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Registro no encontrado' });
        }

        const registro = histRes.rows[0];

        // 2. Revertir el stock en la máquina (restar la cantidad agregada)
        await client.query(`
            UPDATE inventario 
            SET stock = GREATEST(stock - $1, 0)
            WHERE machine_id = $2 AND codigo_motor = $3
        `, [registro.cantidad_agregada, registro.machine_id, registro.codigo_motor]);

        // 3. NUEVO: Devolver esa misma cantidad al Almacén General
        if (registro.nombre_producto) {
            await client.query(`
                UPDATE productos_almacen 
                SET stock_warehouse = stock_warehouse + $1
                WHERE name = $2
            `, [registro.cantidad_agregada, registro.nombre_producto]);
        }

        // 4. Eliminar el registro de la bitácora
        await client.query('DELETE FROM historial_abastecimiento WHERE id = $1', [id]);

        await client.query('COMMIT'); // Guardamos los cambios
        res.json({ success: true, message: 'Abastecimiento revertido y productos devueltos al almacén' });

    } catch (error) {
        await client.query('ROLLBACK'); // Deshacemos todo si hay error
        console.error("Error al revertir historial:", error);
        res.status(500).json({ success: false, message: 'Error interno al revertir el abastecimiento' });
    } finally {
        client.release();
    }
};
module.exports = {
    obtenerInventario,
    actualizarInventario,
    registrarVenta,
    deleteSpring,
    quitarStockYDevolverAlmacen,
    obtenerHistorialAbastecimiento,
    eliminarHistorialAbastecimiento
};