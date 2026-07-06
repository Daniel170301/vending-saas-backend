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

// CONFIRMAR DESPACHO Y RESTAR STOCK AUTOMÁTICAMENTE
app.post('/api/confirm-dispense/:machine_id', async (req, res) => {
    const { machine_id } = req.params;
    const { codigo_motor } = req.body; // Ahora recibiremos qué motor giró

    try {
        // 1. Reseteamos el estado de venta de la máquina
        await pool.query('UPDATE maquinas SET dispense_pending = false WHERE machine_id = $1', [machine_id]);
        
        // 2. Telemetría: Si nos dicen qué motor giró, le restamos 1 al stock
        if (codigo_motor) {
            await pool.query(
                'UPDATE inventario SET stock = stock - 1 WHERE machine_id = $1 AND codigo_motor = $2 AND stock > 0',
                [machine_id, codigo_motor]
            );
        }
        
        res.json({ success: true, message: "Venta confirmada y stock actualizado" });
    } catch (error) {
        console.error("Error confirmando despacho:", error);
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
            SELECT i.nombre_producto, i.precio, i.stock, u.mercadopago_token 
            FROM inventario i
            JOIN maquinas m ON i.machine_id = m.machine_id
            JOIN usuarios_duenos u ON m.id_dueno = u.id
            WHERE i.machine_id = $1 AND i.codigo_motor = $2
        `;
        const dbResult = await pool.query(query, [machine_id, codigo_motor]);

        if (dbResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Producto o máquina no encontrados' });
        }

        const { nombre_producto, precio,stock, mercadopago_token } = dbResult.rows[0];
// 2. NUEVO: Evitamos vender si no hay stock
        if (stock <= 0) {
            return res.status(400).json({ success: false, message: 'Producto agotado en este motor' });
        }
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
                // Cámbiar esta línea en tu ruta /api/generar-pago:
                notification_url: `https://vending-api-server.onrender.com/api/webhooks/mercadopago?machine=${machine_id}`
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
// WEBHOOK DE MERCADO PAGO SAAS
app.post('/api/webhooks/mercadopago', async (req, res) => {
    try {
        const evento = req.body;
        const machine_id = req.query.machine; // Extraemos qué máquina es desde la URL

        // 1. Responder rápido a Mercado Pago (Es obligatorio para que no reenvíen la alerta)
        res.sendStatus(200); 

        // Verificamos que sea una alerta de pago y tengamos la máquina identificada
        if ((evento.type === 'payment' || evento.topic === 'payment') && machine_id) {
            const paymentId = evento.data ? evento.data.id : evento.resource;
            
            // 2. Buscamos el token del dueño de esta máquina específica
            const maqRes = await pool.query(`
                SELECT u.mercadopago_token 
                FROM maquinas m 
                JOIN usuarios_duenos u ON m.id_dueno = u.id 
                WHERE m.machine_id = $1
            `, [machine_id]);

            if (maqRes.rows.length === 0 || !maqRes.rows[0].mercadopago_token) {
                console.error("Webhook: Máquina sin dueño o sin token.");
                return;
            }

            const token = maqRes.rows[0].mercadopago_token;

            // 3. Le preguntamos a Mercado Pago: "¿Este pago es real y está aprobado?"
            const mpResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const mpData = await mpResponse.json();

            // 4. Si el pago está aprobado, le damos luz verde a la máquina
            if (mpData.status === 'approved') {
                console.log(`✅ Pago ${paymentId} APROBADO. Liberando máquina ${machine_id}...`);
                
                await pool.query(
                    'UPDATE maquinas SET dispense_pending = true WHERE machine_id = $1', 
                    [machine_id]
                );
            } else {
                console.log(`⚠️ Pago ${paymentId} detectado, pero su estado es: ${mpData.status}`);
            }
        }
    } catch (error) {
        console.error('❌ Error en el Webhook de MP:', error);
    }
});
// ==========================================
// 6. GESTIÓN DE INVENTARIO SAAS
// ==========================================

// Leer el inventario de una máquina específica
app.get('/api/inventario/:machine_id', async (req, res) => {
    try {
        const { machine_id } = req.params;
        const result = await pool.query('SELECT * FROM inventario WHERE machine_id = $1 ORDER BY codigo_motor ASC', [machine_id]);
        res.json({ success: true, inventario: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error cargando inventario' });
    }
});

// Actualizar precio y stock de un producto
// Actualizar nombre, precio y STOCK de un producto (Planograma)
app.put('/api/inventario/actualizar', async (req, res) => {
    try {
        // 1. Ahora también recibimos la variable "stock" desde el Frontend
        const { machine_id, codigo_motor, nombre_producto, precio, stock } = req.body;
        
        // 2. Verificamos si el motor ya tiene un registro en la Base de Datos
        const motorExiste = await pool.query(
            'SELECT * FROM inventario WHERE machine_id = $1 AND codigo_motor = $2',
            [machine_id, codigo_motor]
        );

        if (motorExiste.rows.length === 0) {
            // 3. Si NO existe, lo CREAMOS (INSERT) inyectando el stock en el parámetro $5
            await pool.query(
                'INSERT INTO inventario (machine_id, codigo_motor, nombre_producto, precio, stock) VALUES ($1, $2, $3, $4, $5)',
                [machine_id, codigo_motor, nombre_producto, precio, stock]
            );
        } else {
            // 4. Si YA existe, lo ACTUALIZAMOS (UPDATE) agregando "stock = $3"
            await pool.query(
                'UPDATE inventario SET nombre_producto = $1, precio = $2, stock = $3 WHERE machine_id = $4 AND codigo_motor = $5',
                [nombre_producto, precio, stock, machine_id, codigo_motor]
            );
        }
        
        res.json({ success: true, message: 'Producto y stock guardados correctamente' });
    } catch (error) {
        console.error("❌ Error en DB:", error);
        res.status(500).json({ success: false, message: 'Error guardando inventario' });
    }
});
// REGISTRO AUTOMÁTICO DE NUEVOS CLIENTES
app.post('/api/registro', async (req, res) => {
    try {
        const { nombre, email, password } = req.body;
        
        // Verificamos si el email ya existe
        const userExists = await pool.query('SELECT * FROM usuarios_duenos WHERE email = $1', [email]);
        if (userExists.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'Este correo ya está registrado.' });
        }

        // Insertamos al nuevo usuario
        await pool.query(
            'INSERT INTO usuarios_duenos (nombre, email, password, rol) VALUES ($1, $2, $3, $4)',
            [nombre, email, password, 'cliente']
        );

        res.json({ success: true, message: 'Usuario registrado exitosamente.' });
    } catch (error) {
        console.error("Error en registro:", error);
        res.status(500).json({ success: false, message: 'Error interno del servidor.' });
    }
});
// ==========================================
// INICIAR SERVIDOR
// ==========================================
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor SaaS corriendo en el puerto ${PORT}`);
});