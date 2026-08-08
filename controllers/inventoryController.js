// services/mqttService.js
const mqtt = require('mqtt');
const pool = require('../config/database');

// Conectamos al broker
const mqttClient = mqtt.connect('mqtt://broker.hivemq.com');

mqttClient.on('connect', () => {
    console.log(' Servicio MQTT conectado a HiveMQ exitosamente');
    mqttClient.subscribe('jaimez/expendedora/+/eventos', () => {
        console.log(' Escuchando eventos de ventas de las máquinas...');
    });
});

// El "Escuchador" que procesa los mensajes que llegan de la máquina
mqttClient.on('message', async (topic, message) => {
    const mensajeTexto = message.toString();
    console.log(`[MQTT IN] Tópico: ${topic} | Mensaje: ${mensajeTexto}`);
    
    if (mensajeTexto.startsWith('VENTA:')) {
        const codigoMotor = mensajeTexto.substring(6).trim();
        const partesTopic = topic.split('/');
        const machine_id = partesTopic[2];
        
        try {
            // 1. Primero, obtenemos la información del producto
            const prodRes = await pool.query(
                'SELECT nombre_producto, precio FROM inventario WHERE machine_id = $1 AND codigo_motor = $2',
                [machine_id, codigoMotor]
            );
            
            if (prodRes.rowCount > 0) {
                const producto = prodRes.rows[0];
                
                // 2. Descontamos el stock
                const updateRes = await pool.query(
                    'UPDATE inventario SET stock = stock - 1 WHERE machine_id = $1 AND codigo_motor = $2 AND stock > 0 RETURNING stock',
                    [machine_id, codigoMotor]
                );
                
                if (updateRes.rowCount > 0) {
                    console.log(` Stock descontado. Nuevo stock: ${updateRes.rows[0].stock}`);
                    
                    // 2.5 Buscamos al último cliente de Yape para esta máquina
                    let nombreCliente = "-";
                    try {
                        const yapeRes = await pool.query(
                            'SELECT cliente FROM pagos_yape WHERE machine_id = $1 ORDER BY id DESC LIMIT 1',
                            [machine_id]
                        );
                        if (yapeRes.rowCount > 0) {
                            nombreCliente = yapeRes.rows[0].cliente;
                        }
                    } catch (err) {
                        console.log(" No se pudo obtener el nombre del cliente de Yape:", err.message);
                    }

                    // 3. Insertamos en el historial incluyendo el nombre del cliente
                    await pool.query(
                        'INSERT INTO historial_ventas (machine_id, codigo_motor, nombre_producto, precio, cliente_yape) VALUES ($1, $2, $3, $4, $5)',
                        [machine_id, codigoMotor, producto.nombre_producto, producto.precio, nombreCliente]
                    );
                    console.log(" Venta registrada en historial_ventas con cliente:", nombreCliente);
                    
                    if (global.io) {
                        global.io.emit('actualizacionStock', { maquina: machine_id, mensaje: "Venta registrada" });
                    }
                }
            } else {
                console.log(` No se encontró el producto para el motor ${codigoMotor}`);
            }
        } catch (error) {
            console.error("X Error grave en MQTT:", error);
        }
    }
});

// Función reutilizable para enviar el cambio de precio
const enviarComandoPrecio = (machine_id, codigo_motor, precio) => {
    const comandoMQTT = `EDITAR:${codigo_motor},${precio}`;
    const topic = `jaimez/expendedora/${machine_id}/comandos`;
    mqttClient.publish(topic, comandoMQTT, () => {
        console.log(`[MQTT] Precio enviado a la máquina ${machine_id} -> ${comandoMQTT}`);
    });
};

// Enviar pago dinámico por MQTT
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
    enviarComandoPago,
    publicarMensaje
};