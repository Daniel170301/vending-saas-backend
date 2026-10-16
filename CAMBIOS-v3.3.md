# vending-api-server · v3.3 · Entorno superadmin

Incluye todo lo de la v3.2, que no llegaste a subir. Esta versión la reemplaza.

## Antes de subir: arregla el repositorio
El 14 de octubre, en el commit `67158e3 Servidor Mejorado`, se subieron a este repositorio los archivos de
**kymez-pagos**: `index.js`, `trabajos.js` y su `package.json`. Render no pudo arrancar ese commit y siguió con la
v3.1, así que hoy no pasa nada. Pero cualquier push nuevo fallaría mientras esos archivos sigan aquí.
Este zip trae el `package.json` correcto. Los otros dos se borran en el paso 1.

## Cómo subirlo
0. En tu carpeta `backend-saas-vending_V_3`: `git pull` y luego `git log -1 --oneline`. Debe decir
   `67158e3 Servidor Mejorado`. Si dice otra cosa, **no copies nada** y mándame tu versión.
1. Borra los archivos de kymez-pagos que se colaron: `git rm index.js trabajos.js`
2. **Render → vending-api-server → Environment.** Si ya existe `JWT_SECRET`, no lo toques. Si no existe:
   **Add Environment Variable** → Key `JWT_SECRET` → Value: pulsa **Generate** (o pega una clave larga al azar) →
   **Save**. Render reinicia el servidor actual; no afecta a nadie.
3. Copia el contenido del zip encima de tu carpeta (reemplaza los archivos).
4. `git status` debe mostrar SOLO:
   - borrados: `index.js`, `trabajos.js`
   - modificados: `app.js`, `package.json`, `package-lock.json`, `controllers/authController.js`,
     `controllers/dashboardResumen.js`, `controllers/inventoryController.js`, `controllers/machineController.js`,
     `controllers/salesController.js`, `services/migraciones.js`, `services/resumenVentas.js`
   - nuevos: `controllers/superadminCatalogoController.js`, `controllers/superadminFlotaController.js`,
     `controllers/superadminYapeController.js`, `routes/superadminRoutes.js`, `services/identidadMaquina.js`,
     `services/kymez.js`, `utils/auditoria.js`, `utils/auth.js`, `utils/tiempo.js`,
     `migraciones/002_superadmin.sql`, `migraciones/deshacer_002.sql` y este archivo.
5. `git add -A`, `git commit -m "v3.3 entorno superadmin"`, `git push`. Hazlo cuando las máquinas vendan poco.
6. En los logs de Render: `[auth] JWT_SECRET configurado`, `[resumen-ventas] activo`, `[migracion] lista`.
   Abre `https://vending-api-server.onrender.com/salud`: debe decir `"version":"3.3.0"`.
7. **Cierra sesión en Qhapay y vuelve a entrar** (tu sesión anterior se firmó con la clave vieja).
8. Pega los prompts de Lovable **en orden: A, B y C**. No uses el prompt de la v3.2: este lo reemplaza.

**Sin los prompts de Lovable, la app actual sigue funcionando igual** (probado comparando cada respuesta con la v3.1).
Lo único que ya se nota: las máquinas salen ordenadas, y apenas les asignes su código KMT, la app muestra ese código.

## Qué hace en tu base de datos al arrancar (todo es agregado)
- Tabla `regiones` con 1 Lima, 2 Trujillo y 3 Cañete. Las demás se agregan desde la app.
- Columnas nuevas en `maquinas`: `region_id`, `numero_kmt` y `codigo_kmt`. Las tres empiezan vacías: los códigos los
  asignas tú.
- Tabla `auditoria_superadmin`: quién cambió qué y cuándo.
- **No modifica ni borra** máquinas, ventas, inventario, abastecimientos, gastos ni usuarios.
- Lee y actualiza el esquema `kymez` (cuentas de cobro, vínculo máquina–celular, incidencias, pagos y la cola de
  ventas), como hacías en DBeaver.

## Cómo funciona el código de cada máquina
Cada máquina tiene **dos** identificadores, como en Nayax ("máquina" y "equipo"):

| | Qué es | Ejemplo | Quién lo pone |
|---|---|---|---|
| **Código KMT** | El código de la máquina para ti y tus clientes: `KMT-<región>-<número>` | `KMT-1-0003` = Kymez Servitech · Lima · Máquina 0003 | Solo el superadmin |
| **ID del equipo** | El de la placa: `MACHINE_ID` del config.h, usuario de HiveMQ, kymez-pagos | `TCN-0003`, `B4-BF-E9-62-21-28` | Solo el superadmin |

- **Asignar un código KMT no mueve ningún dato** ni toca la placa: las máquinas que ya venden siguen vendiendo igual.
  **No tienes que reprogramar nada.**
- El número es correlativo **por región**: Lima tiene KMT-1-0001, KMT-1-0002…, y Trujillo empieza en KMT-2-0001.
  La app sugiere el siguiente libre y no deja repetir.
- **Si cambias la placa de una máquina, usa "Cambiar equipo"**, no DBeaver. Copia TODA la máquina (nombre, código KMT,
  cliente, costo, candado…) y mueve inventario, ventas, abastecimientos, gastos y su historial. La placa nueva hereda la
  cuenta Yape.
- Para placas nuevas puedes usar el código KMT como `MACHINE_ID` en config.h (ej. `KMT-1-0004`). Es opcional.

### Lo que se te pasó al renombrar MX-001 → TCN-0003 en DBeaver
Tu script movió solo el `inventario`. Si MX-001 tenía ventas, abastecimientos o gastos, quedaron con el ID viejo y ya
no aparecen en la máquina. En la app: **Superadmin → Mantenimiento → Datos sin máquina** los muestra, y con
"Mover a…" los pasas a la Maquina oficial. Los totales del Inicio se recalculan solos.

## Rutas nuevas (`/api/superadmin/…`, solo el superadmin, con su sesión)
| Ruta | Para qué |
|---|---|
| `GET /resumen` | Centro de control: máquinas en línea, ventas de hoy (Yape/Efectivo), 14 días, celulares, incidencias, sincronización y "requiere atención" |
| `GET /maquinas` · `GET /maquinas/:id` | Flota completa · ficha de una máquina (checklist de alta, telemetría, ventas, pagos, incidencias, historial) |
| `PUT /maquinas/:id/datos` | Nombre y matrícula |
| `PUT /maquinas/:id/codigo-kmt` · `DELETE` | Asignar `{ region_id, numero? }` o quitar el código KMT |
| `GET /codigos/siguiente?region_id=1` | El siguiente código libre de una región |
| `PUT /maquinas/:id/equipo` · `GET /equipos-disponibles` | Vincular o cambiar la placa · placas que kymez ya ve y no tienen máquina |
| `PUT /maquinas/:id/yape` | Vincular la máquina a un celular de cobro (reemplaza el INSERT en kymez.maquinas) |
| `GET/POST/PUT /cuentas-yape` | Celulares de cobro (reemplaza el INSERT en kymez.cuentas_cobro) con su URL de MacroDroid |
| `GET /pagos-yape` · `POST /pagos-yape/:id/reembolsado` | Pagos Yape y reembolsos (resuelve su incidencia) |
| `GET /incidencias` · `POST /incidencias/resolver` | Incidencias con qué pasó y qué hacer; resolver por ID, tipo, máquina o fecha |
| `GET /sincronizacion` · `POST /sincronizacion/reintentar` | Ventas que no llegaron a Qhapay y reintento |
| `GET/POST/PUT/DELETE /regiones` | Regiones del código |
| `GET /duenos` · `GET /auditoria` | Dueños con sus máquinas · historial de cambios |
| `GET /huerfanos` · `POST /huerfanos/mover` | Datos que quedaron con un ID que ya no existe |

También cambia:
- `GET /api/machines`, `GET /api/machines/:id`, `GET /api/ventas`, Inicio e Inventario traen `codigo_kmt`,
  `region_nombre`, `codigo_descripcion` y `nombre`, con las máquinas ordenadas por código y nombre.
- Una máquina sin nombre se muestra con su código KMT (y si tampoco tiene, con el ID del equipo).
- `/salud` muestra la versión.

## Errores corregidos
- **Cambiar el código de una máquina borraba datos.** Antes, guardar una máquina con otro "código" la renombraba y perdía
  cliente, costo, depreciación, distrito y matrícula, y le quitaba el candado. Ahora guardar una máquina **nunca** cambia
  su código ni su equipo: eso se hace solo desde el entorno superadmin, que conserva todo.
- **Login con la contraseña `google_oauth`.** Cualquiera podía entrar a las cuentas creadas con Google escribiendo esa
  palabra como contraseña. Ahora se rechaza.
- Al guardar una máquina sin nombre, la app actual devolvía su código como nombre y lo guardaba. Ahora no.
- Las ventas de un ID que ya no existe salían sin nombre de máquina; ahora salen con su ID.

## Si quieres volver atrás
Render → Deploys → deploy anterior → Rollback (después reactiva el autodeploy en Settings). La v3.1 funciona igual
sobre la base ya migrada (probado). Para quitar también lo agregado a la base: `MIGRAR_AL_INICIAR=false` y
`migraciones/deshacer_002.sql` en DBeaver. Esto borra los códigos KMT, las regiones y la auditoría; no borra nada más.

## Probado
- **La app actual, sin cambios en Lovable:** lista de máquinas, una máquina, ventas, Inicio e inventario devuelven
  exactamente lo mismo que la v3.1 (más los campos nuevos).
- **Entorno superadmin, 105 comprobaciones:**
  - Permisos: sin sesión → 401; dueño → 403; token falso o vencido → 401.
  - Código KMT: siguiente libre, número ocupado → 409 con quién lo tiene, región desactivada.
  - Equipo: alta desde PEND-, cambio de placa conservando todo, equipo repetido → 409.
  - Yape y celulares: vínculo Yape, celulares, reembolsos, incidencias (incluida "resolver las de antes del 3 de
    octubre", como en tu DBeaver), reintento de ventas omitidas.
  - Datos sin máquina: MX-001 detectado y movido.
  - Regiones y auditoría completas.
  - Totales del Inicio iguales a un recálculo desde cero después de cada cambio.
- **Con la migración apagada** (`MIGRAR_AL_INICIAR=false`): todo responde y regiones avisa que falta la migración.
- **1000 máquinas y 2 millones de ventas:**

  | Pantalla | Tiempo |
  |---|---|
  | Centro de control | 0,34 s (después casi instantáneo, por caché de 10 s) |
  | Flota completa | 0,07 s (36 KB comprimida) |
  | Celulares | 0,07 s |
  | Sincronización | 0,19 s |

## Pendiente de seguridad (no se cambió para no tocar el login de tus clientes)
- `POST /api/auth/google` entrega una sesión a cualquier correo sin comprobarlo con Google. Quien sepa el correo del
  superadmin podría entrar al entorno superadmin.
- Las demás rutas (borrar máquina, candado, inventario…) siguen sin pedir sesión.
