// controllers/machineController.js
const pool = require('../config/database');
const mqttService = require('../services/mqttService'); 

// === 1. FUNCIÓN GET MACHINES (ACTUALIZADA CON MODO DIOS) ===
const getMachines = async (req, res) => {
    try {
        const usuarioSolicitante = req.query.user;

        if (!usuarioSolicitante || usuarioSolicitante === 'desconocido') {
            return res.json([]); 
        }

        console.log(`Buscando máquinas para el usuario: ${usuarioSolicitante}`);

        // Averiguamos el rol del usuario que está consultando
        const userRes = await pool.query('SELECT rol FROM usuarios_duenos WHERE email = $1', [usuarioSolicitante]);
        const userRol = userRes.rows.length > 0 ? userRes.rows[0].rol : 'dueno';

        let query = '';
        let queryParams = [];

        // Base de la consulta: Mantenemos TODAS tus columnas e incluimos owner_email y owner_name para el Frontend
        const baseQuery = `
            SELECT 
                m.machine_id AS id,
                COALESCE(m.name, m.machine_id) AS name, 
                COALESCE(m.code, m.machine_id) AS code,
                COALESCE(m.location, m.ubicacion) AS location,
                m.numero_celular AS phone,
                'online' AS status,
                
                -- Tus candados SAAS
                m.pago_al_dia,
                m.macrodroid_activo,
                
                -- Columnas de React
                m.brand, m.model, m.plate, m.coin_base, m.coin_current,
                m.coin_brand, m.coin_plate, m.bill_enabled, m.bill_brand,
                m.bill_model, m.bill_plate, m.layout,
                
                -- Datos para el MODO SOPORTE (La insignia de Lovable)
                u.email AS owner_email,
                u.nombre AS owner_name
                
            FROM maquinas m
            LEFT JOIN usuarios_duenos u ON m.id_dueno::text = u.id::text
        `;

        // Aplicamos la lógica según el rol
        if (userRol === 'superadmin') {
            // MODO DIOS: Trae TODAS las máquinas
            query = baseQuery + ' ORDER BY u.email, m.name;';
        } else {
            // MODO CLIENTE: Trae solo sus máquinas
            query = baseQuery + ' WHERE u.email = $1;';
            queryParams = [usuarioSolicitante];
        }

        const resultado = await pool.query(query, queryParams);

        // Devolvemos el arreglo de máquinas al frontend
        res.json(resultado.rows);
    } catch (error) {
        console.error("Error obteniendo máquinas:", error);
        res.status(500).json({ success: false, message: "Error del servidor" });
    }
};

// === 2. FUNCIÓN UPDATE MACHINE (TU CÓDIGO INTACTO Y SEGURO) ===
const updateMachine = async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const { name, code, location, brand, model, bill_plate, layout } = req.body;

        // 🔥 BLINDAJE ABSOLUTO DEL JSON: Limpiamos y aseguramos el formato para PostgreSQL
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

        await client.query('BEGIN'); // 1. Iniciamos la transacción

        // === 1. AUTO-REPARACIÓN DE LA BASE DE DATOS ===
        if (code && id !== code) {
            await client.query('UPDATE maquinas SET code = $1 WHERE machine_id = $2', [`temp_${id}`, id]);
            
            await client.query(`
                INSERT INTO maquinas (
                    machine_id, code, id_dueno, name, location, brand, model, plate,
                    coin_base, coin_current, coin_brand, coin_plate, bill_enabled,
                    bill_brand, bill_model, bill_plate, layout, ubicacion,
                    pasarela_tipo, numero_celular, dispense_pending,
                    fecha_instalacion, ultimo_cliente
                )
                SELECT 
                    $1, $1, id_dueno, name, location, brand, model, plate,
                    coin_base, coin_current, coin_brand, coin_plate, bill_enabled,
                    bill_brand, bill_model, bill_plate, layout, ubicacion,
                    pasarela_tipo, numero_celular, dispense_pending,
                    fecha_instalacion, ultimo_cliente
                FROM maquinas WHERE machine_id = $2
            `, [code, id]);
            
            await client.query('UPDATE inventario SET machine_id = $1 WHERE machine_id = $2', [code, id]);
            await client.query('UPDATE historial_ventas SET machine_id = $1 WHERE machine_id = $2', [code, id]);
            await client.query('DELETE FROM maquinas WHERE machine_id = $1', [id]);
        }

        const targetId = code || id;

        // === 2. ACTUALIZACIÓN DE DATOS (Layout y datos de la máquina) ===
        const updateQuery = `
            UPDATE maquinas 
            SET name = $1, code = $2, location = $3, brand = $4, model = $5, bill_plate = $6, layout = $7 
            WHERE machine_id = $8 
            RETURNING *
        `;
        // 🔥 Usamos layoutSeguro en lugar de la variable cruda
        const values = [name, code, location, brand, model, bill_plate, layoutSeguro, targetId];
        const result = await client.query(updateQuery, values);

        // === 3. SINCRONIZACIÓN MÁGICA CON EL INVENTARIO ===
        let layoutArray = JSON.parse(layoutSeguro);
        if (typeof layout === 'string') {
            try { layoutArray = JSON.parse(layout); } catch(e) { console.log("No se pudo parsear el layout"); }
        }

        if (layoutArray && Array.isArray(layoutArray)) {
            let motoresEnEditor = [];
            layoutArray.forEach(bandeja => {
                if (bandeja.springs && Array.isArray(bandeja.springs)) {
                    bandeja.springs.forEach(resorte => {
                        const codigo = String(resorte.id || resorte.code || resorte.motor || '');
                        
                        // 🔥 MEJORA 1: Extraemos solo el número.
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

                // B) Eliminamos resortes antiguos
                if (motoresParaEliminar.length > 0) {
                    await client.query(
                        'DELETE FROM inventario WHERE machine_id = $1 AND codigo_motor = ANY ($2)',
                        [targetId, motoresParaEliminar]
                    );
                }

                // C) Agregamos nuevos con la capacidad detectada
                if (motoresParaAgregar.length > 0) {
                    for (let resorte of motoresParaAgregar) {
                        await client.query(
                            'INSERT INTO inventario (machine_id, codigo_motor, nombre_producto, precio, stock, capacidad) VALUES ($1, $2, $3, $4, $5, $6)',
                            [targetId, resorte.codigo, '', 0, 0, resorte.capacidad]
                        );
                    }
                }

                // D) 🔥 MEJORA 2: Actualizamos capacidad
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
        
        // <-- AQUI EMPIEZA LO NUEVO QUE ESTAMOS AGREGANDO ->
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
            data: result.rows[0] 
        });

    } catch (error) {
        await client.query('ROLLBACK'); 
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
    const machine_id = code || `TEMP_${Date.now()}`;
    const safeCode = code || machine_id;

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
    
    const result = await pool.query(insertQuery, values);
    
    // 3. Le respondemos a React que todo salió perfecto
    res.status(201).json({
      success: true,
      message: 'Máquina creada exitosamente',
      data: result.rows[0]
    });
    
  } catch (error) {
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
// Recuerda exportarla al final del archivo:
module.exports = {
    getMachines,
    updateMachine,
    createMachine,
    deleteMachine
};