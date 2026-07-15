// controllers/inventoryController.js
const pool = require('../config/database');
const mqttService = require('../services/mqttService');

// 1. DEFINE LA FUNCIÓN AQUÍ
const obtenerInventario = async (req, res) => {
    const { machine_id } = req.params;
    try {
        // Al usar SELECT *, automáticamente enviará la nueva columna 'capacidad' a React
        const result = await pool.query('SELECT * FROM inventario WHERE machine_id = $1', [machine_id]);
        res.json({ success: true, inventario: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error al obtener inventario' });
    }
};

const actualizarInventario = async (req, res) => {
    try {
        // MODIFICACIÓN 1: Extraemos 'capacidad' del cuerpo de la petición
        const { machine_id, codigo_motor, nombre_producto, precio, stock, capacidad } = req.body;

        // MEJORA 1: Aseguramos que el precio tenga 2 decimales (Ej: 2.5 -> "2.50")
        const precioFormateado = parseFloat(precio).toFixed(2);
        
        // Aseguramos que si no envían capacidad (por algún motivo), por defecto sea 10
        const capacidadFinal = capacidad ? parseInt(capacidad) : 10;

        const motorExiste = await pool.query(
            'SELECT * FROM inventario WHERE machine_id = $1 AND codigo_motor = $2',
            [machine_id, codigo_motor]
        );

        if (motorExiste.rows.length === 0) {
            // MODIFICACIÓN 2: Agregamos capacidad al INSERT
            await pool.query(
                'INSERT INTO inventario (machine_id, codigo_motor, nombre_producto, precio, stock, capacidad) VALUES ($1, $2, $3, $4, $5, $6)',
                [machine_id, codigo_motor, nombre_producto, precioFormateado, stock, capacidadFinal]
            );
        } else {
            // MODIFICACIÓN 3: Agregamos capacidad al UPDATE
            await pool.query(
                'UPDATE inventario SET nombre_producto = $1, precio = $2, stock = $3, capacidad = $4 WHERE machine_id = $5 AND codigo_motor = $6',
                [nombre_producto, precioFormateado, stock, capacidadFinal, machine_id, codigo_motor]
            );
        }

        // Enviamos el precio formateado al servicio MQTT
        mqttService.enviarComandoPrecio(machine_id, codigo_motor, precioFormateado);

        res.json({ success: true, message: 'Producto guardado y ESP32 notificada' });
    } catch (error) {
        console.error("Error en DB:", error);
        res.status(500).json({ success: false, message: 'Error guardando inventario' });
    }
};

module.exports = {
    obtenerInventario,
    actualizarInventario 
};