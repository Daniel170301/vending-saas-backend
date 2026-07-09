// controllers/yapeController.js
const mqttService = require('../services/mqttService');

const recibirPagoYape = async (req, res) => {
    try {
        // MacroDroid nos enviará el texto exacto de la notificación y a qué máquina va
        const { texto_notificacion, machine_id } = req.body;

        if (!texto_notificacion || !machine_id) {
            return res.status(400).json({ success: false, message: 'Faltan datos de la notificación' });
        }

        console.log(`📩 Notificación entrante: ${texto_notificacion}`);

        // Regex para buscar el monto después de "S/" (Ej: S/ 1.5, S/ 30.00)
        const regexMonto = /S\/\s*(\d+(?:\.\d+)?)/i;
        // Regex para capturar todo lo que esté entre "Yape!" y "te envió"
        const regexNombre = /Yape!\s+(.*?)\s+te envi[óo]/i;

        const matchMonto = texto_notificacion.match(regexMonto);
        const matchNombre = texto_notificacion.match(regexNombre);

        if (matchMonto) {
            // Normalizamos el monto para que siempre tenga 2 decimales (Ej: 1.5 -> 1.50)
            const monto = parseFloat(matchMonto[1]).toFixed(2);
            const nombreCliente = matchNombre ? matchNombre[1] : 'Cliente Yape';

            console.log(`💰 ¡Monto detectado y normalizado!: S/ ${monto}`);
            console.log(`👤 Cliente identificado: ${nombreCliente}`);

            // Enviamos el comando a la ESP32
            const comandoMQTT = `PAGO:${monto}`;
            const topic = `jaimez/expendedora/${machine_id}/comandos`;
            
            mqttService.publicarMensaje(topic, comandoMQTT);
            console.log(`🚀 Orden enviada a la máquina: ${comandoMQTT}`);

            res.json({ success: true, monto, nombreCliente });
        } else {
            console.log('❌ No se detectó un monto válido');
            res.status(400).json({ success: false, message: 'Notificación inválida' });
        }
    } catch (error) {
        console.error('Error procesando Yape:', error);
        res.status(500).json({ success: false, message: 'Error interno' });
    }
};

module.exports = {
    recibirPagoYape
};