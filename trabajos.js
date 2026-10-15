/**
 * KYMEZ · Trabajos periódicos   (v2.2)
 * ------------------------------------
 *  cada 1 s   despachar créditos pendientes (outbox)            -> tcn.despacharCreditos
 *  cada 5 s   ventas -> Qhapay (cola con reintentos)
 *  cada 60 s  ventas "omitidas" de máquinas que YA existen en Qhapay -> se vuelven a enviar (v2.3)
 *  cada 30 s  pedidos vencidos -> 'expirado'
 *  cada 60 s  máquinas sin latido · celulares sin latido · celulares "mudos"
 *
 * Todo usa FOR UPDATE SKIP LOCKED o sentencias atómicas: si corres 2 instancias,
 * no se pisan ni duplican nada.
 */
const log = require('./log');

module.exports = function trabajos({ db, tcn }) {
  const QHAPAY_SYNC = process.env.QHAPAY_SYNC === 'true';
  const CEL_LATIDO_MIN = Number(process.env.CELULAR_LATIDO_MAX_MIN || 12);
  const CEL_MUDO_PEDIDOS = Number(process.env.CELULAR_MUDO_PEDIDOS || 5);
  const RECUPERAR_DIAS = Number(process.env.QHAPAY_RECUPERAR_DIAS || 30);
  const intervalos = [];
  const corriendo = new Set();

  // Evita que un trabajo lento se encime consigo mismo
  function cada(ms, nombre, fn) {
    intervalos.push(setInterval(async () => {
      if (corriendo.has(nombre)) return;
      corriendo.add(nombre);
      try { await fn(); } catch (e) { log.error('-', `${nombre}_error`, { error: e.message }); }
      finally { corriendo.delete(nombre); }
    }, ms));
  }

  // ── Qhapay: lee kymez.ventas pendientes y las registra en public.* ───────────
  let tieneFuente = null;
  async function columnaFuente(cli) {
    if (tieneFuente !== null) return tieneFuente;
    const r = await cli.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'historial_ventas' AND column_name = 'fuente'`);
    tieneFuente = r.rowCount > 0;
    return tieneFuente;
  }

  async function registrarUna(cli, v) {
    const maq = await cli.query('SELECT 1 FROM public.maquinas WHERE machine_id = $1', [v.machine_id]);
    if (!maq.rowCount) return { estado: 'omitida', motivo: 'maquina no existe en Qhapay' };

    const s1 = String(v.slot), s2 = String(v.slot).padStart(2, '0');
    const inv = await cli.query(
      `SELECT codigo_motor, nombre_producto, stock FROM public.inventario
       WHERE machine_id = $1 AND codigo_motor IN ($2, $3) LIMIT 1 FOR UPDATE`, [v.machine_id, s1, s2]);
    const codigo = inv.rowCount ? inv.rows[0].codigo_motor : s2;
    // v2.3: si el resorte existe pero no tiene producto, la venta igual se ve como "Producto 45"
    const nombre = (inv.rowCount && String(inv.rows[0].nombre_producto || '').trim()) || `Producto ${s2}`;
    if (inv.rowCount) {
      if (Number(inv.rows[0].stock) <= 0) {
        // Se vendió algo que el sistema creía agotado: el inventario está desfasado
        log.aviso(v.machine_id, 'stock_desfasado', { motor: codigo, producto: nombre,
          accion: 'contar fisicamente y corregir el stock en Qhapay' });
      }
      await cli.query(
        `UPDATE public.inventario SET stock = GREATEST(stock - 1, 0) WHERE machine_id = $1 AND codigo_motor = $2`,
        [v.machine_id, codigo]);
    }
    const cliente = v.metodo === 'yape' ? (v.pagador || 'Desconocido') : 'Efectivo';
    const precio = (v.precio_cent / 100).toFixed(2);
    // v2.3: se guarda la hora REAL de la venta (antes: la hora en que se sincronizó). Importa cuando
    // una venta se recupera tarde, por ejemplo si la máquina se registró en Qhapay después de vender.
    // En UTC explícito: la BD la convierte igual que hace DEFAULT now(), sin importar la zona del servidor
    const fecha = new Date(v.creado_en || Date.now()).toISOString();
    if (await columnaFuente(cli)) {
      await cli.query(
        `INSERT INTO public.historial_ventas (machine_id, codigo_motor, nombre_producto, precio, nombre_cliente, fuente, fecha)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`, [v.machine_id, codigo, nombre, precio, cliente, v.fuente || 'Yape', fecha]);
    } else {
      await cli.query(
        `INSERT INTO public.historial_ventas (machine_id, codigo_motor, nombre_producto, precio, nombre_cliente, fecha)
         VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`, [v.machine_id, codigo, nombre, precio, cliente, fecha]);
    }
    return { estado: 'sincronizada', codigo, nombre, precio, cliente };
  }

  const avisadasOmitidas = new Set();
  async function sincronizarQhapay() {
    if (!QHAPAY_SYNC) return;
    const cli = await db.connect();
    try {
      await cli.query('BEGIN');
      const { rows } = await cli.query(
        `SELECT v.id, v.machine_id, v.slot, v.precio_cent, v.metodo, v.fuente, v.qhapay_intentos, v.creado_en, p.pagador
         FROM kymez.ventas v LEFT JOIN kymez.pagos_yape p ON p.id = v.pago_id
         WHERE v.qhapay_estado IN ('pendiente','error') AND v.qhapay_intentos < 10
         ORDER BY v.id LIMIT 50
         FOR UPDATE OF v SKIP LOCKED`);
      for (const v of rows) {
        await cli.query('SAVEPOINT una');
        try {
          const r = await registrarUna(cli, v);
          await cli.query('RELEASE SAVEPOINT una');
          await cli.query(`UPDATE kymez.ventas SET qhapay_estado = $2, qhapay_error = $3 WHERE id = $1`,
            [v.id, r.estado, r.motivo || null]);
          if (r.estado === 'sincronizada') {
            log.info(v.machine_id, 'qhapay_venta', { venta: v.id, motor: r.codigo, producto: r.nombre, monto: r.precio, cliente: r.cliente });
          } else if (!avisadasOmitidas.has(v.machine_id)) {
            avisadasOmitidas.add(v.machine_id);
            log.aviso(v.machine_id, 'qhapay_sin_maquina', { solucion: `crea en Qhapay una maquina con codigo ${v.machine_id}`,
              nota: 'sus ventas se guardan y se cargaran solas en cuanto la maquina exista en Qhapay' });
          }
        } catch (e) {
          await cli.query('ROLLBACK TO SAVEPOINT una');
          const intentos = v.qhapay_intentos + 1;
          await cli.query(`UPDATE kymez.ventas SET qhapay_estado = 'error', qhapay_intentos = $2, qhapay_error = $3 WHERE id = $1`,
            [v.id, intentos, e.message.slice(0, 300)]);
          if (intentos >= 10) {
            await tcn.incidencia(cli, v.machine_id, 'qhapay_error', null, v.precio_cent, { venta: v.id, error: e.message });
            log.error(v.machine_id, 'qhapay_error', { venta: v.id, monto: log.soles(v.precio_cent), error: e.message,
              accion: 'la venta esta en kymez.ventas pero no en Qhapay' });
          } else {
            log.aviso(v.machine_id, 'qhapay_reintento', { venta: v.id, intento: intentos, error: e.message });
          }
        }
      }
      await cli.query('COMMIT');
    } catch (e) {
      await cli.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      cli.release();
    }
  }

  // ── v2.3: ventas "omitidas" porque la máquina aún no existía en Qhapay ──────
  // En cuanto alguien crea la máquina en Qhapay (con el mismo código), sus ventas de los últimos
  // QHAPAY_RECUPERAR_DIAS días (30 por defecto) vuelven a la cola y entran con su fecha real.
  async function recuperarOmitidas() {
    if (!QHAPAY_SYNC) return;
    const { rows } = await db.query(
      `UPDATE kymez.ventas v
       SET qhapay_estado = 'pendiente', qhapay_intentos = 0, qhapay_error = NULL
       WHERE v.qhapay_estado = 'omitida'
         AND (v.qhapay_error IS NULL OR v.qhapay_error LIKE 'maquina no existe%')
         AND v.creado_en > now() - make_interval(days => $1)
         AND EXISTS (SELECT 1 FROM public.maquinas m WHERE m.machine_id = v.machine_id)
       RETURNING v.machine_id`, [RECUPERAR_DIAS]);
    if (!rows.length) return;
    const porMaquina = {};
    for (const r of rows) porMaquina[r.machine_id] = (porMaquina[r.machine_id] || 0) + 1;
    for (const [maquina, n] of Object.entries(porMaquina)) {
      avisadasOmitidas.delete(maquina);
      log.info(maquina, 'qhapay_recuperadas', { ventas: n, nota: 'la maquina ya existe en Qhapay: se cargan con su fecha real' });
    }
  }

  // ── Pedidos vencidos ────────────────────────────────────────────────────────
  async function expirarPedidos() {
    await db.query(
      `UPDATE kymez.pedidos SET estado = 'expirado', cerrado_en = now()
       WHERE estado = 'abierto' AND expira_en < now()`);
  }

  // ── Máquinas que dejaron de reportar ────────────────────────────────────────
  async function maquinasSinLatido() {
    const { rows } = await db.query(
      `WITH caidas AS (
         UPDATE kymez.maquinas_estado SET online = false
         WHERE online AND actualizado_en < now() - interval '3 minutes'
         RETURNING machine_id
       ), cerrados AS (
         UPDATE kymez.pedidos SET estado = 'cerrado', cerrado_en = now()
         WHERE estado = 'abierto' AND machine_id IN (SELECT machine_id FROM caidas)
       ), inc AS (
         INSERT INTO kymez.incidencias (machine_id, tipo) SELECT machine_id, 'sin_latido' FROM caidas
       )
       SELECT machine_id FROM caidas`);
    // Si se cae el internet de una zona entera, no mandes 200 alertas: una con el resumen
    if (rows.length > 5) {
      log.aviso('-', 'sin_latido_masivo', { maquinas: rows.length, ejemplos: rows.slice(0, 5).map((r) => r.machine_id).join(','),
        motivo: 'muchas maquinas dejaron de reportar a la vez: corte de luz/internet o problema con HiveMQ' });
    } else {
      for (const r of rows) log.aviso(r.machine_id, 'sin_latido', { motivo: 'no reporta hace 3 min (sin luz o sin internet)' });
    }
  }

  // ── Celulares: el punto único de falla del cobro por notificación ───────────
  async function celulares() {
    // a) Celular que dejó de mandar su latido (apagado, sin batería, sin datos)
    const caidos = await db.query(
      `UPDATE kymez.cuentas_cobro SET alerta_enviada_en = now()
       WHERE activa AND ultimo_latido IS NOT NULL
         AND ultimo_latido < now() - make_interval(mins => $1)
         AND (alerta_enviada_en IS NULL OR alerta_enviada_en < ultimo_latido)
       RETURNING id, ultimo_latido`, [CEL_LATIDO_MIN]);
    for (const c of caidos.rows) {
      await db.query(`INSERT INTO kymez.incidencias (tipo, datos) VALUES ('celular_sin_latido', $1)`,
        [{ cuenta: c.id, ultimo_latido: c.ultimo_latido }]);
      log.error('-', 'celular_sin_latido', { telefono: c.id, minutos: CEL_LATIDO_MIN,
        que_pasa: 'los Yapes a ese celular NO llegan a ninguna maquina', accion: 'revisar bateria, datos y MacroDroid' });
    }

    // b) Celular "mudo": vivo, pero hay QRs que expiran sin que llegue NINGUNA notificación
    //    (MacroDroid perdió el permiso de notificaciones, Yape cambió, modo ahorro de batería...)
    const mudos = await db.query(
      `SELECT c.id, count(*)::int AS pedidos_sin_pago
       FROM kymez.cuentas_cobro c
       JOIN kymez.pedidos p ON p.cuenta_cobro_id = c.id
       WHERE c.activa
         AND p.estado = 'expirado' AND p.creado_en > now() - interval '15 minutes'
         AND (c.ultima_notificacion IS NULL OR c.ultima_notificacion < now() - interval '15 minutes')
         AND NOT EXISTS (SELECT 1 FROM kymez.incidencias i
                         WHERE i.tipo = 'celular_mudo' AND NOT i.resuelta AND i.datos->>'cuenta' = c.id
                           AND i.creado_en > now() - interval '1 hour')
       GROUP BY c.id
       HAVING count(*) >= $1`, [CEL_MUDO_PEDIDOS]);
    for (const c of mudos.rows) {
      await db.query(`INSERT INTO kymez.incidencias (tipo, datos) VALUES ('celular_mudo', $1)`,
        [{ cuenta: c.id, pedidos_sin_pago: c.pedidos_sin_pago }]);
      log.error('-', 'celular_mudo', { telefono: c.id, qrs_sin_pago: c.pedidos_sin_pago,
        que_pasa: 'hay clientes con QR abierto pero no llega ninguna notificacion en 15 min',
        accion: 'abrir el celular: permisos de MacroDroid, ahorro de bateria, sesion de Yape' });
    }
  }

  return {
    iniciar() {
      cada(1000, 'despacho', () => tcn.despacharCreditos());
      cada(5000, 'qhapay', sincronizarQhapay);
      cada(60000, 'qhapay_recuperar', recuperarOmitidas);
      cada(30000, 'pedidos', expirarPedidos);
      cada(60000, 'latidos', maquinasSinLatido);
      cada(60000, 'celulares', celulares);
    },
    async detener() {
      intervalos.forEach(clearInterval);
      const t0 = Date.now();
      while (corriendo.size && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 100));
    },
    // para pruebas
    sincronizarQhapay, recuperarOmitidas, expirarPedidos, maquinasSinLatido, celulares,
  };
};
