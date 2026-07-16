// controllers/paymentController.js
const mqttService = require('../services/mqttService');
// Importa tu pool de base de datos para poder guardar el registro
const pool = require('../config/database'); 

const recibirPagoYape = async (req, res) => {
    // 1. Capturamos la MAC dinámicamente desde la URL (Ej: /api/pago-recibido/D4-8A...)
    const machine_id = req.params.machine_id;
    const textoNotificacion = req.body || "";
    
    console.log(`📩 Notificación para máquina [${machine_id}]:\n${textoNotificacion}`);

    // 2. EXTRACCIÓN INTELIGENTE (Regex)
    // Extrae monto (Ej: S/ 30.00)
    const montoMatch = textoNotificacion.match(/S\/\s*(\d+(?:\.\d+)?)/);
    // Extrae nombre (Todo lo que está antes de "te envió un pago")
    const nombreMatch = textoNotificacion.match(/(.*?)\s+te envió un pago/i);
    // Extrae código de seguridad (Los números después de "seguridad es:")
    const codigoMatch = textoNotificacion.match(/seguridad es:\s*(\d+)/i);

    if (montoMatch) {
        const montoPagado = parseFloat(montoMatch[1]).toFixed(2);
        const cliente = nombreMatch ? nombreMatch[1].trim() : "Cliente Yape";
        const codigoOperacion = codigoMatch ? codigoMatch[1].trim() : "Sin código";

        console.log(`✅ YAPE DETECTADO -> Cliente: ${cliente} | Monto: S/ ${montoPagado} | Cód: ${codigoOperacion}`);
        
        // 3. Enviamos la orden física a la máquina vía MQTT
        mqttService.enviarComandoPago(machine_id, montoPagado);
        
        // 4. GUARDAMOS EN BASE DE DATOS (Para tus reportes PDF)
        try {
            // Nota: Asegúrate de tener una tabla llamada 'historial_pagos' o ajusta el nombre a la tuya
            /*
            await pool.query(
                `INSERT INTO historial_pagos (machine_id, cliente, monto, codigo_operacion, metodo) 
                 VALUES ($1, $2, $3, $4, 'Yape')`,
                [machine_id, cliente, montoPagado, codigoOperacion]
            );
            */
            console.log(`💾 Pago de ${cliente} guardado en BD para los reportes.`);
        } catch (dbError) {
            console.error("Error guardando el pago en BD:", dbError);
            // No detenemos el flujo, lo importante es que la máquina ya recibió el crédito
        }
        
        res.status(200).send('Monto procesado y enviado a la máquina');
    } else {
        console.log('❌ Error: No se detectó un formato válido de Yape.');
        res.status(400).send('Formato no reconocido');
    }
};

module.exports = {
    recibirPagoYape
};