# vending-api-server · v3.4 · Clientes: mensualidad, suspensión y soporte

Va encima de la v3.3 (la que ya está en Render). Solo agrega; no cambia nada de lo que ya funciona.

## Qué agrega
- **Mensualidad por cliente:** monto y "pagado hasta". La app avisa cuando está por vencer (5 días) o vencida.
- **Registrar pago:** extiende la fecha 1 o más meses (desde hoy si ya venció, o desde la fecha vigente si paga
  por adelantado), guarda el historial y **reactiva sus máquinas** automáticamente.
- **Suspender / reactivar** a un cliente completo o una sola máquina, con un motivo que el cliente ve en su pantalla
  ("Servicio suspendido por falta de pago…"). La máquina **sigue vendiendo y registrando ventas**: al reactivarla no
  se pierde nada. Usa el mismo candado que la app ya entiende (`pago_al_dia`).
- **Entrar como cliente (soporte):** el superadmin abre la cuenta de un cliente por 2 horas para verla tal cual la
  ve él. Esa sesión NO da acceso al superadmin y queda registrada en la auditoría.
- **Corrección de seguridad:** `PUT /api/machines/:id/settings` (el candado) lo podía usar cualquiera, incluso un
  cliente para reactivarse solo. Ahora exige la sesión del superadmin. La app ya le manda la sesión: no cambia nada
  para ti.

## Rutas nuevas (`/api/superadmin/…`)
| Ruta | Para qué |
|---|---|
| `GET /clientes` | Clientes con máquinas, suspendidas, ventas de hoy y del mes, mensualidad y estado de pago |
| `GET /clientes/:id` | Ficha: datos, máquinas (con su motivo de suspensión) e historial de pagos |
| `PUT /clientes/:id/mensualidad` | `{ mensualidad, pagado_hasta }` |
| `POST /clientes/:id/pagos` | `{ meses = 1, monto?, nota?, reactivar = true }` |
| `PUT /clientes/:id/suspension` | `{ suspender: true/false, motivo? }` (todas sus máquinas) |
| `PUT /maquinas/:id/suspension` | `{ suspender: true/false, motivo? }` (una máquina) |
| `POST /clientes/:id/entrar` | Sesión del cliente por 2 horas para darle soporte |

## Base de datos (al arrancar, todo agregado)
- `maquinas`: `mensaje_bloqueo`, `suspendida_en`.
- `usuarios_duenos`: `mensualidad`, `pagado_hasta`.
- Tabla nueva `pagos_mensualidad` (historial).
- El SQL está en `migraciones/003_clientes.sql`; para deshacer, `migraciones/deshacer_003.sql`.

## Cómo subirlo
1. `git pull` y `git status` limpio.
2. Copia el zip encima. `git status` debe mostrar:
   - modificados: `package.json`, `package-lock.json`, `controllers/machineController.js`, `routes/machineRoutes.js`,
     `routes/superadminRoutes.js`, `services/migraciones.js`, `utils/auditoria.js`
   - nuevos: `controllers/superadminClientesController.js`, `migraciones/003_clientes.sql`,
     `migraciones/deshacer_003.sql` y este archivo.
3. `git add -A`, `git commit -m "v3.4 clientes"`, `git push`.
4. `/salud` debe decir `"version":"3.4.0"`. Luego, el prompt D en Lovable.

## Probado
- La app actual recibe lo mismo que con la v3.1 (más campos nuevos).
- Las 105 comprobaciones de la v3.3 siguen pasando.
- 25 comprobaciones nuevas:
  - El candado ya no se puede usar sin superadmin.
  - Suspender un cliente completo y que la máquina siga registrando ventas.
  - Pago de un mes y pago adelantado sumado a la fecha vigente.
  - Reactivación automática al pagar.
  - La sesión de soporte no entra al superadmin.
  - Auditoría completa.
