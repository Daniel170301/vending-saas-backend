// utils/auditoria.js
// Historial de lo que hace el superadmin: quién cambió qué, cuándo y qué valor tenía antes.
// Nunca bloquea la acción: si no se puede guardar el registro, solo deja un aviso en el log.
// Se llama DESPUÉS del COMMIT (con el pool): un fallo aquí no puede abortar la transacción.
const pool = require('../config/database');

async function registrar({ usuario, accion, machine_id = null, detalle = null }) {
  try {
    await pool.query(
      `INSERT INTO auditoria_superadmin (usuario, accion, machine_id, detalle) VALUES ($1, $2, $3, $4)`,
      [usuario || null, accion, machine_id, detalle]);
  } catch (e) {
    console.warn(`[auditoria] no se registró "${accion}": ${e.message}`);
  }
}

// Textos para mostrar en pantalla
const ACCIONES = {
  codigo_kmt_asignado:   'Asignó el código',
  codigo_kmt_quitado:    'Quitó el código',
  equipo_cambiado:       'Cambió el equipo (placa)',
  datos_editados:        'Editó nombre o matrícula',
  yape_vinculado:        'Vinculó la cuenta Yape',
  yape_desvinculado:     'Desvinculó la cuenta Yape',
  incidencias_resueltas: 'Resolvió incidencias',
  pago_reembolsado:      'Marcó un pago como reembolsado',
  ventas_reintentadas:   'Reintentó ventas hacia Qhapay',
  region_creada:         'Creó una región',
  region_editada:        'Editó una región',
  region_eliminada:      'Eliminó una región',
  cuenta_yape_creada:    'Creó una cuenta Yape',
  cuenta_yape_editada:   'Editó una cuenta Yape',
  datos_movidos:         'Movió datos sin máquina',
};

module.exports = { registrar, ACCIONES };
