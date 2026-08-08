// controllers/machineController.js
const pool = require('../config/database');

const getMachines = async (req, res) => {
    try {
        const usuarioSolicitante = req.query.user;

        if (!usuarioSolicitante || usuarioSolicitante === 'desconocido') {
            return res.json([]); // Si no hay usuario, devolvemos un arreglo vacío
        }

        console.log(`Buscando máquinas para el usuario: ${usuarioSolicitante}`);

        // Consulta SQL directa sin necesidad de hacer JOIN, buscando por el email del dueño
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
            WHERE m.id_dueno = $1;
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
    // Obtenemos un cliente exclusivo de la base de datos para hacer una Transacción
    const client = await pool.connect();
    
    try {
        const { id } = req.params; // El ID que manda React (ej: 's')
        const { name, code, location, brand, model, bill_plate, layout } = req.body;
        
        await client.query('BEGIN'); // 1. Iniciamos la transacción (Si algo falla, no se guarda nada)

        // === AUTO-REPARACIÓN DE LA BASE DE DATOS ===
        // Si el ID de la URL ('s') es distinto a la MAC real que envías en el code:
        if (code && id !== code) {
            
            // A. Cambiamos el código de la máquina vieja temporalmente para que no choque el UNIQUE
            await client.query('UPDATE maquinas SET code = $1 WHERE machine_id = $2', [`temp_${id}`, id]);
            
            // B. Clonamos la máquina, pero esta vez con el machine_id correcto (la MAC real)
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
            
            // C. Movemos los productos y las ventas hacia el nuevo machine_id correcto
            await client.query('UPDATE inventario SET machine_id = $1 WHERE machine_id = $2', [code, id]);
            await client.query('UPDATE historial_ventas SET machine_id = $1 WHERE machine_id = $2', [code, id]);
            
            // D. Destruimos la máquina defectuosa (la letra 's') que ya quedó vacía
            await client.query('DELETE FROM maquinas WHERE machine_id = $1', [id]);
        }

        // === ACTUALIZACIÓN DE DATOS (Lo que el usuario editó en la pantalla) ===
        const targetId = code || id;
        
        const updateQuery = `
            UPDATE maquinas 
            SET name = $1, code = $2, location = $3, brand = $4, model = $5, bill_plate = $6, layout = $7
            WHERE machine_id = $8
            RETURNING *;
        `;
        
        const values = [name, code, location, brand, model, bill_plate, layout, targetId];
        const result = await client.query(updateQuery, values);

        await client.query('COMMIT'); // 2. Guardamos todos los cambios de golpe
        
        res.json({ 
            success: true, 
            message: 'Máquina guardada y reparada automáticamente.', 
            data: result.rows[0] 
        });

    } catch (error) {
        await client.query('ROLLBACK'); // Si ocurre un error, cancelamos todo para no romper la BD
        console.error('Error en la auto-reparación de la máquina:', error);
        res.status(500).json({ success: false, message: 'Error interno al actualizar.' });
    } finally {
        client.release(); // 3. Devolvemos el cliente al servidor
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
