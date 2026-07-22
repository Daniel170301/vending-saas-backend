// controllers/warehouseController.js
const pool = require('../config/database'); // ⚠️ Asegúrate de que esta ruta apunte a tu archivo de conexión PostgreSQL

const obtenerAlmacen = async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM productos_almacen ORDER BY id DESC');
        res.json({
            success: true,
            productos: result.rows
        });
    } catch (error) {
        console.error('Error al obtener el almacén:', error);
        res.status(500).json({ success: false, message: 'Error en el servidor' });
    }
};

const crearProductoAlmacen = async (req, res) => {
    try {
        const { 
            name, category, subcategory, unit_cost, 
            sale_price, stock_warehouse, capacidad, unit_type, id_dueno 
        } = req.body;

        const query = `
            INSERT INTO productos_almacen 
            (name, category, subcategory, unit_cost, sale_price, stock_warehouse, capacidad, unit_type, id_dueno) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
            RETURNING *;
        `;
        
        const values = [
            name, category || null, subcategory || null, 
            unit_cost || 0, sale_price || 0, stock_warehouse || 0, 
            capacidad || 10, unit_type || 'unidad', id_dueno || null
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
// NUEVO: Función para editar todos los detalles de un producto
const editarProductoAlmacen = async (req, res) => {
    try {
        const { id } = req.params;
        const { 
            name, category, subcategory, unit_cost, 
            sale_price, stock_warehouse, capacidad, unit_type 
        } = req.body;

        const query = `
            UPDATE productos_almacen 
            SET name = $1, category = $2, subcategory = $3, unit_cost = $4, 
                sale_price = $5, stock_warehouse = $6, capacidad = $7, unit_type = $8
            WHERE id = $9
            RETURNING *;
        `;
        
        const values = [
            name, category || null, subcategory || null, 
            unit_cost || 0, sale_price || 0, stock_warehouse || 0, 
            capacidad || 10, unit_type || 'unidad', id
        ];

        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Producto no encontrado' });
        }

        res.json({
            success: true,
            producto: result.rows[0],
            message: 'Producto actualizado correctamente'
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
    editarProductoAlmacen, // ¡No olvides exportarla!
    actualizarStock        // ¡No olvides exportarla!
};