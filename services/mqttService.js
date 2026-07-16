// services/mqttService.js
const mqtt = require('mqtt');

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

    // Si el mensaje es una venta (Ej: "VENTA:22")
    if (mensajeTexto.startsWith('VENTA:')) {
        const codigoMotor = mensajeTexto.substring(6).trim();
        
        // Extraemos la MAC de la máquina desde el tópico (jaimez/expendedora/MAC/eventos)
        const partesTopic = topic.split('/');
        const machine_id = partesTopic[2]; 

        try {
            // Descontamos 1 del stock en la base de datos
            const query = `
                UPDATE inventario 
                SET stock = stock - 1 
                WHERE machine_id = $1 AND codigo_motor = $2 AND stock > 0
                RETURNING stock;
            `;
            const result = await pool.query(query, [machine_id, codigoMotor]);

            if (result.rowCount > 0) {
                console.log(`✅ ¡Venta física confirmada! Máquina ${machine_id}, Motor ${codigoMotor}. Nuevo stock: ${result.rows[0].stock}`);
            } else {
                console.log(`⚠️ Aviso: El motor ${codigoMotor} reportó venta pero ya figuraba sin stock en BD.`);
            }
        } catch (error) {
            console.error("❌ Error de BD al procesar venta MQTT:", error);
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