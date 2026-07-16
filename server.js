// server.js
const http = require('http');
const WebSocket = require('ws');
require('dotenv').config();
const { Server } = require('socket.io');
const app = require('./app');


// Creamos el servidor HTTP
const server = http.createServer(app);

// Configuramos Socket.IO y permitimos que Vercel se conecte (CORS)
const io = new Server(server, {
  cors: {
    origin: "*", // En producción, aquí pondrás tu URL de Vercel
    methods: ["GET", "POST"]
  }
});

// Guardamos 'io' en una variable global para usarlo en otros archivos
global.io = io;

io.on('connection', (socket) => {
  console.log('⚡ Nuevo panel web conectado:', socket.id);
});

// 1. DEFINES EL PORT AQUÍ (Antes de usarlo)
const PORT = process.env.PORT || 3000;
// 2. Configuración de WebSockets (para las máquinas físicas)
const wss = new WebSocket.Server({ server });
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
    } catch (error) {
      console.error('Error procesando mensaje de WS:', error);
    }
  });
  ws.on('close', () => {
    if (machineId) {
        connectedMachines.delete(machineId);
        console.log(`[WS] Máquina ${machineId} desconectada.`);
    }
  });
});

// 3. Inicio del Servidor (Una sola vez)
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Servidor SaaS corriendo en el puerto ${PORT}`);
});
// ==========================================
// CONFIGURACIÓN DE WEBSOCKETS (COMUNICACIÓN CON ESP32)
// ==========================================
const wss = new WebSocket.Server({ server });
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
    } catch (error) {
      console.error('Error procesando mensaje de WS:', error);
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
// INICIAR SERVIDOR
// ==========================================

server.listen(PORT, () => {
  console.log(`Servidor SaaS corriendo en el puerto ${PORT}`);
});