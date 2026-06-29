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
// 1. CONEXIÓN A BASE DE DATOS POSTGRESQL
// ==========================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Requerido para conexiones externas en Render
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
            // Cuando la máquina se enciende, se registra en el servidor
            if (data.type === 'REGISTER') {
                machineId = data.machine_id;
                connectedMachines.set(machineId, ws);
                console.log(`[WS] Máquina ${machineId} conectada en línea.`);
            }
        } catch (error) {
            console.error('Error leyendo mensaje del ESP32:', error);
        }
    });

    ws.on('close', () => {
        if (machineId) {
            connectedMachines.delete(machineId);
            console.log(`[WS] Máquina ${machineId} desconectada.`);
        }
    });
});

// ==========================================
// 3. ENDPOINTS (API PARA PRUEBAS Y WEBHOOKS)
// ==========================================
app.get('/', (req, res) => {
    res.send('Servidor SaaS de Máquinas Expendedoras - 100% Operativo');
});
// ==========================================
// 4. ENDPOINT DE AUTENTICACIÓN (LOGIN REAL CON BD)
// ==========================================
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        // Asegúrate de incluir 'rol' aquí explícitamente
        const result = await pool.query('SELECT id, nombre, email, rol FROM usuarios_duenos WHERE email = $1 AND password = $2', [email, password]);
        
        if (result.rows.length > 0) {
            // Construimos el objeto usuario explícitamente para asegurar que el rol viaje
            const user = result.rows[0];
            res.json({ 
                success: true, 
                user: {
                    id: user.id,
                    nombre: user.nombre,
                    email: user.email,
                    rol: user.rol // ¡Aquí es donde debe ir!
                }
            });
        } else {
            res.json({ success: false, message: 'Credenciales incorrectas' });
        }
    } catch (error) {
        console.error("Error en login:", error);
        res.status(500).json({ success: false, message: 'Error de servidor' });
    }
});
// ==========================================
// 5. ENDPOINT PARA GUARDAR CONFIGURACIÓN DE PAGOS (CULQI / YAPE)
// ==========================================
// Busca esta parte en tu index.js y reemplázala:
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        // AÑADIMOS 'rol' A LA CONSULTA SQL
        const result = await pool.query('SELECT id, nombre, email, rol FROM usuarios_duenos WHERE email = $1 AND password = $2', [email, password]);
        
        if (result.rows.length > 0) {
            res.json({ success: true, user: result.rows[0] }); // Aquí ahora enviamos el rol
        } else {
            res.json({ success: false, message: 'Credenciales incorrectas' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error de servidor' });
    }
});
// ==========================================
// 6. ENDPOINT PARA OBTENER LAS MÁQUINAS (CON MODO SUPERADMIN)
// ==========================================
app.get('/api/maquinas/:id_dueno', async (req, res) => {
    const { id_dueno } = req.params;
    const { rol } = req.query; // Recibimos el rol desde el frontend

    try {
        let query = '';
        let values = [];

        if (rol === 'superadmin') {
            // Modo Dios: Ve TODAS las máquinas y a quién le pertenecen
            query = `
                SELECT m.*, u.nombre AS nombre_dueno 
                FROM maquinas m 
                LEFT JOIN usuarios_duenos u ON m.id_dueno = u.id
            `;
        } else {
            // Modo Cliente: Solo ve las suyas
            query = `
                SELECT m.*, u.nombre AS nombre_dueno 
                FROM maquinas m 
                LEFT JOIN usuarios_duenos u ON m.id_dueno = u.id 
                WHERE m.id_dueno = $1
            `;
            values = [id_dueno];
        }

        const result = await pool.query(query, values);
        res.json({ success: true, maquinas: result.rows });
    } catch (error) {
        console.error('Error al obtener máquinas:', error);
        res.status(500).json({ success: false, message: 'Error al consultar las máquinas' });
    }
});
// ==========================================
// 7. ENDPOINT PARA EL ESP32 (Consulta de estado)
// ==========================================
// Endpoint para confirmar que el producto ya fue entregado
app.post('/api/confirm-dispense/:machine_id', async (req, res) => {
    const { machine_id } = req.params;
    try {
        await pool.query('UPDATE maquinas SET dispense_pending = false WHERE machine_id = $1', [machine_id]);
        res.json({ success: true, message: "Estado de venta reseteado" });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error en confirmación' });
    }
});
// ==========================================
// INICIAR SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});