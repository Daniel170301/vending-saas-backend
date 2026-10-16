// controllers/salesController.js
const pool = require('../config/database');
const identidad = require('../services/identidadMaquina');
const { rolDe } = require('../utils/usuarios');

const confirmarDespacho = async (req, res) => {
  const { machine_id } = req.params;
  const { codigo_motor } = req.body;
  try {
    if (codigo_motor) {
      // Resta 1 de forma atómica (antes se leía y luego se escribía: dos ventas a la vez se pisaban)
      const prodRes = await pool.query(
        `UPDATE inventario SET stock = stock - 1
         WHERE machine_id = $1 AND codigo_motor = $2
         RETURNING nombre_producto, precio, stock`, [machine_id, codigo_motor]);
      if (prodRes.rows.length > 0) {
        const producto = prodRes.rows[0];
        // Toma y limpia el último cliente en un solo paso
        const maqRes = await pool.query(
          `UPDATE maquinas m SET ultimo_cliente = NULL
           FROM (SELECT ultimo_cliente FROM maquinas WHERE machine_id = $1) prev
           WHERE m.machine_id = $1 RETURNING prev.ultimo_cliente`, [machine_id]);
        const cliente = maqRes.rows[0]?.ultimo_cliente || 'Desconocido';

        await pool.query(
          'INSERT INTO historial_ventas (machine_id, codigo_motor, nombre_producto, precio, nombre_cliente) VALUES ($1, $2, $3, $4, $5)',
          [machine_id, codigo_motor, producto.nombre_producto, producto.precio, cliente]);

        const nuevoStock = Number(producto.stock);
        if (nuevoStock <= 3) {
          const nivelAlerta = nuevoStock <= 0 ? '🔴 AGOTADO' : '🟡 STOCK BAJO';
          console.log(`[ALERTA ${nivelAlerta}] Máquina ${machine_id}: ${producto.nombre_producto} (Motor ${codigo_motor}) tiene ${nuevoStock} u.`);
        }
      }
    }
    res.json({ success: true, message: 'Venta confirmada, stock actualizado y registrada en el historial' });
  } catch (error) {
    console.error('Error confirmando despacho:', error);
    res.status(500).json({ success: false, message: 'Error interno en la confirmación' });
  }
};

// Costo del producto: del almacén del DUEÑO de la máquina (antes se cruzaba solo por nombre y,
// si dos dueños tenían el mismo producto, cada venta salía repetida y los totales se inflaban).
const COSTO = `
  LEFT JOIN LATERAL (
    SELECT pa.unit_cost FROM productos_almacen pa
    WHERE pa.name = v.nombre_producto
      AND (m.id_dueno IS NULL OR pa.id_dueno::text = m.id_dueno::text)
    ORDER BY pa.id DESC LIMIT 1
  ) p ON true`;

// =========================================================================
// HISTORIAL DE VENTAS
//  /api/ventas?email=...          todas las máquinas del usuario (superadmin: todas)
//  /api/ventas/:machine_id        una máquina
//  Nuevos y opcionales: &desde=2026-01-01 &hasta=2026-10-06 &limite=500
// =========================================================================
const obtenerHistorialVentas = async (req, res) => {
  try {
    const kmt = await identidad.hayKMT();
    const machine_id = req.params.machine_id || req.query.machine_id;
    const user_id = req.query.user_id || req.query.user || req.query.email;

    const values = [];
    const where = [];
    let extraSelect = '';
    let joinDueno = '';

    if (machine_id) {
      values.push(machine_id);
      where.push(`v.machine_id = $${values.length}`);
    } else if (user_id) {
      const rol = await rolDe(user_id);
      joinDueno = 'LEFT JOIN usuarios_duenos u ON m.id_dueno::text = u.id::text';
      if (rol === 'superadmin') {
        extraSelect = ', u.email AS owner_email';
      } else {
        values.push(user_id);
        where.push(`u.email = $${values.length}`);
      }
    }

    if (req.query.desde) { values.push(req.query.desde); where.push(`v.fecha >= $${values.length}`); }
    if (req.query.hasta) {
      const h = String(req.query.hasta);
      values.push(/^\d{4}-\d{2}-\d{2}$/.test(h) ? `${h} 23:59:59.999` : h);
      where.push(`v.fecha <= $${values.length}`);
    }
    let limite = '';
    if (req.query.limite) {
      values.push(Math.min(parseInt(req.query.limite, 10) || 500, 20000));
      limite = ` LIMIT $${values.length}`;
    }

    const query = `
      SELECT v.*,
             COALESCE(${await identidad.sqlNombre('m')}, v.machine_id) AS nombre_maquina,
             NULLIF(btrim(m.name), '') AS maquina_nombre,
             ${kmt ? 'm.codigo_kmt' : 'NULL::text'} AS maquina_codigo,
             NULLIF(btrim(m.matricula::text), '') AS maquina_matricula${extraSelect},
             COALESCE(p.unit_cost, 0) AS unit_cost,
             COALESCE(p.unit_cost, 0) AS costo
      FROM historial_ventas v
      LEFT JOIN maquinas m ON v.machine_id = m.machine_id
      ${joinDueno}
      ${COSTO}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY v.fecha DESC${limite}`;

    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener el historial de ventas:', error);
    res.status(500).json({ success: false, message: 'Error en el servidor' });
  }
};

module.exports = {
  confirmarDespacho,
  obtenerHistorialVentas,
};
