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
  // Índices y columna de versión de fotos (en segundo plano, no retrasa el arranque)
  require('./services/migraciones').migrar()
    .then(() => {
      if (process.env.OPTIMIZAR_IMAGENES_AL_INICIAR === 'true') {
        return require('./services/optimizarImagenes').optimizarImagenes();
      }
    })
    .catch((e) => console.error('[migracion]', e.message));
});

// Mayor que el tiempo del balanceador de Render: reutiliza conexiones en vez de abrir nuevas
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;