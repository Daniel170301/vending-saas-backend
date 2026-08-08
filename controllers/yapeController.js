// controllers/yapeController.js
const pool = require('../config/database');
const mqttService = require('../services/mqttService');

const recibirPagoYape = async (req, res) => {
    try {
        // 1. Atrapamos la MAC (puede venir en la URL o en el JSON de MacroDroid)
        const machine_id = req.params.machine_id || req.body.machine_id;
        
        // 2. Atrapamos el texto de la notificación
        const texto_notificacion = req.body.texto_notificacion || (typeof req.body === 'string' ? req.body : null);

        if (!texto_notificacion || !machine_id) {
            return res.status(400).json({ success: false, message: 'Faltan datos de MacroDroid' });
        }

        // ==========================================
        // 🔮 LOS NUEVOS DETECTORES DE TEXTO (REGEX)
        // ==========================================
        
        // Atrapa los números después de "S/ "
        const regexMonto = /S\/\s*(\d+(?:\.\d+)?)/i;
        
        // Atrapa TODO el texto desde el inicio hasta antes de " te envió"
        const regexNombre = /^(.+?)\s+te envi[óo]/i;

        const matchMonto = texto_notificacion.match(regexMonto);
        const matchNombre = texto_notificacion.match(regexNombre);

        if (matchMonto) {
            const monto = parseFloat(matchMonto[1]).toFixed(2);
            // Si encuentra el nombre lo limpia de espacios, si no, usa el valor por defecto
            const nombreCliente = matchNombre ? matchNombre[1].trim() : 'Cliente Yape';

            console.log(`✅ [YAPE EXITOSO] S/ ${monto} recibido de: ${nombreCliente} (MAC: ${machine_id})`);

            // 3. Guardar el nombre del cliente en la base de datos
            await pool.query(
                'UPDATE maquinas SET ultimo_cliente = $1 WHERE machine_id = $2',
                [nombreCliente, machine_id]
            );

            // 4. Enviar la orden al ESP32 por MQTT
            const comandoMQTT = `PAGO:${monto}`;
            const topic = `jaimez/expendedora/${machine_id}/comandos`;
            mqttService.publicarMensaje(topic, comandoMQTT);

            res.json({ success: true, monto, nombreCliente });
        } else {
            console.log(`❌ [YAPE IGNORADO] El texto no contiene un monto válido: ${texto_notificacion}`);
            res.status(400).json({ success: false, message: 'Notificación inválida (No se detectó monto)' });
        }
    } catch (error) {
        console.error('Error procesando Yape en el servidor:', error);
        res.status(500).json({ success: false, message: 'Error interno del servidor' });
    }
};

module.exports = { recibirPagoYape };