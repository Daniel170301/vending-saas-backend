# vending-api-server · v3.1 (rendimiento)

Todo lo que ya usa Qhapay sigue funcionando igual. Las rutas nuevas son opcionales hasta que actualices el frontend con Lovable.

## Cómo subirlo sin riesgo

Este zip trae **solo los archivos que cambian o son nuevos**. No trae tu `.env`, no trae `node_modules`
y no borra ningún archivo de tu carpeta.

0. **Comprueba que tu backend sigue igual que el que me enviaste (6 de octubre).** En tu carpeta:
   `git pull` y luego `git log -1 --oneline`. Debe decir `ee4f1a8 cambios en mi backend`, y `git status`
   no debe mostrar archivos `.js` modificados. Si dice otra cosa, **no copies nada**: tu backend cambió
   después y el zip pisaría esos cambios. Mándame la versión actual y lo fusiono.
1. **Respaldo de la base de datos.** En Render → tu base → **Recovery** → **Create export**. Si tu base
   es del plan gratis, haz el respaldo desde DBeaver (clic derecho en la base → Herramientas → Respaldo).
2. **Copia** el contenido del zip encima de tu carpeta `backend-saas-vending_V_3`.
3. `git status` debe mostrar SOLO estos archivos (modificados o nuevos): `app.js`, `server.js`,
   `package.json`, `package-lock.json`, `config/database.js`, `controllers/` (dashboardController,
   dashboardResumen, expenseController, inventoryController, machineController, profileController,
   salesController, warehouseController), `routes/` (dashboardRoutes, expenseRoutes, inventoryRoutes,
   machineRoutes, warehouseRoutes), `services/` (cronJobs, migraciones, mqttService, optimizarImagenes,
   resumenVentas), `utils/`, `migraciones/` y este archivo.
4. `git add .`, `git commit -m "v3.1 rendimiento"`, `git push`. Render hace el deploy solo.
   **Si algo falla al construir o al arrancar, Render deja funcionando la versión anterior.**
5. En los logs de Render debe aparecer `[migracion] lista` y `[resumen-ventas] activo`.
6. Prueba la app como la usas hoy (el frontend actual funciona igual con este backend) y espera a que
   una máquina venda: la venta debe aparecer en Qhapay.
7. **Recién después**: ejecuta `npm run optimizar-imagenes` (Render → Shell) y pega los prompts en Lovable.

**Mejor hora para subirlo:** cuando las máquinas venden poco. Durante el cambio de versión, los dos
servidores conviven unos segundos y ambos escuchan MQTT. Esto ya pasaba en cada deploy de tu código
actual, no lo introduce la v3.1.

### Si quieres volver atrás
- **Código:** Render → tu servicio → **Deploys** → elige el deploy anterior → **Rollback**. Después de
  un rollback desde el panel, Render desactiva el autodeploy: vuelve a activarlo en Settings.
- **Base de datos:** no hace falta tocarla. Lo que agrega la v3.1 es compatible con el código anterior
  (probado: el servidor anterior funciona igual sobre la base ya migrada). Si aun así quieres quitarlo,
  pon `MIGRAR_AL_INICIAR=false` y corre `migraciones/deshacer_001.sql` en DBeaver. Ese script no borra
  ventas, máquinas, productos ni inventario (probado).

### Qué hace en tu base de datos al arrancar (todo es agregado)
- Agrega la columna `imagen_version` en `productos_almacen` y cambia las fotos vacías (`''`) a `NULL`
  (las dos significan "sin foto").
- Crea índices nuevos (no reemplaza ni borra los tuyos).
- Crea 3 tablas nuevas de totales (`ventas_dia_maquina`, `ventas_mes_maquina`, `ventas_dia_producto`)
  y un trigger en `historial_ventas` que las mantiene al día. El trigger nunca bloquea una venta: si
  fallara, la venta se guarda igual.
- **No borra ni modifica** ventas, máquinas, inventario, abastecimientos, gastos ni usuarios.

**Lo único que no tiene vuelta atrás sin respaldo:** `npm run optimizar-imagenes` reemplaza cada foto
de producto por una versión de 400 px. Por eso va después del respaldo.

### Protecciones nuevas contra borrados
- **Guardar una máquina** solo cambia los campos que llegan. Con el servidor anterior, cualquier guardado
  parcial dejaba en blanco el nombre, el código, la ubicación, el cliente, el costo, la depreciación y
  hasta el planograma. Tu app actual hace guardados parciales al abastecer como superadmin
  (Planograma → Abastecimiento Único) y en el diálogo de abastecimiento de Movimientos.
- **Un layout vacío nunca reemplaza** a un planograma que tiene bandejas. Para vaciarlo a propósito hay
  que mandar `borrar_layout: true`.

Para ver si alguna máquina ya perdió datos por ese error, corre esto en DBeaver:
```sql
SELECT machine_id, name, code, location, distrito, costo_maquina, id_cliente_punto, layout
FROM maquinas
WHERE name IS NULL OR code IS NULL OR location IS NULL
   OR layout IS NULL OR layout::text IN ('[]', '{}', 'null')
   OR COALESCE(costo_maquina, 0) = 0;
```

## Qué cambió

### Rendimiento
| Ruta | Antes | Ahora |
|---|---|---|
| `GET /api/productos-almacen` | La lista iba **3 veces** en la respuesta, con todas las fotos en Base64 dentro | Va una sola vez y cada foto llega por su propia URL, que el navegador guarda en caché un año |
| `GET /api/inventario/:id` | Cada resorte traía la foto en Base64 | Trae la URL de la foto y `producto_almacen_id` |
| Todas las respuestas | Sin comprimir | Comprimidas con gzip (`compression`) |
| Fotos nuevas | Se guardaban a 800 px | Se reducen a 400 px WebP (unas 10 veces más livianas) |
| Base de datos | Sin índices | Índices en inventario, ventas, historial, almacén y máquinas |
| Conexión a la BD | Se tomaba una conexión al arrancar y nunca se devolvía; sin límites de tiempo | Pool con tiempos límite, y un fallo de conexión ya no tumba el servidor |
| Rol del usuario | Se consultaba en cada petición | Se guarda 60 s en memoria |
| Inicio y ranking de productos | Sumaban todo el historial de ventas en cada consulta (con 1000 máquinas: más de 15 s, o error) | Leen tablas de totales por día que se actualizan solas con cada venta (~0,1 s con 1000 máquinas y 6,5 millones de ventas) |
| Lista de máquinas | Con 1000 máquinas pesa 2,6 MB por el layout | `?ligero=1` la deja en 11 KB (comprimida) |

### Errores corregidos
- **Ventas duplicadas:** `GET /api/ventas` cruzaba el costo solo por nombre del producto. Si otro dueño tenía un producto con el mismo nombre (por ejemplo "Coca Cola"), cada venta salía repetida y los totales se inflaban. En la prueba aparecían 7 200 ventas en lugar de 6 000.
- **Máquina borrada al guardar:** `PUT /api/machines/:id` con solo `{ layout }` dejaba en blanco el nombre, el código, la ubicación, el cliente, el costo y la depreciación de la máquina. Ahora solo cambia los campos que llegan.
- **Precios entre dueños:** editar un producto cambiaba el precio en **las máquinas de todos los dueños** que tuvieran un producto con ese nombre, y les mandaba el comando por MQTT. Ahora solo toca las máquinas del dueño, y solo donde el precio cambió.
- **Almacén equivocado:** quitar stock o revertir un abastecimiento devolvía unidades a todos los productos con ese nombre, de cualquier dueño. Ahora va solo al almacén del dueño de la máquina.
- **Contraseña expuesta:** `GET /api/perfil/:email` devolvía la contraseña. Ya no.
- **Ventas simultáneas:** `confirm-dispense` restaba el stock en dos pasos y dos ventas a la vez podían pisarse. Ahora resta en un solo paso.

### Totales de ventas por día (para miles de máquinas)
Al arrancar se crean tres tablas: `ventas_dia_maquina`, `ventas_mes_maquina` y `ventas_dia_producto`. También se crea un **trigger** en `historial_ventas` que las mantiene al día con cada venta, venga de donde venga (este servidor, kymez-pagos o DBeaver).
- **La primera vez** llena las tablas con todo tu historial. Con tus datos actuales tarda menos de un segundo; con 6,5 millones de ventas tardó 25 s.
- **Si el trigger fallara**, la venta se guarda igual: solo deja un aviso en el log.
- **Cada noche (03:10, hora de Lima)** se recalculan los últimos 3 días por si hubiera alguna diferencia.
- **Probado:** después de insertar, borrar, editar y renombrar máquinas, las tablas coinciden exactamente con un recálculo desde cero.

### Rutas nuevas (para el frontend)
- `GET /api/dashboard/resumen?email=…&tz=America/Lima`: todo el Inicio en una respuesta pequeña: totales del día, semana, mes y año, ganancia, últimos 14 días, ventas por máquina, productos más vendidos, alertas de stock y número de máquinas.
- `GET /api/machines?user=…&ligero=1`: la lista sin el layout completo, con `bandejas_total` y `resortes_total`.
- `GET /api/machines/:id`: una máquina completa, con su layout (para editarla o ver su planograma).
- `GET /api/inventario/resumen?email=…`: por máquina, las unidades, la capacidad, los faltantes, el costo y la venta futura.
- `POST /api/inventario/lote`: relleno en grupo en una sola petición, todo o nada.
  ```json
  { "machine_id": "...", "user_email": "...", "nombre_operario": "...",
    "items": [ { "codigo_motor": "10", "cantidad": 6, "producto_id": 12 } ] }
  ```
  `cantidad` son las unidades que se **agregan**. Valida la capacidad, el stock del almacén (sumando los resortes que tienen el mismo producto), los resortes mixtos y el cambio de producto. Si algo falla responde 400 con `errores: [{ codigo_motor, motivo }]` y no guarda nada.
- `POST /api/inventario` ahora acepta `descontar_almacen: true` y `producto_id`: carga el resorte y descuenta el almacén en la misma petición.
- `PUT /api/productos-almacen/:id/stock` ahora acepta `{ "delta": -6 }`: resta de forma atómica, sin pisarse con otro operario.
- `GET /api/productos-almacen/:id/imagen?v=…`: la foto del producto.
- `GET /api/ventas` y `GET /api/inventario/:id/abastecimiento` ahora aceptan `desde`, `hasta` y `limite`.
- `GET /api/gastos?…&ligero=1`: la lista sin las fotos de los comprobantes. Cada foto se pide con `GET /api/gastos/:id/comprobante?categoria=…`.
- `GET /salud`: chequeo de salud del servidor.

### Variables de entorno nuevas (todas opcionales)
| Variable | Para qué |
|---|---|
| `DB_POOL_MAX` | Conexiones máximas a la BD (por defecto 10) |
| `MIGRAR_AL_INICIAR=false` | Desactiva los índices automáticos al arrancar |
| `OPTIMIZAR_IMAGENES_AL_INICIAR=true` | Reduce las fotos existentes una vez |
| `IMAGEN_LADO_MAX`, `IMAGEN_CALIDAD` | Tamaño y calidad de las fotos (400 y 72) |
| `PUBLIC_URL` | URL pública del servidor, si algún día usas un dominio propio |
| `NEGOCIO_ZONA` | Zona horaria de los totales por día (por defecto America/Lima) |
| `VENTAS_FECHA_ZONA` | Solo si las fechas de ventas no están en la zona horaria de la BD |

## Pendiente de seguridad (no se cambió para no romper el login)
- Ninguna ruta verifica el token: cualquiera que conozca un correo puede leer o modificar los datos de esa cuenta.
- `POST /api/auth/google` entrega un token a cualquier correo, sin comprobar con Google.
- Las contraseñas se guardan en texto plano.
- `JWT_SECRET` tiene un valor por defecto escrito en el código.
- MQTT usa el broker público `broker.hivemq.com` sin usuario, así que cualquiera puede publicar `VENTA:` en tus tópicos.
