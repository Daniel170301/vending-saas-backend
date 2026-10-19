// controllers/machineController.js
const pool = require('../config/database');
const mqttService = require('../services/mqttService'); 
const { rolDe } = require('../utils/usuarios');
const { verificarSuperadmin, MENSAJES, ROLES_SUPERADMIN } = require('../utils/auth');
const identidad = require('../services/identidadMaquina');
const auditoria = require('../utils/auditoria');
const { columnaExiste } = require('../utils/esquema');

// Mensaje cuando se ignora un ID de equipo que no mandó el superadmin. Si quien guarda ES el
// superadmin pero su sesión venció, se le dice eso; a los demás, que lo asigna el superadmin.
async function mensajeCodigoIgnorado(sa, email) {
    if (sa.motivo !== 'no_superadmin' && email && ROLES_SUPERADMIN.has(await rolDe(email))) return MENSAJES[sa.motivo];
    return 'El código de la máquina lo asigna el superadmin de Qhapay.';
}

// Campos de identidad que ven todas las pantallas: nombre, código KMT, región, ID del equipo
async function camposIdentidad() {
    return `${await identidad.sqlNombre('m')} AS name,
            NULLIF(btrim(m.name), '') AS nombre,
            ${await identidad.sqlCodigo('m')} AS code,
            ${await identidad.sqlCamposKMT('m')},
            m.machine_id AS equipo_id`;
}
// Orden de las listas: por código KMT (región y número) y después por nombre
async function ordenMaquinas() {
    return (await identidad.hayKMT())
        ? `m.region_id NULLS LAST, m.numero_kmt NULLS LAST, lower(${await identidad.sqlNombre('m')})`
        : `lower(${await identidad.sqlNombre('m')})`;
}

// Tipo de la columna layout (json, jsonb o text), para contar bandejas/resortes en SQL
let tipoLayout = null;
async function exprLayout() {
    if (!tipoLayout) {
        const r = await pool.query(`SELECT data_type FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'maquinas' AND column_name = 'layout'`);
        tipoLayout = r.rows[0]?.data_type || 'jsonb';
    }
    const L = tipoLayout === 'jsonb' ? 'm.layout' : tipoLayout === 'json' ? 'm.layout::jsonb' : "NULLIF(m.layout::text, '')::jsonb";
    const bandejas = `CASE jsonb_typeof(${L}) WHEN 'array' THEN ${L} WHEN 'object' THEN COALESCE(${L}->'trays', '[]'::jsonb) ELSE '[]'::jsonb END`;
    return `
        (SELECT count(*) FROM jsonb_array_elements(${bandejas}) t)::int AS bandejas_total,
        (SELECT COALESCE(SUM(CASE WHEN jsonb_typeof(t->'springs') = 'array' THEN jsonb_array_length(t->'springs') ELSE 0 END), 0)
           FROM jsonb_array_elements(${bandejas}) t)::int AS resortes_total`;
}

// true si el layout no tiene ninguna bandeja (vacío, null, "[]", {trays: []} o JSON roto)
function esLayoutVacio(valor) {
    let x = valor;
    if (typeof x === 'string') { try { x = JSON.parse(x); } catch { return true; } }
    if (x == null) return true;
    const bandejas = Array.isArray(x) ? x : Array.isArray(x.trays) ? x.trays : null;
    return !bandejas || bandejas.length === 0;
}

// === 1. FUNCIÓN GET MACHINES (ACTUALIZADA CON MODO DIOS) ===
const getMachines = async (req, res) => {
    try {
        const usuarioSolicitante = req.query.user;

        if (!usuarioSolicitante || usuarioSolicitante === 'desconocido') {
            return res.json([]); 
        }

        const userRol = await rolDe(usuarioSolicitante);
        // ?ligero=1 -> sin el layout completo (con 1000 máquinas pesa megas); trae bandejas_total y resortes_total.
        // Para editar una máquina se pide completa con GET /api/machines/:id
        const ligero = ['1', 'true', 'si'].includes(String(req.query.ligero || '').toLowerCase());

        let query = '';
        let queryParams = [];

        const baseQuery = `
            SELECT 
                m.machine_id AS id,
                m.id_dueno,
                m.id_cliente_punto,
                ${await camposIdentidad()},
                COALESCE(m.location, m.ubicacion) AS location,
                m.numero_celular AS phone,
                'online' AS status,
                m.pago_al_dia,
                ${(await columnaExiste('maquinas', 'mensaje_bloqueo')) ? 'm.mensaje_bloqueo, m.suspendida_en,' : ''}
                m.macrodroid_activo,
                m.brand, m.model, m.plate, m.coin_base, m.coin_current,
                m.coin_brand, m.coin_plate, m.bill_enabled, m.bill_brand,
                m.bill_model, m.bill_plate, ${ligero ? await exprLayout() : 'm.layout'},
                
                m.distrito, 
                m.ciudad, 
                m.referencia, 
                m.matricula, 
                m.costo_maquina, 
                m.anos_depreciar,
                m.dia_depreciacion, -- 🔥 AQUÍ ESTABA EL PROBLEMA DE LECTURA (FRONTEND)
                
                u.email AS owner_email,
                u.nombre AS owner_name,
                
                c.razon_social AS nombre_cliente
                
            FROM maquinas m
            LEFT JOIN usuarios_duenos u ON m.id_dueno::text = u.id::text
            LEFT JOIN empresas_clientes c ON m.id_cliente_punto = c.id_usuario
        `;

        const orden = await ordenMaquinas();
        if (userRol === 'superadmin') {
            query = baseQuery + ` ORDER BY ${orden};`;
        } else {
            query = baseQuery + ` WHERE u.email = $1 ORDER BY ${orden};`;
            queryParams = [usuarioSolicitante];
        }

        const resultado = await pool.query(query, queryParams);
        res.json(resultado.rows.map(identidad.decorar));
    } catch (error) {
        console.error("Error obteniendo máquinas:", error);
        res.status(500).json({ success: false, message: "Error del servidor" });
    }
};

// === 1b. UNA MÁQUINA COMPLETA (con layout)  GET /api/machines/:id ===
const getMachine = async (req, res) => {
    try {
        const r = await pool.query(`
            SELECT m.*, m.machine_id AS id, ${await camposIdentidad()},
                   COALESCE(m.location, m.ubicacion) AS location, m.numero_celular AS phone,
                   u.email AS owner_email, u.nombre AS owner_name, c.razon_social AS nombre_cliente
            FROM maquinas m
            LEFT JOIN usuarios_duenos u ON m.id_dueno::text = u.id::text
            LEFT JOIN empresas_clientes c ON m.id_cliente_punto = c.id_usuario
            WHERE m.machine_id = $1`, [req.params.id]);
        if (!r.rows.length) return res.status(404).json({ success: false, message: 'Máquina no encontrada' });
        res.json(identidad.decorar(r.rows[0]));
    } catch (error) {
        console.error('Error obteniendo la máquina:', error);
        res.status(500).json({ success: false, message: 'Error del servidor' });
    }
};

// === 2. FUNCIÓN UPDATE MACHINE (TU CÓDIGO INTACTO Y SEGURO) ===
const updateMachine = async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
       // 🔥 SE AGREGÓ LA VARIABLE dia_depreciacion AL DESTRUCTURING
       const { 
            name, code, location, brand, model, bill_plate, layout, 
            id_cliente_punto, distrito, ciudad, referencia, matricula, costo_maquina, anos_depreciar, dia_depreciacion 
        } = req.body;
        
        let layoutSeguro = '[]';
        if (layout) {
            if (typeof layout === 'string') {
                try {
                    layoutSeguro = JSON.stringify(JSON.parse(layout));
                } catch(e) {
                    console.log("⚠️ Advertencia: JSON del layout malformado, se usará vacío por seguridad.");
                }
            } else {
                layoutSeguro = JSON.stringify(layout);
            }
        }

        // CÓDIGO KMT e ID DEL EQUIPO: aquí NUNCA se cambian (aunque lleguen en "code").
        // Solo el superadmin los cambia, desde /api/superadmin/maquinas/:id/codigo-kmt y /equipo.
        // Antes, mandar un "code" distinto renombraba la máquina y se perdían datos.
        await client.query('BEGIN');
        const targetId = id;

        const actualFila = await client.query(
            `SELECT NULLIF(btrim(name), '') AS nombre, ${await identidad.sqlCodigo('maquinas')} AS codigo
             FROM maquinas WHERE machine_id = $1`, [targetId]);
        // La pantalla muestra el código cuando la máquina no tiene nombre: si al guardar devuelve ese
        // mismo texto como nombre, no se guarda (seguiría figurando "sin nombre").
        let nombreNuevo = name;
        if (name !== undefined && actualFila.rows.length && !actualFila.rows[0].nombre) {
            const n = identidad.limpiar(name);
            if (!n || n === actualFila.rows[0].codigo || n === targetId) nombreNuevo = undefined;
        }

        // PROTECCIÓN: un layout VACÍO nunca reemplaza a uno que tiene bandejas (evita perder el
        // planograma por un error del frontend). Para vaciarlo a propósito: { layout: [], borrar_layout: true }
        let ignorarLayout = false;
        if (layout !== undefined && esLayoutVacio(layoutSeguro) && req.body.borrar_layout !== true) {
            const actual = await client.query('SELECT layout FROM maquinas WHERE machine_id = $1', [targetId]);
            if (actual.rows.length && !esLayoutVacio(actual.rows[0].layout)) {
                ignorarLayout = true;
                console.warn(`[máquina ${targetId}] llegó un layout vacío; se conserva el planograma actual`);
            }
        }

        // ACTUALIZACIÓN PARCIAL: solo se cambian los campos que llegan.
        // Antes, si el frontend mandaba solo { layout } (por ejemplo al abastecer), se borraban
        // el nombre, código, ubicación, cliente, costo y depreciación de la máquina.
        const b = req.body;
        const campos = [
            ['name', nombreNuevo],
            ['location', location],
            ['brand', brand],
            ['model', model],
            ['bill_plate', bill_plate],
            ['layout', layout !== undefined ? layoutSeguro : undefined],
            ['id_cliente_punto', id_cliente_punto !== undefined ? (id_cliente_punto || null) : undefined],
            ['distrito', distrito !== undefined ? (distrito || '') : undefined],
            ['ciudad', ciudad !== undefined ? (ciudad || '') : undefined],
            ['referencia', referencia !== undefined ? (referencia || '') : undefined],
            ['matricula', matricula !== undefined ? (matricula || '') : undefined],
            ['costo_maquina', costo_maquina !== undefined ? (costo_maquina || 0) : undefined],
            ['anos_depreciar', anos_depreciar !== undefined ? (anos_depreciar || 5) : undefined],
            ['dia_depreciacion', dia_depreciacion !== undefined ? (dia_depreciacion || 1) : undefined],
        ].filter(([campo, valor]) => (campo === 'name' ? valor !== undefined : b[campo] !== undefined)
                                    && !(campo === 'layout' && ignorarLayout));

        let result;
        if (campos.length) {
            const sets = campos.map(([campo], i) => `${campo} = $${i + 1}`).join(', ');
            result = await client.query(
                `UPDATE maquinas SET ${sets} WHERE machine_id = $${campos.length + 1} RETURNING *`,
                [...campos.map(([, valor]) => valor), targetId]);
        } else {
            result = await client.query('SELECT * FROM maquinas WHERE machine_id = $1', [targetId]);
        }
        if (!result.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false,
                message: 'La máquina no existe (quizá cambió de equipo). Recarga la página.' });
        }

        // Los resortes y los precios solo se sincronizan si llegó un layout
        let layoutArray = layout !== undefined && !ignorarLayout ? JSON.parse(layoutSeguro) : null;
        if (typeof layout === 'string' && !ignorarLayout) {
            try { layoutArray = JSON.parse(layout); } catch(e) { console.log("No se pudo parsear el layout"); }
        }

        if (layoutArray && Array.isArray(layoutArray)) {
            let motoresEnEditor = [];
            layoutArray.forEach(bandeja => {
                if (bandeja.springs && Array.isArray(bandeja.springs)) {
                    bandeja.springs.forEach(resorte => {
                        const codigo = String(resorte.id || resorte.code || resorte.motor || '');
                        let rawCapacidad = resorte.capacity || resorte.capacidad || 10;
                        const capacidad = parseInt(String(rawCapacidad).replace(/\D/g, '')) || 10;

                        if (codigo) {
                            motoresEnEditor.push({ codigo, capacidad });
                        }
                    });
                }
            });

            if (motoresEnEditor.length > 0) {
                const codigosEditor = motoresEnEditor.map(m => m.codigo);
                const invRes = await client.query('SELECT codigo_motor FROM inventario WHERE machine_id = $1', [targetId]);
                const motoresEnDB = invRes.rows.map(row => row.codigo_motor);

                const motoresParaEliminar = motoresEnDB.filter(motor => !codigosEditor.includes(motor));
                const motoresParaAgregar = motoresEnEditor.filter(m => !motoresEnDB.includes(m.codigo));
                const motoresParaActualizar = motoresEnEditor.filter(m => motoresEnDB.includes(m.codigo));

                if (motoresParaEliminar.length > 0) {
                    await client.query(
                        'DELETE FROM inventario WHERE machine_id = $1 AND codigo_motor = ANY ($2)',
                        [targetId, motoresParaEliminar]
                    );
                }

                if (motoresParaAgregar.length > 0) {
                    for (let resorte of motoresParaAgregar) {
                        await client.query(
                            'INSERT INTO inventario (machine_id, codigo_motor, nombre_producto, precio, stock, capacidad) VALUES ($1, $2, $3, $4, $5, $6)',
                            [targetId, resorte.codigo, '', 0, 0, resorte.capacidad]
                        );
                    }
                }

                if (motoresParaActualizar.length > 0) {
                    for (let resorte of motoresParaActualizar) {
                        await client.query(
                            'UPDATE inventario SET capacidad = $1 WHERE machine_id = $2 AND codigo_motor = $3',
                            [resorte.capacidad, targetId, resorte.codigo]
                        );
                    }
                }
            }
        }
        
        await client.query('COMMIT');
        
        try {
            if (layoutArray && Array.isArray(layoutArray)) {
                const topic = `jaimez/expendedora/${targetId}/comandos`; 
                
                for (const bandeja of layoutArray) {
                    if (bandeja.springs && Array.isArray(bandeja.springs)) {
                        for (const resorte of bandeja.springs) {
                            
                            const codigoMotor = String(resorte.codigo_motor || resorte.code || resorte.motor || resorte.id || '');
                            const precioDelMotor = resorte.precio || resorte.sale_price; 
                            
                            if (codigoMotor && precioDelMotor != null && parseFloat(precioDelMotor) > 0) {
                                const precioFormateado = parseFloat(precioDelMotor).toFixed(2);
                                const comandoMQTT = `EDITAR:${codigoMotor}:${precioFormateado}`;
                                
                                mqttService.publicarMensaje(topic, comandoMQTT);
                                console.log(`Enviando a ESP32 (${targetId}): ${comandoMQTT}`);
                            }
                        }
                    }
                }
            }
        } catch (mqttError) {
            console.error('Error enviando comandos MQTT a la máquina:', mqttError);
        }

        res.json({
            success: true,
            message: 'Máquina y planograma sincronizados automáticamente.',
            data: identidad.decorar(result.rows[0])
        });

    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (error.status) return res.status(error.status).json({ success: false, message: error.message });
        console.error('Error en la sincronización de la máquina:', error);
        res.status(500).json({ success: false, message: 'Fallo en BD: ' + error.message });
    } finally {
        client.release();
    }
};
// === 3. FUNCIÓN CREATE MACHINE (TU CÓDIGO INTACTO Y SEGURO) ===
const createMachine = async (req, res) => {
  try {
    const { name, code, location, brand, model, bill_plate, layout, user_email } = req.body;
    
    // 1. BUSCAMOS EL ID REAL NUMÉRICO DEL USUARIO USANDO SU CORREO
    if (!user_email) {
       return res.status(400).json({ success: false, message: 'No se recibió el correo del usuario.' });
    }

    const userRes = await pool.query('SELECT id FROM usuarios_duenos WHERE email = $1', [user_email]);
    if (userRes.rows.length === 0) {
       return res.status(404).json({ success: false, message: 'Usuario no encontrado en la base de datos.' });
    }
    
    const id_dueno = userRes.rows[0].id;

    // IDENTIDAD: solo el superadmin pone el ID del equipo (equipo_id, o "code" en la app anterior)
    // y el código KMT (region_id -> el siguiente número libre de esa región, o numero_kmt).
    // Si crea la máquina otro usuario, queda con ID provisional PEND-XXXXXX y sin código KMT.
    const equipoPedido = identidad.limpiar(req.body.equipo_id !== undefined ? req.body.equipo_id : code);
    const regionPedida = req.body.region_id;
    let equipo = '';
    let aviso = null;
    let sa = null;
    if (equipoPedido || (regionPedida !== undefined && regionPedida !== null && regionPedida !== '')) {
      sa = await verificarSuperadmin(req);
      if (!sa.ok) {
        aviso = (await mensajeCodigoIgnorado(sa, user_email)) + ' La máquina quedó pendiente de código.';
      } else if (equipoPedido) {
        const problema = identidad.validarEquipo(equipoPedido);
        if (problema) return res.status(400).json({ success: false, message: problema });
        const ocupado = await identidad.equipoOcupado(pool, equipoPedido);
        if (ocupado) return res.status(400).json({ success: false, message: `El equipo ${equipoPedido} ya está vinculado a otra máquina (${ocupado}).` });
        equipo = equipoPedido;
      }
    }
    const machine_id = equipo || await identidad.nuevoEquipoPendiente();
    const safeCode = machine_id;

    // 🔥 BLINDAJE ABSOLUTO DEL JSON 🔥
    let layoutSeguro = '[]';
    if (layout) {
      if (typeof layout === 'string') {
        try {
          layoutSeguro = JSON.stringify(JSON.parse(layout));
        } catch(e) {
          console.log("⚠️ Advertencia: JSON inválido en creación, usando vacío.");
          layoutSeguro = '[]';
        }
      } else {
        layoutSeguro = JSON.stringify(layout);
      }
    }

    // 2. Insertamos la máquina en tu tabla de PostgreSQL
    const insertQuery = `
      INSERT INTO maquinas (
        machine_id, code, name, id_dueno, location, brand, model, bill_plate, layout
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *;
    `;
    
    const values = [
      machine_id,
      safeCode,
      name || 'Nueva Máquina',
      id_dueno, 
      location || '',
      brand || '',
      model || '',
      bill_plate || '',
      layoutSeguro
    ];
    
    const client = await pool.connect();
    let fila, kmt = null;
    try {
      await client.query('BEGIN');
      fila = (await client.query(insertQuery, values)).rows[0];
      // Código KMT en la misma transacción: si el número ya está ocupado, no se crea nada
      if (sa && sa.ok && regionPedida !== undefined && regionPedida !== null && regionPedida !== '') {
        kmt = await identidad.asignarKMT(client, machine_id, regionPedida, req.body.numero_kmt);
        fila = (await client.query('SELECT * FROM maquinas WHERE machine_id = $1', [machine_id])).rows[0];
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    if (kmt) {
      await auditoria.registrar({ usuario: sa.email, accion: 'codigo_kmt_asignado', machine_id,
        detalle: { anterior: null, nuevo: kmt.codigo, al_crear: true } });
      fila.region_nombre = kmt.region.nombre;
    }

    // 3. Le respondemos a React que todo salió perfecto
    const data = identidad.decorar(fila);
    res.status(201).json({
      success: true,
      message: 'Máquina creada exitosamente',
      data,
      ...(aviso ? { codigo_ignorado: true, aviso } : {}),
      ...(!data.equipo_pendiente ? { kymez: await identidad.estadoEnKymez(machine_id) } : {})
    });
    
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message, ...(error.extra || {}) });
    console.error('Error al crear máquina en PostgreSQL:', error);
    if (error.code === '23505') {
      return res.status(400).json({ success: false, message: 'El código o MAC de esta máquina ya está registrado.' });
    }
    res.status(500).json({ success: false, message: 'Fallo en BD: ' + error.message });
  }
};
// === 4. FUNCIÓN PARA ELIMINAR MÁQUINA ===
const deleteMachine = async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        
        await client.query('BEGIN');
        
        // 1. Borramos el historial y el inventario para no dejar datos huérfanos
        await client.query('DELETE FROM historial_ventas WHERE machine_id = $1', [id]);
        await client.query('DELETE FROM inventario WHERE machine_id = $1', [id]);
        
        // 2. Borramos la máquina principal
        const result = await client.query('DELETE FROM maquinas WHERE machine_id = $1 RETURNING *', [id]);
        
        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Máquina no encontrada' });
        }

        await client.query('COMMIT');
        res.json({ success: true, message: 'Máquina eliminada con éxito' });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error eliminando la máquina:', error);
        res.status(500).json({ success: false, message: 'Fallo en BD: ' + error.message });
    } finally {
        client.release();
    }
};
// === 5. FUNCIÓN PARA ACTUALIZAR ESTADO (HABILITAR/DESHABILITAR) ===
const updateMachineSettings = async (req, res) => {
    try {
        const { id } = req.params;
        const activa = !['false', '0', 'no'].includes(String(req.body.pago_al_dia).trim().toLowerCase());
        const conMensaje = await columnaExiste('maquinas', 'mensaje_bloqueo');
        const mensaje = identidad.limpiar(req.body.mensaje_bloqueo).slice(0, 200) || null;
        const r = await pool.query(
            conMensaje
              ? `UPDATE maquinas SET pago_al_dia = $1,
                   mensaje_bloqueo = CASE WHEN $4::boolean THEN NULL ELSE COALESCE($3, mensaje_bloqueo) END,
                   suspendida_en = CASE WHEN $4::boolean THEN NULL ELSE COALESCE(suspendida_en, now()) END
                 WHERE machine_id = $2 RETURNING machine_id`
              : 'UPDATE maquinas SET pago_al_dia = $1 WHERE machine_id = $2 RETURNING machine_id',
            conMensaje ? [activa, id, mensaje, activa] : [activa, id]);
        if (!r.rowCount) return res.status(404).json({ success: false, message: 'Máquina no encontrada' });
        await auditoria.registrar({ usuario: req.superadmin && req.superadmin.email, accion: activa ? 'maquina_reactivada' : 'maquina_suspendida',
            machine_id: id, detalle: { motivo: mensaje } });
        res.json({ success: true, message: 'Estado de la máquina guardado correctamente' });
    } catch (error) {
        console.error('Error guardando ajustes:', error);
        res.status(500).json({ success: false, message: 'Error en BD' });
    }
};
// Recuerda exportarla al final del archivo:
module.exports = {
    getMachines,
    getMachine,
    updateMachine,
    createMachine,
    deleteMachine,
    updateMachineSettings
};