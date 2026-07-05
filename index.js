const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

// Importamos Mercado Pago
const { MercadoPagoConfig, Preference } = require('mercadopago');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// ==========================================
// 1. CONEXIÓN A BASE DE DATOS SAAS
// ==========================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.connect()
    .then(() => console.log('✅ Conectado a la Base de Datos SaaS exitosamente'))
    .catch(err => console.error('❌ Error de conexión a la BD', err));

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
    res.send('Servidor SaaS de Máquinas Expendedoras - 100% Operativo con Mercado Pago');
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

// CONFIGURACIÓN DE PAGOS (DASHBOARD)
app.post('/api/config/pagos', async (req, res) => {
    // Recibimos los datos del formulario frontend
    const { id_dueno, token } = req.body; // Ahora el token se guarda por dueño, no por máquina
    try {
        await pool.query(
            `UPDATE usuarios_duenos SET mercadopago_token = $1 WHERE id = $2`,
            [token, id_dueno]
        );
        res.json({ success: true, message: "Llave de Mercado Pago guardada exitosamente" });
    } catch (error) {
        console.error("Error al guardar pagos:", error);
        res.status(500).json({ success: false, message: 'Error interno al guardar' });
    }
});

// ==========================================
// 4. RUTAS DEL ESP32 (MANTENIDAS EXACTAMENTE IGUAL)
// ==========================================

// CONSULTA DE ESTADO PARA EL ESP32
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
        res.status(500).json({ success: false, message: 'Error al simular venta' });
    }
});

// ==========================================
// 5. NUEVO MOTOR DE MERCADO PAGO SAAS
// ==========================================

app.post('/api/generar-pago', async (req, res) => {
    try {
        // La ESP32 ahora solo envía quién es y qué motor se activó
        const { machine_id, codigo_motor } = req.body;

        // Buscamos en la BD todo lo necesario en una sola consulta
        const query = `
            SELECT i.nombre_producto, i.precio, u.mercadopago_token 
            FROM inventario i
            JOIN maquinas m ON i.machine_id = m.machine_id
            JOIN usuarios_duenos u ON m.id_dueno = u.id
            WHERE i.machine_id = $1 AND i.codigo_motor = $2
        `;
        const dbResult = await pool.query(query, [machine_id, codigo_motor]);

        if (dbResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Producto o máquina no encontrados' });
        }

        const { nombre_producto, precio, mercadopago_token } = dbResult.rows[0];

        if (!mercadopago_token) {
            return res.status(400).json({ success: false, message: 'Dueño sin configurar Mercado Pago' });
        }

        // Iniciamos Mercado Pago con la llave del cliente específico
        const client = new MercadoPagoConfig({ accessToken: mercadopago_token });
        const preference = new Preference(client);

        const referenciaUnica = `${machine_id}|${codigo_motor}|${Date.now()}`;

        const result = await preference.create({
            body: {
                items: [
                    {
                        title: nombre_producto,
                        unit_price: Number(precio),
                        quantity: 1,
                        currency_id: 'PEN'
                    }
                ],
                external_reference: referenciaUnica,
                notification_url: 'https://vending-api-server.onrender.com/api/webhooks/mercadopago'
            }
        });

        res.json({
            success: true,
            qr_url: result.init_point,
            referencia: referenciaUnica
        });

    } catch (error) {
        console.error('❌ Error generando pago MP:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// WEBHOOK DE MERCADO PAGO
app.post('/api/webhooks/mercadopago', async (req, res) => {
    try {
        const evento = req.body;
        console.log("🔔 Alerta de Mercado Pago recibida:", evento.type || evento.topic);
        res.sendStatus(200); // Responder rápido a MP

        if (evento.type === 'payment' || evento.topic === 'payment') {
            const paymentId = evento.data ? evento.data.id : evento.resource;
            console.log(`✅ Pago detectado con ID: ${paymentId}`);
            
            // Simulación temporal: Aquí activaríamos la máquina leyendo el ID de la referencia
            // await pool.query('UPDATE maquinas SET dispense_pending = true WHERE machine_id = $1', [machineId]);
        }
    } catch (error) {
        console.error('❌ Error en el Webhook de MP:', error);
    }
});

// ==========================================
// INICIAR SERVIDOR
// ==========================================
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor SaaS corriendo en el puerto ${PORT}`);
});