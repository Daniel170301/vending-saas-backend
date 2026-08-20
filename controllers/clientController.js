// controllers/clientController.js
const pool = require('../config/database');

// 1. Crear Cliente (Crea el Usuario y el Negocio al mismo tiempo)
const createClient = async (req, res) => {
    const client = await pool.connect();
    try {
        const { 
            nombre_razon_social, 
            empresa_tienda, 
            tipo_documento, 
            numero_documento, 
            telefono, 
            correo_electronico, 
            direccion, 
            notas 
        } = req.body;

        if (!nombre_razon_social || !correo_electronico) {
            return res.status(400).json({ success: false, message: 'El nombre y el correo son obligatorios' });
        }

        await client.query('BEGIN');

        // A. Buscamos si el correo ya existe en usuarios_duenos
        let id_usuario;
        const checkUser = await client.query('SELECT id FROM usuarios_duenos WHERE email = $1', [correo_electronico]);
        
        if (checkUser.rows.length > 0) {
            // Si el correo ya existe, reciclamos ese ID para asignarle este nuevo negocio
            id_usuario = checkUser.rows[0].id; 
        } else {
            // Si no existe, creamos la cuenta de acceso nueva
            const defaultPassword = numero_documento || 'QhaPay2026'; // Contraseña por defecto
            const newUser = await client.query(`
                INSERT INTO usuarios_duenos (nombre, email, password, rol) 
                VALUES ($1, $2, $3, 'cliente') 
                RETURNING id;
            `, [nombre_razon_social, correo_electronico, defaultPassword]);
            
            id_usuario = newUser.rows[0].id;
        }

        // B. Creamos el Negocio en empresas_clientes y lo enlazamos al id_usuario
        const newBusiness = await client.query(`
            INSERT INTO empresas_clientes 
            (id_usuario, razon_social, nombre_comercial, tipo_documento, numero_documento, telefono, email_contacto, direccion, notas) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
            RETURNING *;
        `, [id_usuario, nombre_razon_social, empresa_tienda, tipo_documento, numero_documento, telefono, correo_electronico, direccion, notas]);

        await client.query('COMMIT');
        res.json({ success: true, message: 'Cliente registrado con éxito', cliente: newBusiness.rows[0] });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creando cliente:', error);
        res.status(500).json({ success: false, message: 'Error interno en BD' });
    } finally {
        client.release();
    }
};

// 2. Obtener todos los Negocios para la Tabla
const getClients = async (req, res) => {
    try {
        const query = `
            SELECT c.*, u.email as email_dueno, u.nombre as nombre_dueno
            FROM empresas_clientes c
            JOIN usuarios_duenos u ON c.id_usuario = u.id
            ORDER BY c.id DESC;
        `;
        const result = await pool.query(query);
        res.json({ success: true, clientes: result.rows, data: result.rows });
    } catch (error) {
        console.error('Error al obtener clientes:', error);
        res.status(500).json({ success: false, message: 'Error en BD' });
    }
};

// 3. Cambiar el estado del Negocio (Habilitado/Suspendido)
const updateClientStatus = async (req, res) => {
    try {
        const { id } = req.params; 
        const { estado } = req.body; 

        await pool.query(
            'UPDATE empresas_clientes SET estado = $1 WHERE id = $2',
            [estado, id]
        );

        res.json({ success: true, message: 'Estado actualizado correctamente' });
    } catch (error) {
        console.error('Error actualizando estado:', error);
        res.status(500).json({ success: false, message: 'Error en BD' });
    }
};
// === ELIMINAR CLIENTE ===
const deleteClient = async (req, res) => {
    try {
        const { id } = req.params;
        
        console.log(`🗑️ Intentando eliminar cliente con ID: ${id}`);
        
        // Usamos empresas_clientes porque es la tabla que creaste en DBeaver
        const result = await pool.query(
            'DELETE FROM empresas_clientes WHERE id = $1 RETURNING *',
            [id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Cliente no encontrado' });
        }

        res.json({ success: true, message: 'Cliente eliminado con éxito' });
    } catch (error) {
        console.error('Error al eliminar cliente:', error);
        res.status(500).json({ success: false, message: 'Error en BD al eliminar: ' + error.message });
    }
};

module.exports = {
    createClient,
    getClients,
    updateClientStatus,
    deleteClient // <-- Cambiado a inglés para que coincida con tus rutas
};