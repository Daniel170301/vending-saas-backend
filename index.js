const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// ==========================================
// 1. CONEXIÓN A BASE DE DATOS
// ==========================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.connect()
    .then(() => console.log('Conectado a la Base de Datos exitosamente'))
    .catch(err => console.error('Error de conexión a la BD', err));

// ==========================================
// 2. WEBSOCKETS (COMUNICACIÓN CON ESP32)
// ==========================================
const connectedMachines = new Map();

wss.on('connection', (ws) => {
    let machineId = null;
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'REGISTER') {
                machineId = data.machine_id;
                connectedMachines.set(machineId, ws);
                console.log(`[WS] Máquina ${machineId} conectada en línea.`);
            }
        } catch (error) {}
    });
    ws.on('close', () => {
        if (machineId) connectedMachines.delete(machineId);
    });
});

// ==========================================
// 3. API ENDPOINTS (DASHBOARD Y LOGIN)
// ==========================================
app.get('/', (req, res) => {
    res.send('Servidor SaaS de Máquinas Expendedoras - 100% Operativo');
});

// LOGIN
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT id, nombre, email, rol FROM usuarios_duenos WHERE email = $1 AND password = $2', [email, password]);
        if (result.rows.length > 0) {
            res.json({ success: true, user: result.rows[0] });
        } else {
            res.json({ success: false, message: 'Credenciales incorrectas' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error de servidor' });
    }
});

// OBTENER MÁQUINAS (Modo Superadmin/Cliente)
app.get('/api/maquinas/:id_dueno', async (req, res) => {
    const { id_dueno } = req.params;
    try {
        const userResult = await pool.query('SELECT rol FROM usuarios_duenos WHERE id = $1', [id_dueno]);
        if (userResult.rows.length === 0) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });

        const rolUsuario = userResult.rows[0].rol;
        let query = rolUsuario === 'superadmin' 
            ? 'SELECT m.*, u.nombre AS nombre_dueno FROM maquinas m LEFT JOIN usuarios_duenos u ON m.id_dueno = u.id'
            : 'SELECT m.*, u.nombre AS nombre_dueno FROM maquinas m LEFT JOIN usuarios_duenos u ON m.id_dueno = u.id WHERE m.id_dueno = $1';
        
        const result = await pool.query(query, rolUsuario === 'superadmin' ? [] : [id_dueno]);
        res.json({ success: true, maquinas: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error al consultar máquinas' });
    }
});

// ==========================================
// 4. RUTAS DEL ESP32 (¡AQUÍ ESTÁ LA MAGIA!)
// ==========================================

// CONSULTA DE ESTADO PARA EL ESP32 (La que daba Cannot GET)
app.get('/api/machine-status/:machine_id', async (req, res) => {
    const { machine_id } = req.params;
    try {
        const result = await pool.query('SELECT dispense_pending FROM maquinas WHERE machine_id = $1', [machine_id]);
        if (result.rows.length > 0) {
            res.json({ success: true, pending_dispense: result.rows[0].dispense_pending });
        } else {
            res.status(404).json({ success: false, message: "Máquina no encontrada" });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error de conexión' });
    }
});

// CONFIRMAR DESPACHO
app.post('/api/confirm-dispense/:machine_id', async (req, res) => {
    const { machine_id } = req.params;
    try {
        await pool.query('UPDATE maquinas SET dispense_pending = false WHERE machine_id = $1', [machine_id]);
        res.json({ success: true, message: "Estado de venta reseteado" });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error en confirmación' });
    }
});

// SIMULAR UNA VENTA PAGADA
app.get('/api/trigger-dispense/:machine_id', async (req, res) => {
    const { machine_id } = req.params;
    try {
        await pool.query('UPDATE maquinas SET dispense_pending = true WHERE machine_id = $1', [machine_id]);
        res.json({ success: true, message: "Venta simulada, esperando al ESP32" });
    } catch (error) {
        console.error("Error al simular:", error);
        res.status(500).json({ success: false, message: 'Error al simular venta' });
    }
});
// ==========================================
// CONFIGURACIÓN DE PAGOS (DASHBOARD)
// ==========================================
app.post('/api/config/pagos', async (req, res) => {
    // Recibimos los datos del formulario frontend
    const { machine_id, pasarela_tipo, numero_celular, token } = req.body;
    
    try {
        // Actualizamos la máquina con su configuración de pagos
        await pool.query(
            `UPDATE maquinas 
             SET pasarela_tipo = $1, 
                 numero_celular = $2, 
                 api_key_privada = $3 
             WHERE machine_id = $4`,
            [pasarela_tipo, numero_celular, token, machine_id]
        );
        
        res.json({ success: true, message: "Bóveda de pagos guardada exitosamente" });
    } catch (error) {
        console.error("Error al guardar pagos:", error);
        res.status(500).json({ success: false, message: 'Error interno al guardar' });
    }
});

// ==========================================
// NUEVO ENDPOINT: GENERAR ORDEN EN CULQI
// ==========================================
// Capturamos la llave secreta que acabas de guardar en las variables de entorno
const CULQI_SECRET_KEY = process.env.CULQI_SECRET_KEY;

app.post('/api/generar-pago', async (req, res) => {
    // La ESP32 nos enviará qué máquina es y cuánto cuesta el producto
    const { machine_id, codigo_motor, precio } = req.body;

    try {
        // 1. Culqi lee los precios en céntimos enteros (Ej: S/ 1.50 = 150)
        const montoEnCentimos = Math.round(parseFloat(precio) * 100);
        
        // 2. Creamos un número de recibo único para esta venta
        const numeroOrden = `VEND-${machine_id.substring(0,4)}-${Date.now()}`;
        
        // 3. Le damos al cliente 5 minutos para escanear y pagar antes de que caduque
        const tiempoExpiracion = Math.floor(Date.now() / 1000) + (5 * 60);

        // 4. Hacemos la llamada telefónica digital a los servidores de Culqi
        const respuestaCulqi = await fetch('https://api.culqi.com/v2/orders', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${CULQI_SECRET_KEY}` // Tu llave secreta firmando la petición
            },
            body: JSON.stringify({
                "amount": montoEnCentimos,
                "currency_code": "PEN",
                "description": `Producto ${codigo_motor} - Expendedora`,
                "order_number": numeroOrden,
                "client_details": {
                    // Datos genéricos porque es una máquina física, no sabemos quién compra
                    "first_name": "Cliente",
                    "last_name": "Vending",
                    "email": "compras@kymatic.com", 
                    "phone_number": "999999999"
                },
                "expiration_date": tiempoExpiracion
            })
        });

        const datosOrden = await respuestaCulqi.json();

        if (datosOrden.id) {
            console.log(`✅ Orden de Culqi creada: ${datosOrden.id}`);
            
            // Todo salió bien. Le devolvemos a la ESP32 el OK para que dibuje el QR
            res.json({ 
                success: true, 
                order_id: datosOrden.id,
                mensaje: "Orden creada con éxito"
            });
        } else {
            console.error("❌ Error de Culqi:", datosOrden);
            res.status(400).json({ success: false, message: 'El banco rechazó la orden' });
        }

    } catch (error) {
        console.error("❌ Error de conexión:", error);
        res.status(500).json({ success: false, message: 'Error interno del servidor' });
    }
});

// ==========================================
// INICIAR SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});