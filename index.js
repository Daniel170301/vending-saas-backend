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

    console.log(`[API] Intento de login en BD con: ${email}`);

    try {
        // Hacemos la consulta usando parámetros seguros ($1) para evitar inyecciones SQL
        const result = await pool.query('SELECT * FROM usuarios_duenos WHERE email = $1', [email]);

        // Si no encuentra ningún registro con ese correo
        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'El correo electrónico no está registrado' });
        }

        const user = result.rows[0];

        // Verificamos si la contraseña coincide
        // (Nota profesional: En la Fase 5 cambiaremos esto por una comparación encriptada con bcrypt)
        if (user.password === password) {
            res.json({ 
                success: true, 
                message: 'Bienvenido al sistema SaaS',
                user: { id: user.id, nombre: user.nombre, email: user.email }
            });
        } else {
            res.status(401).json({ success: false, message: 'La contraseña es incorrecta' });
        }

    } catch (error) {
        console.error('Error en la consulta de login:', error);
        res.status(500).json({ success: false, message: 'Error interno del servidor al autenticar' });
    }
});
// ==========================================
// 5. ENDPOINT PARA GUARDAR CONFIGURACIÓN DE PAGOS (CULQI / YAPE)
// ==========================================
app.post('/api/save-config', async (req, res) => {
    // Ahora recibimos también pasarela_tipo desde el frontend
    const { id_dueno, pasarela_tipo, api_key_publica, api_key_privada } = req.body;

    try {
        const query = `
            UPDATE maquinas 
            SET pasarela_tipo = $1, api_key_publica = $2, api_key_privada = $3 
            WHERE id_dueno = $4
        `;
        await pool.query(query, [pasarela_tipo, api_key_publica, api_key_privada, id_dueno]);
        
        res.json({ success: true, message: 'Configuración de pasarela guardada exitosamente' });
    } catch (error) {
        console.error('Error al guardar configuración:', error);
        res.status(500).json({ success: false, message: 'Error al guardar en la base de datos' });
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
// INICIAR SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});