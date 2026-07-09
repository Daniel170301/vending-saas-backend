// controllers/salesController.js
const pool = require('../config/database');

const confirmarDespacho = async (req, res) => {
    const { machine_id } = req.params;
    const { codigo_motor } = req.body;

    try {
        // 1. Reseteamos el estado de venta de la máquina[cite: 6]
        await pool.query('UPDATE maquinas SET dispense_pending = false WHERE machine_id = $1', [machine_id]);

        if (codigo_motor) {
            // 2. Obtenemos los datos del producto ANTES de restar el stock
            const prodRes = await pool.query(
                'SELECT nombre_producto, precio, stock FROM inventario WHERE machine_id = $1 AND codigo_motor = $2',
                [machine_id, codigo_motor]
            );

            if (prodRes.rows.length > 0) {
                const producto = prodRes.rows[0];
                const nuevoStock = producto.stock - 1;

                // 3. Restamos 1 al stock[cite: 6]
                await pool.query(
                    'UPDATE inventario SET stock = $1 WHERE machine_id = $2 AND codigo_motor = $3',
                    [nuevoStock, machine_id, codigo_motor]
                );

                // 4. Registramos la venta en el nuevo historial
                await pool.query(
                    'INSERT INTO historial_ventas (machine_id, codigo_motor, nombre_producto, precio) VALUES ($1, $2, $3, $4)',
                    [machine_id, codigo_motor, producto.nombre_producto, producto.precio]
                );

                // 5. SISTEMA DE ALARMAS
                if (nuevoStock <= 3) {
                    const nivelAlerta = nuevoStock === 0 ? '🔴 AGOTADO' : '🟡 STOCK BAJO';
                    const mensajeAlerta = `[ALERTA ${nivelAlerta}] Máquina ${machine_id}: El producto ${producto.nombre_producto} (Motor ${codigo_motor}) tiene ${nuevoStock} unidades.`;
                    
                    console.log(mensajeAlerta);
                    // Aquí más adelante conectaremos un servicio como Nodemailer para enviarte un correo o un mensaje a Telegram.
                }
            }
        }
        
        res.json({ success: true, message: "Venta confirmada, stock actualizado y registrada en el historial" });

    } catch (error) {
        console.error("Error confirmando despacho:", error);
        res.status(500).json({ success: false, message: 'Error interno en la confirmación' });
    }
};

module.exports = {
    confirmarDespacho
};