// server.js
const http = require('http'); //[cite: 4]
const WebSocket = require('ws'); //[cite: 4]
require('dotenv').config(); //[cite: 4]

// Importamos nuestra app de Express
const app = require('./app');

// Creamos el servidor HTTP[cite: 4]
const server = http.createServer(app); //[cite: 4]

// ==========================================
// CONFIGURACIÓN DE WEBSOCKETS (COMUNICACIÓN CON ESP32)[cite: 4]
// ==========================================
const wss = new WebSocket.Server({ server }); //[cite: 4]
const connectedMachines = new Map(); //[cite: 4]

wss.on('connection', (ws) => { //[cite: 4]
  let machineId = null; //[cite: 4]

  ws.on('message', (message) => { //[cite: 4]
    try {
      const data = JSON.parse(message); //[cite: 4]
      
      if (data.type === 'REGISTER') { //[cite: 4]
        machineId = data.machine_id; //[cite: 4]
        connectedMachines.set(machineId, ws); //[cite: 4]
        console.log(`[WS] Máquina ${machineId} conectada en línea.`); //[cite: 4]
      }
    } catch (error) { //[cite: 4]
      console.error('Error procesando mensaje de WS:', error);
    }
  });

  ws.on('close', () => { //[cite: 4]
    if (machineId) {
        connectedMachines.delete(machineId); //[cite: 4]
        console.log(`[WS] Máquina ${machineId} desconectada.`);
    }
  }); //[cite: 4]
});

// ==========================================
// INICIAR SERVIDOR[cite: 4]
// ==========================================
const PORT = process.env.PORT || 10000; //[cite: 4]

server.listen(PORT, () => { //[cite: 4]
  console.log(`Servidor SaaS corriendo en el puerto ${PORT}`); //[cite: 4]
}); //[cite: 4]