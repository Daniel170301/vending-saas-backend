// controllers/inventoryController.js
const pool = require('../config/database');
const mqttService = require('../services/mqttService');

// 1. OBTENER INVENTARIO
const obtenerInventario = async (req, res) => {
    // ATRAPAMOS LA MAC SIN IMPORTAR CÓMO SE LLAME EN LA RUTA
    const machine_id = req.params.machine_id || req.params.mac || req.params.id; 
    
    console.log("MAC solicitada por React:", machine_id); // Esto nos dirá la verdad en la consola de Node

    if (!machine_id) {
        return res.status(400).json({ success: false, message: 'No se envió la MAC de la máquina' });
    }

    try {
        const result = await pool.query('SELECT * FROM inventario WHERE machine_id = $1', [machine_id]);
        
        console.log(`Se encontraron ${result.rowCount} productos para esta máquina`);

        res.json({ success: true, inventario: result.rows });
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

// 4. NUEVO: ELIMINAR UN RESORTE ESPECÍFICO DEL INVENTARIO
const deleteSpring = async (req, res) => {
    try {
        const { machine_id, codigo_motor } = req.params;

        console.log(`Eliminando resorte M${codigo_motor} de la máquina: ${machine_id}`);

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
            message: `Resorte M${codigo_motor} eliminado correctamente.`
        });

    } catch (error) {
        console.error('Error al eliminar resorte:', error);
        res.status(500).json({ success: false, message: 'Error al eliminar el resorte en el servidor.' });
    }
};

module.exports = {
    obtenerInventario,
    actualizarInventario,
    registrarVenta,
    deleteSpring // <-- Ahora sí la exportamos correctamente
};