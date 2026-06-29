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
// INICIAR SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});