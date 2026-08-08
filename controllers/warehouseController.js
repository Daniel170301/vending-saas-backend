// controllers/warehouseController.js
const pool = require('../config/database'); // ⚠️ Asegúrate de que esta ruta apunte a tu archivo de conexión PostgreSQL

const obtenerAlmacen = async (req, res) => {
    try {
        // Atrapamos el correo de Supabase sin importar el nombre de la variable que use Lovable
        const user_id = req.query.user_id || req.query.user || req.query.email; 

        let query = 'SELECT * FROM productos_almacen';
        let values = [];

        // Filtramos por el correo del usuario (id_dueno) asegurando que sea texto (::text)
        if (user_id) {
            query += ' WHERE id_dueno::text = $1 ORDER BY id DESC';
            values.push(user_id);
            console.log(`Buscando productos de almacén para el usuario: ${user_id}`);
        } else {
            query += ' ORDER BY id DESC'; 
            console.log(`Obteniendo todos los productos (sin filtrar usuario)`);
        }

        const result = await pool.query(query, values);
        
        // EL CAMBIO MÁGICO: Devolvemos la lista DIRECTAMENTE para que Lovable la pinte
        res.json(result.rows);
        
    } catch (error) {
        console.error('Error al obtener el almacén:', error);
        res.status(500).json({ success: false, message: 'Error en el servidor' });
    }
};

const crearProductoAlmacen = async (req, res) => {
    try {
        const { 
            name, category, subcategory, unit_cost, 
            sale_price, stock_warehouse, capacidad, unit_type, id_dueno,
            barcode, image_url, min_stock // <-- AÑADIDOS AQUÍ
        } = req.body;

        const query = `
            INSERT INTO productos_almacen 
            (name, category, subcategory, unit_cost, sale_price, stock_warehouse, capacidad, unit_type, id_dueno, barcode, image_url, min_stock) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
            RETURNING *;
        `;
        
        const values = [
            name, category || null, subcategory || null, 
            unit_cost || 0, sale_price || 0, stock_warehouse || 0, 
            capacidad || 10, unit_type || 'unidad', id_dueno || null,
            barcode || null, image_url || null, min_stock || 0 // <-- AÑADIDOS AQUÍ
        ];

        const result = await pool.query(query, values);

        res.json({
            success: true,
            producto: result.rows[0],
            message: 'Producto guardado correctamente'
        });
    } catch (error) {
        console.error('Error al guardar el producto:', error);
        res.status(500).json({ success: false, message: 'Error al guardar en la base de datos' });
    }
};

// NUEVO: Función para editar todos los detalles de un producto (CON SINCRONIZACIÓN)
const editarProductoAlmacen = async (req, res) => {
    try {
        const { id } = req.params;
        const { 
            name, category, subcategory, unit_cost, 
            sale_price, stock_warehouse, capacidad, unit_type,
            barcode, image_url, min_stock 
        } = req.body;

        const query = `
            UPDATE productos_almacen 
            SET name = $1, category = $2, subcategory = $3, unit_cost = $4, 
                sale_price = $5, stock_warehouse = $6, capacidad = $7, unit_type = $8,
                barcode = $9, image_url = $10, min_stock = $11
            WHERE id = $12
            RETURNING *;
        `;
        
        const values = [
            name, category || null, subcategory || null, 
            unit_cost || 0, sale_price || 0, stock_warehouse || 0, 
            capacidad || 10, unit_type || 'unidad', 
            barcode || null, image_url || null, min_stock || 0, 
            id
        ];

        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Producto no encontrado' });
        }

        // ==========================================
        // 🔮 MAGIA DE SINCRONIZACIÓN DE PRECIOS
        // ==========================================
        try {
            const precioFormateado = parseFloat(sale_price || 0).toFixed(2);
            // Actualizamos TODAS las máquinas que tengan este mismo producto
            await pool.query(
                'UPDATE inventario SET precio = $1 WHERE nombre_producto = $2',
                [precioFormateado, name]
            );
            console.log(`Precios sincronizados a S/ ${precioFormateado} para el producto: ${name}`);
        } catch (syncError) {
            console.error('Error sincronizando el precio con las máquinas:', syncError);
            // No detenemos la ejecución, el error de sincronización se registra pero la edición principal fue exitosa
        }
        // ==========================================

        res.json({
            success: true,
            producto: result.rows[0],
            message: 'Producto actualizado y sincronizado en todas las máquinas'
        });
    } catch (error) {
        console.error('Error al actualizar el producto:', error);
        res.status(500).json({ success: false, message: 'Error al actualizar en la base de datos' });
    }
};

// NUEVO: Función para actualizar únicamente el stock (cuando se manda a la máquina)
const actualizarStock = async (req, res) => {
    try {
        const { id } = req.params;
        const { stock_warehouse } = req.body;

        const query = `
            UPDATE productos_almacen 
            SET stock_warehouse = $1
            WHERE id = $2
            RETURNING *;
        `;
        
        const values = [stock_warehouse, id];

        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Producto no encontrado' });
        }

        res.json({
            success: true,
            producto: result.rows[0],
            message: 'Stock de bodega descontado correctamente'
        });
    } catch (error) {
        console.error('Error al actualizar el stock:', error);
        res.status(500).json({ success: false, message: 'Error al actualizar el stock' });
    }
};

module.exports = {
    obtenerAlmacen,
    crearProductoAlmacen,
    editarProductoAlmacen, 
    actualizarStock        
};