const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

// Importamos Mercado Pago


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

const { MercadoPagoConfig, Preference } = require('mercadopago');

// ==========================================
// RUTA: Generar Pago Presencial (QR Dinámico para Yape/Plin)
// ==========================================
app.post('/api/generar-pago', async (req, res) => {
    try {
        const { machine_id, codigo_motor } = req.body;

        // 1. Buscamos en la BD la info del producto y el token del dueño
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

        const { nombre_producto, precio, stock, mercadopago_token } = dbResult.rows[0];

        // 2. Validaciones de seguridad
        const precioNumerico = parseFloat(precio);
        if (isNaN(precioNumerico) || precioNumerico <= 0) {
            return res.status(400).json({ success: false, message: 'Precio inválido' });
        }
        if (stock <= 0) {
            return res.status(400).json({ success: false, message: 'Producto agotado' });
        }
        if (!mercadopago_token) {
            return res.status(400).json({ success: false, message: 'Dueño sin configurar Mercado Pago' });
        }

        // 3. Obtener el User ID del dueño (Requerido para la API de Pagos Presenciales)
        const userResponse = await fetch('https://api.mercadopago.com/users/me', {
            headers: { 'Authorization': `Bearer ${mercadopago_token}` }
        });
        const userData = await userResponse.json();
        
        if (!userData.id) {
            return res.status(400).json({ success: false, message: 'Token de Mercado Pago inválido' });
        }
        const userId = userData.id;

        // 4. Crear la Orden Presencial (QR Dinámico)
        const referenciaUnica = `${machine_id}|${codigo_motor}|${Date.now()}`;
        
        // NOTA: Para Mercado Pago, cada máquina física es una "Caja" (POS).
        // Usaremos el machine_id como el ID externo de la caja (external_pos_id).
        const posId = machine_id; 

        const qrResponse = await fetch(`https://api.mercadopago.com/instore/orders/qr/seller/collectors/${userId}/pos/${posId}/qrs`, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${mercadopago_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                external_reference: referenciaUnica,
                title: "Venta Vending Machine",
                description: `Compra de ${nombre_producto}`,
                total_amount: precioNumerico,
                items: [
                    {
                        title: nombre_producto,
                        unit_price: precioNumerico,
                        quantity: 1,
                        unit_measure: "unit",
                        total_amount: precioNumerico
                    }
                ],
                notification_url: `https://vending-api-server.onrender.com/api/webhooks/mercadopago?machine=${machine_id}`
            })
        });

        const qrData = await qrResponse.json();

        // Si Mercado Pago arroja error (ej. La caja no existe)
        if (!qrResponse.ok) {
            console.error("❌ Error API QR Dinámico:", qrData);
            return res.status(400).json({ 
                success: false, 
                message: 'Error al generar QR. Asegúrate de haber creado la Caja (POS) en Mercado Pago.',
                detalle: qrData
            });
        }

        // 5. Retornar el string EMVCo a la ESP32
        res.json({
            success: true,
            qr_data: qrData.qr_data, // <-- La ESP32 usará este texto para dibujar el QR
            referencia: referenciaUnica
        });

    } catch (error) {
        console.error('❌ Error generando pago MP:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// RUTA: Webhook de Mercado Pago
// ==========================================
app.post('/api/webhooks/mercadopago', async (req, res) => {
    try {
        const { type, data } = req.body;
        const machine_id = req.query.machine;

        // Responder rápido para que MP no reintente
        res.sendStatus(200);

        if ((type === 'payment' || req.body.topic === 'payment') && machine_id) {
            const paymentId = data?.id || req.body.id;

            // 1. Obtener token del dueño
            const maqRes = await pool.query(
                'SELECT u.mercadopago_token FROM maquinas m JOIN usuarios_duenos u ON m.id_dueno = u.id WHERE m.machine_id = $1',
                [machine_id]
            );

            if (maqRes.rows.length === 0 || !maqRes.rows[0].mercadopago_token) return;

            const token = maqRes.rows[0].mercadopago_token;

            // 2. Verificar pago real con MP
            const mpResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const mpData = await mpResponse.json();

            // 3. Si aprobado, liberar motor
            if (mpData.status === 'approved') {
                console.log(`✅ Pago ${paymentId} APROBADO. Liberando máquina ${machine_id}.`);
                await pool.query(
                    'UPDATE maquinas SET dispense_pending = true WHERE machine_id = $1',
                    [machine_id]
                );
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