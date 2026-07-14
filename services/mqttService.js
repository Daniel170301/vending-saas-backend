// services/mqttService.js
const mqtt = require('mqtt');

// Conectamos al broker
const mqttClient = mqtt.connect('mqtt://broker.hivemq.com');

mqttClient.on('connect', () => {
    console.log('🌐 Servicio MQTT conectado a HiveMQ exitosamente');
});

// Función reutilizable para enviar el cambio de precio
const enviarComandoPrecio = (machine_id, codigo_motor, precio) => {
    // 1. Usamos un espacio como separador para respetar el substring(10) del ESP32
    const comandoMQTT = `EDITAR:${codigo_motor} ${precio}`;
    
    // 2. Usamos el tópico exacto que tu ESP32 está escuchando actualmente
    const topic = `jaimez/expendedora/comandos`;
    
    mqttClient.publish(topic, comandoMQTT, () => {
        console.log(`[MQTT] Precio enviado a la máquina ${machine_id} -> ${comandoMQTT}`);
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
    publicarMensaje
};