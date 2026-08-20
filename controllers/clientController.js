// controllers/clientController.js
const pool = require('../config/database');

// 1. Obtener lista de Usuarios (Dueños) para el selector del formulario
const getUsers = async (req, res) => {
    try {
        const result = await pool.query("SELECT id, nombre, email FROM usuarios_duenos WHERE rol != 'superadmin' ORDER BY nombre ASC");
        res.json({ success: true, usuarios: result.rows });
    } catch (error) {
        console.error('Error al obtener usuarios:', error);
        res.status(500).json({ success: false, message: 'Error en BD' });
    }
};

// 2. Crear un nuevo Cliente (Negocio) amarrado a un Usuario
const createClient = async (req, res) => {
    try {
        const { 
            id_usuario, razon_social, nombre_comercial, tipo_documento, 
            numero_documento, telefono, email_contacto, direccion, notas 
        } = req.body;

        if (!id_usuario || !razon_social) {
            return res.status(400).json({ success: false, message: 'El usuario y la razón social son obligatorios' });
        }

        const query = `
            INSERT INTO empresas_clientes 
            (id_usuario, razon_social, nombre_comercial, tipo_documento, numero_documento, telefono, email_contacto, direccion, notas) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
            RETURNING *;
        `;
        const values = [id_usuario, razon_social, nombre_comercial, tipo_documento, numero_documento, telefono, email_contacto, direccion, notas];
        
        const result = await pool.query(query, values);
        res.json({ success: true, message: 'Negocio creado con éxito', cliente: result.rows[0] });

    } catch (error) {
        console.error('Error creando cliente:', error);
        res.status(500).json({ success: false, message: 'Error interno en BD' });
    }
};

// 3. Obtener todos los Negocios para mostrar en la Tabla
const getClients = async (req, res) => {
    try {
        // Hacemos un JOIN para que la tabla muestre el correo del dueño principal
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

// 4. Cambiar el estado del Negocio (Habilitado/Suspendido)
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

module.exports = {
    getUsers,
    createClient,
    getClients,
    updateClientStatus
};