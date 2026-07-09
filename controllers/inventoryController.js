// controllers/inventoryController.js
const pool = require('../config/database');
const mqttService = require('../services/mqttService');

const actualizarInventario = async (req, res) => {
    try {
        const { machine_id, codigo_motor, nombre_producto, precio, stock } = req.body;

        const motorExiste = await pool.query(
            'SELECT * FROM inventario WHERE machine_id = $1 AND codigo_motor = $2',
            [machine_id, codigo_motor]
        );

        if (motorExiste.rows.length === 0) {
            await pool.query(
                'INSERT INTO inventario (machine_id, codigo_motor, nombre_producto, precio, stock) VALUES ($1, $2, $3, $4, $5)',
                [machine_id, codigo_motor, nombre_producto, precio, stock]
            );
        } else {
            await pool.query(
                'UPDATE inventario SET nombre_producto = $1, precio = $2, stock = $3 WHERE machine_id = $4 AND codigo_motor = $5',
                [nombre_producto, precio, stock, machine_id, codigo_motor]
            );
        }

        // Usamos nuestro nuevo servicio para notificar a la ESP32
        mqttService.enviarComandoPrecio(machine_id, codigo_motor, precio);

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