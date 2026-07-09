// controllers/yapeController.js
const pool = require('../config/database');
const mqttService = require('../services/mqttService');

const recibirPagoYape = async (req, res) => {
    try {
        const { texto_notificacion, machine_id } = req.body;

        if (!texto_notificacion || !machine_id) {
            return res.status(400).json({ success: false, message: 'Faltan datos' });
        }

        const regexMonto = /S\/\s*(\d+(?:\.\d+)?)/i;
        const regexNombre = /Yape!\s+(.*?)\s+te envi[óo]/i;

        const matchMonto = texto_notificacion.match(regexMonto);
        const matchNombre = texto_notificacion.match(regexNombre);

        if (matchMonto) {
            const monto = parseFloat(matchMonto[1]).toFixed(2);
            const nombreCliente = matchNombre ? matchNombre[1] : 'Cliente Yape';

            // 1. Guardar el nombre del cliente temporalmente en la máquina
            await pool.query(
                'UPDATE maquinas SET ultimo_cliente = $1 WHERE machine_id = $2',
                [nombreCliente, machine_id]
            );

            // 2. Enviar orden a la ESP32
            const comandoMQTT = `PAGO:${monto}`;
            const topic = `jaimez/expendedora/${machine_id}/comandos`;
            mqttService.publicarMensaje(topic, comandoMQTT);

            res.json({ success: true, monto, nombreCliente });
        } else {
            res.status(400).json({ success: false, message: 'Notificación inválida' });
        }
    } catch (error) {
        console.error('Error procesando Yape:', error);
        res.status(500).json({ success: false, message: 'Error interno' });
    }
};

module.exports = { recibirPagoYape };