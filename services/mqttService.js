// services/mqttService.js
const mqtt = require('mqtt');
const pool = require('../config/database'); // <-- ¡ESTA ES LA LÍNEA QUE FALTA!
// Conectamos al broker
const mqttClient = mqtt.connect('mqtt://broker.hivemq.com');

mqttClient.on('connect', () => {
    console.log('🌐 Servicio MQTT conectado a HiveMQ exitosamente');
    mqttClient.subscribe('jaimez/expendedora/+/eventos', () => {
        console.log('🎧 Escuchando eventos de ventas de las máquinas...');
    });
});

// NUEVO: El "Escuchador" que procesa los mensajes que llegan de la máquina
mqttClient.on('message', async (topic, message) => {
    const mensajeTexto = message.toString();
    console.log(`[MQTT IN] Tópico: ${topic} | Mensaje: ${mensajeTexto}`);

    if (mensajeTexto.startsWith('VENTA:')) {
        const codigoMotor = mensajeTexto.substring(6).trim();
        const partesTopic = topic.split('/');
        const machine_id = partesTopic[2]; 

        try {
            // 1. Primero, obtenemos la información del producto ANTES de actualizar
            const prodRes = await pool.query(
                'SELECT nombre_producto, precio FROM inventario WHERE machine_id = $1 AND codigo_motor = $2',
                [machine_id, codigoMotor]
            );

            if (prodRes.rowCount > 0) {
                const producto = prodRes.rows[0]; // AQUÍ definimos 'producto' correctamente

                // 2. Descontamos el stock
                const updateRes = await pool.query(
                    'UPDATE inventario SET stock = stock - 1 WHERE machine_id = $1 AND codigo_motor = $2 AND stock > 0 RETURNING stock',
                    [machine_id, codigoMotor]
                );

                if (updateRes.rowCount > 0) {
                    console.log(`✅ Stock descontado. Nuevo stock: ${updateRes.rows[0].stock}`);

// Buscamos el nombre del último cliente registrado en esta máquina
                    let nombreCliente = "Desconocido";
                    try {
                        const maqRes = await pool.query(
                            'SELECT ultimo_cliente FROM maquinas WHERE machine_id = $1',
                            [machine_id]
                        );
                        if (maqRes.rowCount > 0 && maqRes.rows[0].ultimo_cliente) {
                            nombreCliente = maqRes.rows[0].ultimo_cliente;
                        }
                    } catch (err) {
                        console.log("⚠️ Error al obtener el último cliente:", err.message);
                    }

                    // Insertamos en el historial con ese nombre
                    await pool.query(
                        'INSERT INTO historial_ventas (machine_id, codigo_motor, nombre_producto, precio, nombre_cliente) VALUES ($1, $2, $3, $4, $5)',
                        [machine_id, codigoMotor, producto.nombre_producto, producto.precio, nombreCliente]
                    );
                    console.log("💾 Venta registrada en historial_ventas con cliente:", nombreCliente);


                    if (global.io) {
                        global.io.emit('actualizacionStock', { maquina: machine_id, mensaje: "Venta registrada" });
                    }
                }
            } else {
                console.log(`⚠️ No se encontró el producto para el motor ${codigoMotor}`);
            }
        } catch (error) {
            console.error("❌ Error grave en MQTT:", error);
        }
    }
});

// Función reutilizable para enviar el cambio de precio
const enviarComandoPrecio = (machine_id, codigo_motor, precio) => {
    const comandoMQTT = `EDITAR:${codigo_motor} ${precio}`;
    const topic = `jaimez/expendedora/${machine_id}/comandos`;
    
    mqttClient.publish(topic, comandoMQTT, () => {
        console.log(`[MQTT] Precio enviado a la máquina ${machine_id} -> ${comandoMQTT}`);
    });
};

// NUEVA FUNCIÓN: Enviar pago dinámico por MAC
const enviarComandoPago = (machine_id, monto) => {
    const comandoMQTT = `PAGO:${monto}`;
    const topic = `jaimez/expendedora/${machine_id}/comandos`;
    
    mqttClient.publish(topic, comandoMQTT, () => {
        console.log(`[MQTT] Pago enviado a la máquina ${machine_id} -> ${comandoMQTT}`);
    });
};

// Función genérica para futuros usos
const publicarMensaje = (topic, mensaje) => {
    mqttClient.publish(topic, mensaje, () => {
        console.log(`[MQTT] Mensaje publicado en ${topic} -> ${mensaje}`);
    });
};

module.exports = {
    enviarComandoPrecio,
    enviarComandoPago, // <-- Exportamos la nueva función
    publicarMensaje
};