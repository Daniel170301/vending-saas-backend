// controllers/machineController.js
const pool = require('../config/database');
const mqttService = require('../services/mqttService'); // <-- AÑADE ESTA LÍNEA
const getMachines = async (req, res) => {
    try {
        const usuarioSolicitante = req.query.user;

        if (!usuarioSolicitante || usuarioSolicitante === 'desconocido') {
            return res.json([]); // Si no hay usuario, devolvemos un arreglo vacío
        }

        console.log(`Buscando máquinas para el usuario: ${usuarioSolicitante}`);

        // Consulta SQL con el JOIN seguro para relacionar el ID numérico con el email de Supabase
        const query = `
            SELECT 
                m.machine_id AS id,
                COALESCE(m.name, m.machine_id) AS name, 
                COALESCE(m.code, m.machine_id) AS code,
                COALESCE(m.location, m.ubicacion) AS location,
                m.numero_celular AS phone,
                'online' AS status,
                
                -- === TUS NUEVOS CANDADOS SAAS ===
                m.pago_al_dia,
                m.macrodroid_activo,
                
                -- Agregamos TODAS las columnas nuevas que necesita React
                m.brand,
                m.model,
                m.plate,
                m.coin_base,
                m.coin_current,
                m.coin_brand,
                m.coin_plate,
                m.bill_enabled,
                m.bill_brand,
                m.bill_model,
                m.bill_plate,
                m.layout
            FROM maquinas m
            JOIN usuarios_duenos u ON m.id_dueno::text = u.id::text
            WHERE u.email = $1;
        `;

        const resultado = await pool.query(query, [usuarioSolicitante]);

        // Devolvemos el arreglo de máquinas al frontend
        res.json(resultado.rows);
    } catch (error) {
        console.error("Error obteniendo máquinas:", error);
        res.status(500).json({ success: false, message: "Error del servidor" });
    }
};
const updateMachine = async (req, res) => {
    const client = await pool.connect();
    
    try {
        const { id } = req.params;
        const { name, code, location, brand, model, bill_plate, layout } = req.body;
        
        await client.query('BEGIN'); // 1. Iniciamos la transacción

        // === AUTO-REPARACIÓN DE LA BASE DE DATOS ===
        if (code && id !== code) {
            await client.query('UPDATE maquinas SET code = $1 WHERE machine_id = $2', [`temp_${id}`, id]);
            
            await client.query(`
                INSERT INTO maquinas (
                    machine_id, code, id_dueno, name, location, brand, model, plate, 
                    coin_base, coin_current, coin_brand, coin_plate, bill_enabled, 
                    bill_brand, bill_model, bill_plate, layout, ubicacion, 
                    pasarela_tipo, numero_celular, dispense_pending, fecha_instalacion, ultimo_cliente
                )
                SELECT 
                    $1, $1, id_dueno, name, location, brand, model, plate, 
                    coin_base, coin_current, coin_brand, coin_plate, bill_enabled, 
                    bill_brand, bill_model, bill_plate, layout, ubicacion, 
                    pasarela_tipo, numero_celular, dispense_pending, fecha_instalacion, ultimo_cliente
                FROM maquinas WHERE machine_id = $2
            `, [code, id]);
            
            await client.query('UPDATE inventario SET machine_id = $1 WHERE machine_id = $2', [code, id]);
            await client.query('UPDATE historial_ventas SET machine_id = $1 WHERE machine_id = $2', [code, id]);
            await client.query('DELETE FROM maquinas WHERE machine_id = $1', [id]);
        }

        const targetId = code || id;
        
        // === 2. ACTUALIZACIÓN DE DATOS (Layout y datos de la máquina) ===
        // Aquí pasamos el layout tal cual viene para que se guarde en la máquina
        const updateQuery = `
            UPDATE maquinas 
            SET name = $1, code = $2, location = $3, brand = $4, model = $5, bill_plate = $6, layout = $7
            WHERE machine_id = $8
            RETURNING *;
        `;
        const values = [name, code, location, brand, model, bill_plate, layout, targetId];
        const result = await client.query(updateQuery, values);

        // === 3. SINCRONIZACIÓN MÁGICA CON EL INVENTARIO ===
        
        // A) BLINDAJE: Si React nos mandó el layout como texto, lo convertimos a objeto JSON real
        let layoutArray = layout;
        if (typeof layout === 'string') {
            try { layoutArray = JSON.parse(layout); } catch(e) { console.log("No se pudo parsear el layout"); }
        }

        if (layoutArray && Array.isArray(layoutArray)) {
            let motoresEnEditor = [];

            layoutArray.forEach(bandeja => {
                if (bandeja.springs && Array.isArray(bandeja.springs)) {
                    bandeja.springs.forEach(resorte => {
                        const codigo = String(resorte.id || resorte.code || resorte.motor || '');
                        const capacidad = resorte.capacity || resorte.capacidad || 10;
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

                // B) Eliminamos resortes antiguos (con corrección de sintaxis PostgreSQL)
                if (motoresParaEliminar.length > 0) {
                    await client.query(
                        'DELETE FROM inventario WHERE machine_id = $1 AND codigo_motor = ANY($2)',
                        [targetId, motoresParaEliminar]
                    );
                }

                // C) Agregamos nuevos
                if (motoresParaAgregar.length > 0) {
                    for (let resorte of motoresParaAgregar) {
                        await client.query(
                            'INSERT INTO inventario (machine_id, codigo_motor, nombre_producto, precio, stock, capacidad) VALUES ($1, $2, $3, $4, $5, $6)',
                            [targetId, resorte.codigo, '', 0, 0, resorte.capacidad]
                        );
                    }
                }
                
                // D) Actualizamos capacidad
                for (let resorte of motoresParaActualizar) {
                    await client.query(
                        'UPDATE inventario SET capacidad = $1 WHERE machine_id = $2 AND codigo_motor = $3',
                        [resorte.capacidad, targetId, resorte.codigo]
                    );
                }
            }
        }

        await client.query('COMMIT'); 
        

        // =========================================================
        // <-- 2. AQUI EMPIEZA LO NUEVO QUE ESTAMOS AGREGANDO -->
        // =========================================================
        try {
            if (layout && Array.isArray(layout)) {
                const topic = `jaimez/expendedora/${targetId}/comandos`; 
                
                for (const bandeja of layout) {
                    if (bandeja.springs && Array.isArray(bandeja.springs)) {
                        for (const resorte of bandeja.springs) {
                            // Toma el precio del resorte (revisa si Lovable te lo manda como precio o sale_price)
                            const precioDelMotor = resorte.precio || resorte.sale_price; 
                            
                            // Si el motor existe y tiene un precio asignado, lo enviamos
                            if (resorte.codigo_motor && precioDelMotor != null && parseFloat(precioDelMotor) > 0) {
                                const precioFormateado = parseFloat(precioDelMotor).toFixed(2);
                                const comandoMQTT = `EDITAR:${resorte.codigo_motor}:${precioFormateado}`;
                                
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
        // =========================================================
        // <-- AQUI TERMINA LO NUEVO -->
        // =========================================================


        res.json({ 
            success: true, 
            message: 'Máquina y planograma sincronizados automáticamente.', 
            data: result.rows[0] 
        });

    } catch (error) {
        await client.query('ROLLBACK'); 
        console.error('Error en la sincronización de la máquina:', error);
        
        // ¡EL TRUCO! Le mandamos a tu celular el texto real del error de la base de datos
        res.status(500).json({ success: false, message: 'Fallo en BD: ' + error.message });
    } finally {
        client.release();
    }
};


const createMachine = async (req, res) => {
    try {
        const { name, code, location, brand, model, bill_plate, layout, user_email } = req.body;
        
        // 1. ELIMINAMOS LA BÚSQUEDA LOCAL 
        // Como Supabase ya validó que el usuario existe para dejarlo entrar a Lovable,
        // simplemente asignamos el correo (o ID de Supabase) directamente como dueño.
        const id_dueno = user_email; 
        
        // Según tu SQL, 'machine_id' y 'code' suelen ser la MAC. Usaremos el code para ambos.
        const machine_id = code; 

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
            code, 
            name, 
            id_dueno, // <-- Aquí insertamos el correo de Supabase directamente
            location, 
            brand, 
            model, 
            bill_plate, 
            layout 
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
        
        // Manejo de error si el cliente intenta registrar una MAC que ya existe
        if (error.code === '23505') { 
            return res.status(400).json({ success: false, message: 'El código o MAC de esta máquina ya está registrado.' });
        }

        res.status(500).json({ success: false, message: 'Error interno del servidor' });
    }
};
// Recuerda exportarla al final del archivo:
module.exports = {
    getMachines,
    updateMachine, // <-- Agrega esto
    createMachine
};
