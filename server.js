// server.js
const http = require('http');
const WebSocket = require('ws');
require('dotenv').config();

// Importamos nuestra app de Express
const app = require('./app');

// Creamos el servidor HTTP
const server = http.createServer(app);

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
const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  console.log(`Servidor SaaS corriendo en el puerto ${PORT}`);
});