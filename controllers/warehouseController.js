// controllers/warehouseController.js
const pool = require('../config/database'); 
const mqttService = require('../services/mqttService');

// 1. OBTENER INVENTARIO (ACTUALIZADO CON MODO DIOS)
const obtenerAlmacen = async (req, res) => {
 try {
 const user_id = req.query.user_id || req.query.user || req.query.email;
 
 console.log(`🔍 Solicitando inventario de almacén para:`, user_id);

 // 1. Averiguar el rol del usuario que está consultando
 let userRol = 'dueno';
 if (user_id) {
   const userRes = await pool.query('SELECT rol FROM usuarios_duenos WHERE email = $1', [user_id]);
   if (userRes.rows.length > 0) {
     userRol = userRes.rows[0].rol;
   }
 }

let query = `
   SELECT p.*, u.email AS owner_email 
   FROM productos_almacen p
   LEFT JOIN usuarios_duenos u ON p.id_dueno::text = u.id::text
 `;
 let values = [];

// 2. Aplicar la lógica de filtrado estricto por usuario
    if (userRol === 'superadmin') {
        console.log(`Superadmin accediendo a todo el almacén global.`);
        // El superadmin no lleva WHERE, ve todo
    } else if (user_id) {
        // CAMBIO AQUÍ: Quitamos el "OR p.id_dueno IS NULL" para que solo vea lo suyo
        query += ` WHERE (u.email::text = $1 OR p.id_dueno::text = $1)`;
        values.push(String(user_id));
    } else {
        // Si no hay usuario identificado, no devolvemos nada por seguridad
        query += ` WHERE 1 = 0`; 
    }

 query += ' ORDER BY p.id DESC';
 const result = await pool.query(query, values);
 
 console.log(`📦 Productos encontrados en almacén: ${result.rowCount}`);
 
 res.json({
   success: true,
   productos: result.rows,
   data: result.rows,
   ...result.rows 
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
            sale_price, stock_warehouse, capacidad, unit_type,
            id_dueno, user_email, // Añadimos user_email por si el frontend lo manda así
            barcode, image_url, min_stock 
        } = req.body;

        let finalIdDueno = id_dueno;

        // Si nos pasan el correo en lugar del ID numérico, lo buscamos
        if (!finalIdDueno && user_email) {
            const userRes = await pool.query('SELECT id FROM usuarios_duenos WHERE email = $1', [user_email]);
            if (userRes.rows.length > 0) {
                finalIdDueno = userRes.rows[0].id;
            }
        }
 const query = `
            INSERT INTO productos_almacen
            (name, category, subcategory, unit_cost, sale_price,
            stock_warehouse, capacidad, unit_type, id_dueno, barcode, image_url, min_stock)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING *;
        `;
 
const values = [
            name, category || null, subcategory || null,
            unit_cost || 0, sale_price || 0, stock_warehouse || 0,
            capacidad || 10, unit_type || 'unidad', finalIdDueno || null,
            barcode || null, image_url || null, min_stock || 0 
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

 try {
 const precioFormateado = parseFloat(sale_price || 0).toFixed(2);
 
 await pool.query(
 'UPDATE inventario SET precio = $1 WHERE nombre_producto = $2',
 [precioFormateado, name]
 );
 console.log(`Precios sincronizados en BD a S/ ${precioFormateado} para el producto: ${name}`);

 const maquinasAfectadas = await pool.query(
 'SELECT machine_id, codigo_motor FROM inventario WHERE nombre_producto = $1',
 [name]
 );

 for (let maq of maquinasAfectadas.rows) {
 const topic = `jaimez/expendedora/${maq.machine_id}/comandos`;
 const comandoMQTT = `EDITAR:${maq.codigo_motor}:${precioFormateado}`;
 mqttService.publicarMensaje(topic, comandoMQTT);
 console.log(`📡 Enviando a ESP32 (${maq.machine_id}): ${comandoMQTT}`);
 }
 } catch (syncError) {
 console.error('Error sincronizando el precio con las máquinas:', syncError);  
 }

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

const eliminarProductoAlmacen = async (req, res) => {
 try {
 const { id } = req.params;
 console.log(`🗑️ Eliminando producto del almacén con ID: ${id}`);
 const result = await pool.query(
 'DELETE FROM productos_almacen WHERE id = $1 RETURNING *',
 [id]
 );
 if (result.rows.length === 0) {
 return res.status(404).json({ success: false, message: 'Producto no encontrado' });
 }
 res.json({
   success: true,
   message: 'Producto eliminado correctamente del almacén'
 });
 } catch (error) {
 console.error('Error al eliminar el producto:', error);
 res.status(500).json({ success: false, message: 'Error al eliminar en el servidor' });
 }
};

module.exports = {
 obtenerAlmacen,
 crearProductoAlmacen,
 editarProductoAlmacen,
 actualizarStock,
 eliminarProductoAlmacen
};