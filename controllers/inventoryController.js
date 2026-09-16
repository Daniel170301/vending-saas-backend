// controllers/inventoryController.js
const pool = require('../config/database');
const mqttService = require('../services/mqttService');

// 1. OBTENER INVENTARIO
const obtenerInventario = async (req, res) => {
    const machine_id = req.params.machine_id || req.params.machineId || req.params.id || req.params.mac || Object.values(req.params)[0] || req.query.machine_id; 
    
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
                i.cola_productos,  
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
        res.json(result.rows);
    } catch (error) {
        console.error("Error obteniendo inventario:", error);
        res.status(500).json({ success: false, message: 'Error al obtener inventario' });
    }
};
// 2. ACTUALIZAR INVENTARIO E HISTORIAL DE ABASTECIMIENTO (Híbrido)
const actualizarInventario = async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); // Iniciamos transacción segura

        // Capturamos la nueva variable "cola_productos" (el arreglo mixto)
        const { machine_id, codigo_motor, nombre_producto, precio, stock, capacidad, user_email, nombre_operario, cola_productos } = req.body;
        
        const capacidadFinal = capacidad ? parseInt(capacidad) : 10;
        
        // VARIABLES DINÁMICAS (Dependen de si es Único o Mixto)
        let nombreFinal = nombre_producto;
        let precioFinal = parseFloat(precio || 0).toFixed(2);
        let nuevoStockTotal = parseInt(stock) || 0;
        let colaJson = '[]';

        // LÓGICA MODO MIXTO: Si Lovable envía una cola de productos
        if (cola_productos && Array.isArray(cola_productos) && cola_productos.length > 0) {
            colaJson = JSON.stringify(cola_productos);
            // El producto principal que se muestra es el primero de la cola
            nombreFinal = cola_productos[0].nombre;
            precioFinal = parseFloat(cola_productos[0].precio || 0).toFixed(2);
            // El stock total es la suma de todos los productos en la cola
            nuevoStockTotal = cola_productos.reduce((acc, item) => acc + (parseInt(item.stock) || 0), 0);
        }

        // 1. Buscamos el estado actual del resorte
        const motorActual = await client.query(
            'SELECT stock FROM inventario WHERE machine_id = $1 AND codigo_motor = $2',
            [machine_id, codigo_motor]
        );
        
        const cantidadAnterior = motorActual.rows.length > 0 ? parseInt(motorActual.rows[0].stock) : 0;
        const cantidadAgregada = nuevoStockTotal - cantidadAnterior;

        // 2. Guardamos o actualizamos (AHORA INCLUYENDO LA COLUMNA cola_productos)
        if (motorActual.rows.length === 0) {
            await client.query(
                'INSERT INTO inventario (machine_id, codigo_motor, nombre_producto, precio, stock, capacidad, cola_productos) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [machine_id, codigo_motor, nombreFinal, precioFinal, nuevoStockTotal, capacidadFinal, colaJson]
            );
        } else {
            await client.query(
                'UPDATE inventario SET nombre_producto = $1, precio = $2, stock = $3, capacidad = $4, cola_productos = $5 WHERE machine_id = $6 AND codigo_motor = $7',
                [nombreFinal, precioFinal, nuevoStockTotal, capacidadFinal, colaJson, machine_id, codigo_motor]
            );
        }

        // 3. SINCRONIZACIÓN SEGURA DE PRECIOS (Solo si es abastecimiento único)
        if (nombreFinal && nombreFinal.trim() !== "" && colaJson === '[]') {
            await client.query(
                'UPDATE inventario SET precio = $1 WHERE machine_id = $2 AND nombre_producto = $3',
                [precioFinal, machine_id, nombreFinal]
            );
        }

        // 4. REGISTRAR HISTORIAL (SÓLO SI SE AGREGÓ MERCADERÍA)
        if (cantidadAgregada > 0 && nombreFinal) {
            const costoRes = await client.query('SELECT unit_cost FROM productos_almacen WHERE name = $1 LIMIT 1', [nombreFinal]);
            const costoUnitario = costoRes.rows.length > 0 ? parseFloat(costoRes.rows[0].unit_cost) : 0;
            
            const maqRes = await client.query('SELECT name FROM maquinas WHERE machine_id = $1', [machine_id]);
            const nombreMaquina = maqRes.rows.length > 0 ? maqRes.rows[0].name : 'Máquina Desconocida';

            await client.query(`
                INSERT INTO historial_abastecimiento 
                (machine_id, nombre_maquina, codigo_motor, nombre_producto, cantidad_anterior, cantidad_agregada, cantidad_total, costo_unitario, responsable_email, nombre_operario)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `, [
                machine_id, nombreMaquina, codigo_motor, nombreFinal, cantidadAnterior, 
                cantidadAgregada, nuevoStockTotal, costoUnitario, 
                user_email || 'Administrador', nombre_operario || 'No especificado'
            ]);
        }

        await client.query('COMMIT');

        // 5. Enviamos comando MQTT al ESP32
        mqttService.enviarComandoPrecio(machine_id, codigo_motor, precioFinal);

        res.json({ success: true, message: 'Producto guardado, historial registrado y precios sincronizados' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error en DB al actualizar inventario:", error);
        res.status(500).json({ success: false, message: 'Error guardando inventario e historial' });
    } finally {
        client.release();
    }
};
// 3. REGISTRAR VENTA (Versión Híbrida y Segura)
const registrarVenta = async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { machine_id, codigo_motor } = req.body;

        // 1. Buscamos el motor bloqueando la fila (FOR UPDATE) para evitar fallos si compran 2 a la vez
        const invRes = await client.query(
            'SELECT * FROM inventario WHERE machine_id = $1 AND codigo_motor = $2 FOR UPDATE',
            [machine_id, codigo_motor]
        );

        if (invRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'No hay stock disponible o el motor no existe' });
        }

        let motor = invRes.rows[0];
        let nuevoStockFinal = 0;

        // 2. LÓGICA MODO MIXTO (Solo se activa si existe la columna y tiene datos)
        if (motor.cola_productos && motor.cola_productos.length > 0) {
            let colaProductos = motor.cola_productos;
            colaProductos[0].stock -= 1;
            nuevoStockFinal = colaProductos[0].stock;

            if (colaProductos[0].stock <= 0) {
                colaProductos.shift(); // Saca el producto sin stock de la cola
            }

            await client.query(
                'UPDATE inventario SET cola_productos = $1 WHERE machine_id = $2 AND codigo_motor = $3',
                [JSON.stringify(colaProductos), machine_id, codigo_motor]
            );
        } 
        // 3. LÓGICA NORMAL (Exactamente tu código original)
        else if (motor.stock > 0) {
            const updateRes = await client.query(`
                UPDATE inventario 
                SET stock = stock - 1 
                WHERE machine_id = $1 AND codigo_motor = $2 AND stock > 0
                RETURNING stock;
            `, [machine_id, codigo_motor]);
            
            nuevoStockFinal = updateRes.rows[0].stock;
        } 
        else {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'No hay stock disponible' });
        }

        await client.query('COMMIT');

        // Aquí más adelante podremos agregar el aviso por MQTT al ESP32 para que gire el motor
        // mqttService.enviarComandoGiro(machine_id, codigo_motor);

        res.json({ 
            success: true, 
            message: 'Venta exitosa, stock reducido en 1',
            nuevo_stock: nuevoStockFinal // Lovable seguirá recibiendo la variable que espera
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error al registrar la venta:", error);
        res.status(500).json({ success: false, message: 'Error interno del servidor' });
    } finally {
        client.release();
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