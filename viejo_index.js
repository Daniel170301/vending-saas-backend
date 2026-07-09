
const http = require('http');
const WebSocket = require('ws');


require('dotenv').config();
const mqtt = require('mqtt'); // NUEVO: Importar MQTT
// Importamos Mercado Pago


const app = express();

const wss = new WebSocket.Server({ server });
// NUEVO: Conectar el backend al broker MQTT
const mqttClient = mqtt.connect('mqtt://broker.hivemq.com');
mqttClient.on('connect', () => {
    console.log('🌐 Backend conectado a HiveMQ exitosamente');
});
app.use(cors());
app.use(express.json());

http
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


// ========================================================
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
// Actualizar nombre, precio y STOCK de un producto (Planograma)
app.put('/api/inventario/actualizar', async (req, res) => {
    try {
        // 1. Recibimos las variables desde el Frontend
        const { machine_id, codigo_motor, nombre_producto, precio, stock } = req.body; //

        // 2. Verificamos si el motor ya tiene un registro en la Base de Datos[cite: 2]
        const motorExiste = await pool.query(
            'SELECT * FROM inventario WHERE machine_id = $1 AND codigo_motor = $2', //[cite: 2]
            [machine_id, codigo_motor] //[cite: 2]
        );

        if (motorExiste.rows.length === 0) {
            // 3. Si NO existe, lo CREAMOS (INSERT) inyectando el stock en el parámetro $5[cite: 2]
            await pool.query(
                'INSERT INTO inventario (machine_id, codigo_motor, nombre_producto, precio, stock) VALUES ($1, $2, $3, $4, $5)', //[cite: 2]
                [machine_id, codigo_motor, nombre_producto, precio, stock] //[cite: 2]
            );
        } else {
            // 4. Si YA existe, lo ACTUALIZAMOS (UPDATE) agregando "stock = $3"[cite: 2]
            await pool.query(
                'UPDATE inventario SET nombre_producto = $1, precio = $2, stock = $3 WHERE machine_id = $4 AND codigo_motor = $5', //[cite: 2]
                [nombre_producto, precio, stock, machine_id, codigo_motor] //[cite: 2]
            );
        }

        // --- NUEVO: PUBLICAR COMANDO MQTT A LA ESP32 ---
        // Se construye el formato esperado: EDITAR:codigo:precio
        const comandoMQTT = `EDITAR:${codigo_motor}:${precio}`;
        
        // Topic donde escucha tu ESP32
       const topic = `jaimez/expendedora/${machine_id}/comandos`;
        
        mqttClient.publish(topic, comandoMQTT, () => {
            console.log(`[MQTT] Precio de motor ${codigo_motor} enviado a la máquina ${machine_id} -> ${comandoMQTT}`);
        });
        // -----------------------------------------------

        // Se responde al frontend confirmando el éxito[cite: 2]
        res.json({ success: true, message: 'Producto y stock guardados correctamente, y ESP32 notificada' });

    } catch (error) {
        console.error("X Error en DB:", error); //[cite: 2]
        res.status(500).json({ success: false, message: 'Error guardando inventario' }); //[cite: 2]
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
