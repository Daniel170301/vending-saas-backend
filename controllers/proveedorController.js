// controllers/proveedorController.js
const pool = require('../config/database');

// === 1. OBTENER PROVEEDORES ===
const getProveedores = async (req, res) => {
    try {
        const usuarioSolicitante = req.query.user || req.query.email;

        if (!usuarioSolicitante || usuarioSolicitante === 'desconocido') {
            return res.json([]); 
        }

        // Verificamos el rol del usuario
        const userRes = await pool.query('SELECT id, rol FROM usuarios_duenos WHERE email = $1', [usuarioSolicitante]);
        if (userRes.rows.length === 0) return res.json([]);
        
        const user = userRes.rows[0];

        let query = '';
        let queryParams = [];

        if (user.rol === 'superadmin') {
            // MODO DIOS: Ve todos
            query = `SELECT p.* FROM proveedores p ORDER BY p.id DESC;`;
        } else {
            // MODO CLIENTE: Ve solo los suyos
            query = `
                SELECT p.* FROM proveedores p
                JOIN usuarios_duenos u ON p.id_usuario = u.id
                WHERE u.email = $1 ORDER BY p.id DESC;
            `;
            queryParams = [usuarioSolicitante];
        }

        const result = await pool.query(query, queryParams);
        res.json(result.rows);

    } catch (error) {
        console.error('Error al obtener proveedores:', error);
        res.status(500).json({ success: false, message: 'Error en BD' });
    }
};

// === 2. CREAR PROVEEDOR ===
const createProveedor = async (req, res) => {
    try {
        const {
            nombre_o_razon_social, empresa_tienda, tipo_documento,
            numero_documento, telefono, correo_electronico, direccion, notas, user_email
        } = req.body;

        let id_usuario = null;

        // Buscamos el ID del usuario usando su correo
        if (user_email) {
            const userRes = await pool.query('SELECT id FROM usuarios_duenos WHERE email = $1', [user_email]);
            if (userRes.rows.length > 0) {
                id_usuario = userRes.rows[0].id;
            }
        }

        const query = `
            INSERT INTO proveedores 
            (nombre_o_razon_social, empresa_tienda, tipo_documento, numero_documento, telefono, correo_electronico, direccion, notas, id_usuario)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *;
        `;

        const values = [
            nombre_o_razon_social, empresa_tienda || '', tipo_documento || 'DNI',
            numero_documento || '', telefono || '', correo_electronico || '',
            direccion || '', notas || '', id_usuario
        ];

        const result = await pool.query(query, values);
        res.status(201).json({ success: true, message: 'Proveedor creado con éxito', data: result.rows[0] });

    } catch (error) {
        console.error('Error al crear proveedor:', error);
        res.status(500).json({ success: false, message: 'Fallo en BD: ' + error.message });
    }
};
// === 3. ELIMINAR PROVEEDOR ===
const deleteProveedor = async (req, res) => {
    try {
        const { id } = req.params;
        
        console.log(`🗑️ Intentando eliminar proveedor con ID: ${id}`);
        
        const result = await pool.query(
            'DELETE FROM proveedores WHERE id = $1 RETURNING *',
            [id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Proveedor no encontrado' });
        }

        res.json({ success: true, message: 'Proveedor eliminado con éxito' });
    } catch (error) {
        console.error('Error al eliminar proveedor:', error);
        res.status(500).json({ success: false, message: 'Error en BD al eliminar: ' + error.message });
    }
};
module.exports = {
    getProveedores,
    createProveedor,
    deleteProveedor
};