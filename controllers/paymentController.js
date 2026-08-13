// controllers/paymentController.js
const mqttService = require('../services/mqttService');
// Importa tu pool de base de datos para poder guardar el registro
const pool = require('../config/database'); 

const recibirPagoYape = async (req, res) => {
    // 1. Capturamos la MAC dinámicamente desde la URL
    const machine_id = req.params.machine_id;
    const textoNotificacion = req.body || "";
    
    console.log(`📩 Notificación para máquina [${machine_id}]:\n${textoNotificacion}`);

    // 2. EXTRACCIÓN INTELIGENTE (Regex)
    const montoMatch = textoNotificacion.match(/S\/\s*(\d+(?:\.\d+)?)/);
    const nombreMatch = textoNotificacion.match(/(.*?)\s+te envió un pago/i);
    const codigoMatch = textoNotificacion.match(/seguridad es:\s*(\d+)/i);

    if (montoMatch) {
        const montoPagado = parseFloat(montoMatch[1]).toFixed(2);
        const cliente = nombreMatch ? nombreMatch[1].trim() : "Cliente Yape";
        const codigoOperacion = codigoMatch ? codigoMatch[1].trim() : "Sin código";

        console.log(`✅ YAPE DETECTADO -> Cliente: ${cliente} | Monto: S/ ${montoPagado} | Cód: ${codigoOperacion}`);
        
        // 3. GUARDAMOS EN BASE DE DATOS (El nombre del cliente para enlazarlo con la venta)
        try {
            // Actualizamos la máquina con el nombre de quien acaba de yapear
            await pool.query(
                'UPDATE maquinas SET ultimo_cliente = $1 WHERE machine_id = $2',
                [cliente, machine_id]
            );
            console.log(`💾 Cliente ${cliente} enlazado a la máquina en la BD.`);
            
        } catch (dbError) {
            console.error("❌ Error guardando el cliente temporal en BD:", dbError);
        }

        // 4. Enviamos la orden física a la máquina vía MQTT
        // Es mejor hacerlo DESPUÉS de guardar en la BD, así nos aseguramos de que el nombre ya esté ahí cuando la máquina responda.
        mqttService.enviarComandoPago(machine_id, montoPagado);
        
        res.status(200).send('Monto procesado y enviado a la máquina');
    } else {
        console.log('❌ Error: No se detectó un formato válido de Yape.');
        res.status(400).send('Formato no reconocido');
    }
};

module.exports = {
    recibirPagoYape
};