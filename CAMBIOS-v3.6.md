# vending-api-server · v3.6.1

> **v3.6.1 (6-nov):** agrega la contraseña temporal para abrir "Celular de cobro" (sección 9). Si aún no subiste la v3.6, sube directamente esta: incluye todo.

Va encima de la **v3.4** (la que está en Render) e **incluye todo lo de la v3.5** (seguridad y eliminar cuenta), que no llegaste a subir. Sube directamente esta.

## 1. La máquina de Becall (equipo antiguo ESP32 v1) sigue igual
No hay que tocar el celular ni MacroDroid. Para la Snakky Becall (`B4-BF-E9-62-21-28`) y cualquier otra máquina con el equipo antiguo, todo funciona como hoy:
- **Webhook de Yape** `/api/webhook/yape/<MAC>`: mismo formato y mismas respuestas. En los logs de Render salen las mismas líneas (`Notificación para máquina…`, `YAPE DETECTADO…`, `Pago enviado…`).
- **Broker público** `jaimez/expendedora`: **encendido** como siempre. Las ventas `VENTA:<motor>` descuentan stock y se guardan en Ventas.
- **`/api/ventas/confirm-dispense/<MAC>`**: sigue sin pedir sesión.

Lo único que cambia: esas rutas ahora **solo aceptan máquinas antiguas registradas en QhaPay**. Antes aceptaban cualquier ID, y ahora rechazan una placa KYMEZ o un ID inventado.

Cuando puedas, cambia la Becall a una placa KYMEZ. El broker público no tiene usuario, así que cualquiera que conozca el tópico puede mandarle un pago. Luego pon `MQTT_LEGADO=no`.

## 2. Seguridad (lo de la v3.5)
1. **Entrar con Google** ya no entrega la sesión de cualquier correo, incluido el superadmin.
2. **Datos ajenos.** Toda la información exige la sesión. El correo de la dirección (`?user=`) ya no sirve para ver datos de otro dueño, y cada ID se revisa contra el dueño: si no es suyo, responde 404.
3. **Contraseñas con hash** (scrypt). Al arrancar, el servidor convierte todas las que estaban en texto plano.
4. **Otros arreglos:**
   - Ya no existe la clave de respaldo escrita en el código.
   - Freno a intentos de contraseña: tras 8 fallos, 15 minutos de espera.
   - No se puede cambiar el correo de tu cuenta al de otra.
   - La lista de clientes muestra solo los tuyos.
5. **Nuevo en la v3.6:**
   - Una compra ya no puede sumar stock a productos de otro dueño.
   - Un gasto sin dueño queda a nombre de la sesión.

## 3. Nuevo
| Qué | Rutas |
|---|---|
| **Eliminar cuenta** (Google Play) | `GET/POST /api/cuenta/eliminar` |
| **Cambiar o crear contraseña**. Las cuentas de Google pueden crear una para entrar con correo en la app. | `GET /api/cuenta/contrasena` (¿tiene?) y `POST /api/cuenta/contrasena { actual?, nueva }` |
| **¿Olvidaste tu contraseña?** Antes no funcionaba: cambiaba la clave en Supabase y no aquí. | `POST /api/auth/restablecer { nueva }` con la sesión del enlace del correo |
| **Google con el botón oficial**: la pantalla dice QhaPay, no supabase.co | `POST /api/auth/google { credential }`. La forma anterior sigue funcionando. |
| **Operarios**: cuentas con usuario y contraseña, vinculadas por código | `/api/operarios/...` (ver abajo) |
| **Asistente QhaPay con IA** | `GET /api/asistente/estado`, `POST /api/asistente/mensaje`, `POST /api/asistente/confirmar` |

### Operarios
- **El operario se registra solo:**
  1. `POST /api/operarios/registro { usuario, password, nombre? }` (o entra con `/login`).
  2. Escribe el código del dueño: `POST /api/operarios/vincular { codigo }`.
- **Desde ese momento ve solo las máquinas, el planograma y el almacén de ese dueño, y puede rellenar.**
  - No ve ventas, gastos, proveedores, clientes, perfil ni Mi empresa.
  - En el almacén solo cambia el stock; en la máquina, solo el layout.
  - El historial guarda su nombre real.
- **El dueño:**
  - Ve su código: `GET /api/operarios/codigo` (formato `ABCD-EF23`).
  - Lo renueva: `POST /api/operarios/codigo/nuevo`.
  - Ve la lista: `GET /api/operarios`.
  - Pausa o activa: `PATCH /api/operarios/:id { activo }`.
  - Quita: `DELETE /api/operarios/:id`.
  - Crea una contraseña temporal: `POST /api/operarios/:id/clave`.
- **El operario también puede:**
  - ver su cuenta (`GET /yo`);
  - desvincularse (`POST /desvincular`);
  - cambiar su contraseña (`POST /yo/contrasena`);
  - eliminar su cuenta (`POST /yo/eliminar`, lo exige Google Play).
- Si el dueño elimina su cuenta, sus operarios pierden el acceso.

### Asistente
- **Qué hace:** lee fotos de boletas y facturas, registra gastos, registra compras (y crea los productos nuevos), crea productos, abastece máquinas y responde sobre ventas.
- **Nada se guarda sin que la persona toque Confirmar.** La IA solo prepara una tarjeta, y la tarjeta se guarda con las mismas rutas y la misma sesión de la persona.
- **Los operarios** solo pueden abastecer y consultar el planograma o el almacén.
- **No se guardan fotos ni mensajes**, solo cuántos mensajes y tokens usó cada cuenta al día (tabla `asistente_uso`).
- **Sin `ANTHROPIC_API_KEY` queda apagado** y la app no muestra la burbuja.

## 4. Variables de entorno (Render → vending-api → Environment)
| Variable | Qué poner | Cuándo |
|---|---|---|
| `JWT_SECRET` | Ya existe. **No la cambies.** | — |
| `AUTH_MODO` | `avisar` | Antes de subir. Bórrala cuando en los logs ya no salga `SIN SESIÓN`. |
| `GOOGLE_CLIENT_ID` | El ID de cliente web de Google Cloud (ver 6) | Cuando lo tengas. Sin él, Google sigue funcionando como hoy. |
| `ANTHROPIC_API_KEY` | La clave de la consola de Claude (ver 7) | Cuando quieras encender el asistente |
| `ASISTENTE_MODELO` | Opcional. Por defecto `claude-sonnet-5-5`; más barato: `claude-haiku-5-5` | — |
| `ASISTENTE_LIMITE_DIA` | Opcional. Mensajes por cuenta al día (por defecto 80). | — |
| `MQTT_LEGADO` | **No la pongas** mientras tengas Becall. `no` la apaga. | Después |
| `YAPE_WEBHOOK_CLAVE` | Opcional. Si la pones (24+ caracteres), MacroDroid debe mandar `x-clave`. | Cuando edites la macro |

## 5. Cómo subirlo
1. En Render: revisa `JWT_SECRET` y agrega `AUTH_MODO=avisar`.
2. En tu carpeta del repo, ejecuta `git pull` y revisa que `git status` esté limpio.
3. Copia el contenido del ZIP encima. Borra `CAMBIOS-v3.5.md` si lo habías copiado.
4. Revisa con `git status`. Deben salir **23 modificados** y **18 nuevos**:
   - **Modificados:**
     - `app.js`, `server.js`, `package.json`
     - `controllers/`: `authController`, `clientController`, `expenseController`, `profileController`, `warehouseController`
     - `routes/`: `authRoutes`, `clientRoutes`, `expenseRoutes`, `inventoryRoutes`, `machineRoutes`, `profileRoutes`, `proveedorRoutes`, `reportRoutes`, `salesRoutes`, `warehouseRoutes`, `yapeRoutes`
     - `services/mqttService`
     - `utils/`: `auditoria`, `auth`, `usuarios`
   - **Nuevos:**
     - `controllers/`: `asistenteController`, `cuentaController`, `operarioController`
     - `routes/`: `asistenteRoutes`, `cuentaRoutes`, `operarioRoutes`
     - `services/`: `asistente`, `hashearClaves`
     - `utils/`: `clave`, `clientesDueno`, `equipoLegado`, `google`, `googleId`, `limite`, `operarios`, `propiedad`, `sesion`
     - este archivo
5. Ejecuta `git add -A`, `git commit -m "v3.6"` y `git push`.
6. Abre `/salud`. Debe decir `"version":"3.6.0"`, `"sesion":"avisar"`, `"equipos_antiguos":"encendido"` y `"asistente":"sin clave"`.
7. **Prueba Becall:** espera la siguiente venta con Yape y revisa en los logs las mismas líneas de siempre. O haz tú un Yape de S/ 0.50.
8. Pega los prompts de Lovable en orden.
9. Usa QhaPay 1 o 2 días y busca **`SIN SESIÓN`** en los logs. Cuando ya no salga, **borra `AUTH_MODO`**.

**DBeaver no hace falta.** Las tablas nuevas (`operarios`, `operario_codigos`, `asistente_uso` y la columna `empresas_clientes.id_dueno`) se crean solas al arrancar.

**No vuelvas a la v3.4:** las contraseñas ya quedan con hash y la v3.4 no las sabría leer. El freno es `AUTH_MODO=avisar`.

## 6. Google con tu marca (GOOGLE_CLIENT_ID)
1. Ve a console.cloud.google.com y crea el proyecto **QhaPay**.
2. **Pantalla de consentimiento OAuth** (Google Auth Platform → Branding):
   - Nombre de la app: QhaPay
   - Logo
   - Correo de asistencia: qhapay.app@gmail.com
   - Dominio autorizado: qhapay.com
   - Enlaces a `https://qhapay.com/privacidad`
   - Público: externo
3. **Clientes → Crear cliente → Aplicación web:**
   - Orígenes autorizados de JavaScript: `https://qhapay.com`, `https://www.qhapay.com` y la dirección de vista previa de Lovable.
   - Copia el **ID de cliente** (termina en `.apps.googleusercontent.com`).
4. Pégalo en Render como `GOOGLE_CLIENT_ID`, y en el Prompt 2 de Lovable, donde dice `PEGA_AQUI_TU_CLIENT_ID`.

Dentro de la app Android, Google no permite su botón (Google bloquea los inicios de sesión dentro de apps tipo WebView). Ahí se entra con correo y contraseña. Quien tenga cuenta de Google crea su contraseña en la web, en Perfil → Contraseña.

## 7. Encender el asistente (ANTHROPIC_API_KEY)
1. Entra a **platform.claude.com** y crea la cuenta u organización **KYMEZ TECH S.A.C.**
2. En **Billing**, recarga US$ 5–10 y pon un **límite de gasto mensual**.
3. En **API keys**, crea una clave y pégala en Render como `ANTHROPIC_API_KEY`. No la pongas en Lovable ni en la app.
4. Abre `/salud`: debe decir `"asistente":"activo"`. En QhaPay aparece la burbuja **Q**.
5. **Costo aproximado:** una boleta cuesta ~US$ 0.01 con Sonnet o ~US$ 0.001 con Haiku. En la consola ves el gasto por día.

## 8. Probado (PostgreSQL 17 local; Supabase, Google y Anthropic simulados) · 203 comprobaciones
**Seguridad (v3.5), 95 comprobaciones**, incluido el modo `avisar`.

**v3.6, 108 comprobaciones:**
- **Becall:**
  - Webhook y confirm-dispense iguales, sin clave.
  - Rechazan placas KYMEZ e IDs inventados.
  - Ver ventas de Becall sin sesión sigue cerrado.
- **Google oficial:**
  - Entra y crea la cuenta.
  - Rechaza (401): token de otra app, correo sin verificar, firma falsa y token vencido.
  - Acepta el segundo ID de cliente.
  - La forma anterior (Supabase) sigue funcionando.
- **Restablecer contraseña** y **crear contraseña** en cuentas de Google.
- **Compras:** con productos de otro dueño da 404; los gastos quedan a nombre de la sesión.
- **Operarios:**
  - Registro: valida usuario y contraseña, y rechaza usuarios repetidos.
  - Login y freno a intentos.
  - Sin código no ve nada.
  - Vincula con código, en minúsculas y sin guion.
  - Ve solo las máquinas de su dueño.
  - Recibe 403 en: ventas, resumen, gastos, proveedores, clientes, perfil, Mi empresa, vender, borrar resorte, crear producto, borrar máquina, lista de operarios, superadmin y eliminar la cuenta del dueño.
  - Abastece con su nombre en el historial.
  - En el almacén solo cambia el stock.
  - Pausar, reactivar, contraseña temporal, renovar código y quitar.
  - Si el dueño elimina su cuenta, pierde el acceso.
- **Asistente:**
  - La foto llega a Claude.
  - Busca en el almacén con la sesión de la persona.
  - Nada se guarda hasta confirmar. La compra crea el producto nuevo y suma stock.
  - No acepta productos ajenos ni datos inválidos; si la IA se equivoca, recibe el error para corregir.
  - El operario no tiene herramientas de ventas ni gastos y solo abastece sus máquinas.
  - Si Anthropic falla responde 502; un archivo que no es foto da 400.
  - Cuenta el uso por día. Sin clave queda apagado.

## 9. v3.6.1 · Contraseña temporal para "Celular de cobro"
- **Para qué:** quien tenga la app (el dueño o su encargado) no puede cambiar los códigos cel-N, las claves ni borrar cuentas de cobro sin un código que tú le das.
- **Cómo funciona:**
  - En Superadmin › Cobros Yape › **Acceso a celular de cobro** generas un código (ej. `K7QM-4XPA`).
  - Sirve **una sola vez** y vence en **30 minutos** (puedes elegir de 5 minutos a 24 horas). Puedes anularlo si no se usó.
  - Al escribirlo, la pantalla queda abierta **15 minutos** en ese celular. Después pide otro código.
  - Tú (superadmin) entras sin código. Los operarios nunca entran.
  - Tras 8 códigos errados, 15 minutos de espera.
  - En la base de datos solo queda la huella del código (no se puede leer). Cada código creado, usado o anulado queda en la auditoría.
- **Rutas:** `GET/POST /api/cobros/acceso` (app) · `GET/POST /api/superadmin/cobros-codigos`, `DELETE /api/superadmin/cobros-codigos/:id`.
- **Tabla nueva:** `cobros_codigos` (se crea sola al arrancar). Nada que hacer en DBeaver.
- **Probado:** 20 comprobaciones nuevas (además de las 203 de v3.6).

