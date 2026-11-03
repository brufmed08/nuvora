// Confirmación de pagos y alta automática de cuentas.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { enCuentas, enviarCorreo, urlBase, type Dependencias } from "../contexto.mts";
import { ErrorHttp } from "../http.mts";
import { PLANES, extenderPeriodo, type Ciclo, type Plan } from "../planes.mts";
import { nuevoToken, sha256 } from "../seguridad.mts";
import { crearConekta } from "./conekta.mts";
import type { EventoPago, ProveedorPago } from "./proveedor.mts";
import { crearSimulado } from "./simulado.mts";

const DIAS_ACTIVACION = 14;

let simulado: ProveedorPago | null = null;

export function obtenerProveedor(deps: Dependencias, req: Request): ProveedorPago {
  const modo = deps.env("PAGOS_MODO") ?? "conekta";
  if (modo === "simulado") {
    if (deps.entorno === "production") {
      throw new Error("La pasarela simulada no puede usarse en producción.");
    }
    simulado ??= crearSimulado(deps.env("SIMULADOR_SECRETO") ?? "secreto-de-desarrollo", () => urlBase(deps, req));
    return simulado;
  }
  const llavePrivada = deps.env("CONEKTA_LLAVE_PRIVADA");
  const llaveWebhook = deps.env("CONEKTA_LLAVE_WEBHOOK");
  if (!llavePrivada || !llaveWebhook) {
    throw new ErrorHttp(503, "pagos_no_configurados", "Los pagos todavía no están disponibles.");
  }
  return crearConekta({
    llavePrivada,
    llaveWebhook: llaveWebhook.replace(/\\n/g, "\n"),
    planes: (plan: Plan, ciclo: Ciclo) => deps.env(`CONEKTA_PLAN_${plan.toUpperCase()}_${ciclo.toUpperCase()}`),
    fetch: deps.fetch,
  });
}

export function conceptoPlan(plan: Plan, ciclo: Ciclo): string {
  return `NUVORA plan ${PLANES[plan].nombre}, ${ciclo === "anual" ? "un año" : "un mes"}`;
}

/** Crea una activación nueva. Se guarda solo el hash: el token vive en el correo o en la página de éxito. */
async function crearActivacion(cliente: PoolClient, deps: Dependencias, consultorioId: string, usuarioId: string): Promise<string> {
  const token = nuevoToken();
  const expira = new Date(deps.ahora().getTime() + DIAS_ACTIVACION * 86400000);
  await cliente.query(
    `INSERT INTO activaciones (token_hash, consultorio_id, usuario_id, tipo, expira_en) VALUES ($1, $2, $3, 'activacion', $4)`,
    [sha256(token), consultorioId, usuarioId, expira],
  );
  return token;
}

export interface ResultadoConfirmacion {
  resultado: "activada" | "renovada" | "duplicado" | "sin_solicitud" | "ignorado";
  aviso?: { email: string; token: string; consultorio: string };
}

/**
 * Procesa un aviso firmado de la pasarela. El orden importa:
 *  1. el evento se registra una sola vez,
 *  2. se vuelve a consultar la orden a la pasarela,
 *  3. se comparan monto y moneda contra lo solicitado,
 *  4. se da de alta o se renueva, todo en una misma transacción.
 */
export async function procesarEvento(
  deps: Dependencias,
  proveedor: ProveedorPago,
  evento: EventoPago,
): Promise<ResultadoConfirmacion> {
  if (evento.tipo === "ignorado") return { resultado: "ignorado" };

  if (evento.tipo === "suscripcion_cancelada" || evento.tipo === "pago_fallido") {
    if (evento.tipo === "suscripcion_cancelada" && evento.clienteProveedor) {
      await enCuentas(deps, (c) =>
        c.query(`UPDATE consultorios SET renovacion = 'manual', actualizado_en = now() WHERE proveedor_cliente = $1`, [
          evento.clienteProveedor,
        ]),
      );
    }
    return { resultado: "ignorado" };
  }

  if (!evento.ordenId) return { resultado: "ignorado" };
  const orden = await proveedor.consultarOrden(evento.ordenId);
  if (!orden.pagada) return { resultado: "ignorado" };

  const salida = await enCuentas(deps, async (c): Promise<ResultadoConfirmacion> => {
    const nuevo = await c.query(
      `INSERT INTO eventos_pago (proveedor, evento_id, tipo) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING evento_id`,
      [proveedor.nombre, evento.id, evento.tipo],
    );
    if (nuevo.rowCount === 0) return { resultado: "duplicado" };

    const yaPagada = await c.query(`SELECT 1 FROM pagos WHERE proveedor = $1 AND proveedor_orden = $2`, [
      proveedor.nombre,
      orden.ordenId,
    ]);
    if ((yaPagada.rowCount ?? 0) > 0) return { resultado: "duplicado" };

    const { rows: solicitudes } = await c.query(
      `SELECT * FROM solicitudes WHERE proveedor = $1 AND proveedor_orden = $2 FOR UPDATE`,
      [proveedor.nombre, orden.ordenId],
    );
    const solicitud = solicitudes[0];
    const ahora = deps.ahora();

    if (!solicitud) {
      // Cargo automático de una suscripción ya existente: se reconoce por el cliente de la pasarela.
      if (!evento.clienteProveedor) return { resultado: "sin_solicitud" };
      const { rows } = await c.query(`SELECT * FROM consultorios WHERE proveedor_cliente = $1 FOR UPDATE`, [
        evento.clienteProveedor,
      ]);
      const consultorio = rows[0];
      if (!consultorio) return { resultado: "sin_solicitud" };
      const esperado = PLANES[consultorio.plan as Plan].precios[consultorio.ciclo as Ciclo];
      if (orden.montoCentavos !== esperado || orden.moneda !== "MXN") {
        throw new Error(`Monto inesperado en la orden ${orden.ordenId}.`);
      }
      await aplicarRenovacion(c, deps, consultorio, orden, proveedor.nombre, null, ahora);
      return { resultado: "renovada" };
    }

    if (orden.montoCentavos !== solicitud.monto_centavos || orden.moneda !== "MXN") {
      throw new Error(`El monto de la orden ${orden.ordenId} no coincide con la solicitud.`);
    }

    if (solicitud.tipo === "renovacion") {
      // El cambio de plan o periodo se aplica hasta que el pago queda confirmado.
      const { rows } = await c.query(
        `UPDATE consultorios SET plan = $2, ciclo = $3, renovacion = $4, proveedor_cliente = coalesce($5, proveedor_cliente), actualizado_en = now()
          WHERE id = $1 RETURNING *`,
        [solicitud.consultorio_id, solicitud.plan, solicitud.ciclo, solicitud.recurrente ? "automatica" : "manual", orden.clienteProveedor],
      );
      await c.query(`UPDATE solicitudes SET estado = 'pagada', pagada_en = $2 WHERE id = $1`, [solicitud.id, ahora]);
      await aplicarRenovacion(c, deps, rows[0], orden, proveedor.nombre, solicitud.id, ahora);
      return { resultado: "renovada" };
    }

    // Alta nueva.
    const consultorioId = randomUUID();
    const usuarioId = randomUUID();
    const hasta = extenderPeriodo(ahora, solicitud.ciclo);
    await c.query(
      `INSERT INTO consultorios (id, nombre, plan, ciclo, estado, renovacion, pagado_hasta, contacto_email, datos_fiscales, proveedor_cliente)
       VALUES ($1, $2, $3, $4, 'pendiente_activacion', $5, $6, $7, $8, $9)`,
      [
        consultorioId,
        solicitud.nombre_consultorio,
        solicitud.plan,
        solicitud.ciclo,
        solicitud.recurrente ? "automatica" : "manual",
        hasta,
        solicitud.email,
        solicitud.datos_fiscales,
        orden.clienteProveedor,
      ],
    );
    await c.query(`INSERT INTO usuarios (id, consultorio_id, email, nombre, rol) VALUES ($1, $2, $3, $4, 'titular')`, [
      usuarioId,
      consultorioId,
      solicitud.email,
      solicitud.nombre_medico,
    ]);
    await c.query(`UPDATE solicitudes SET estado = 'pagada', pagada_en = $2, consultorio_id = $3 WHERE id = $1`, [
      solicitud.id,
      ahora,
      consultorioId,
    ]);
    await c.query(
      `INSERT INTO pagos (consultorio_id, solicitud_id, proveedor, proveedor_orden, monto_centavos, moneda, metodo, periodo_hasta, pagado_en)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [consultorioId, solicitud.id, proveedor.nombre, orden.ordenId, orden.montoCentavos, orden.moneda, orden.metodo, hasta, ahora],
    );
    await c.query(`INSERT INTO bitacora (consultorio_id, usuario_id, accion) VALUES ($1, $2, 'cuenta_pagada')`, [
      consultorioId,
      usuarioId,
    ]);
    const token = await crearActivacion(c, deps, consultorioId, usuarioId);
    return { resultado: "activada", aviso: { email: solicitud.email, token, consultorio: solicitud.nombre_consultorio } };
  });

  return salida;
}

async function aplicarRenovacion(
  c: PoolClient,
  deps: Dependencias,
  consultorio: Record<string, any>,
  orden: { ordenId: string; montoCentavos: number; moneda: string; metodo: string | null },
  proveedor: string,
  solicitudId: string | null,
  ahora: Date,
) {
  const actual = consultorio.pagado_hasta ? new Date(consultorio.pagado_hasta) : ahora;
  const base = actual.getTime() > ahora.getTime() ? actual : ahora;
  const hasta = extenderPeriodo(base, consultorio.ciclo);
  const estado = consultorio.estado === "pendiente_activacion" ? "pendiente_activacion" : "activo";
  await c.query(`UPDATE consultorios SET pagado_hasta = $2, estado = $3, actualizado_en = now() WHERE id = $1`, [
    consultorio.id,
    hasta,
    estado,
  ]);
  await c.query(
    `INSERT INTO pagos (consultorio_id, solicitud_id, proveedor, proveedor_orden, monto_centavos, moneda, metodo, periodo_hasta, pagado_en)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [consultorio.id, solicitudId, proveedor, orden.ordenId, orden.montoCentavos, orden.moneda, orden.metodo, hasta, ahora],
  );
  await c.query(`INSERT INTO bitacora (consultorio_id, accion) VALUES ($1, 'pago_renovacion')`, [consultorio.id]);
  void deps;
}

export function mensajeActivacion(deps: Dependencias, req: Request, aviso: NonNullable<ResultadoConfirmacion["aviso"]>) {
  const enlace = `${urlBase(deps, req)}/app.html#activar/${aviso.token}`;
  return {
    para: aviso.email,
    asunto: "Tu pago se confirmó: activa tu expediente en NUVORA",
    texto: [
      `Recibimos tu pago para ${aviso.consultorio}.`,
      "",
      "Abre este enlace para crear tu contraseña y entrar. Vence en 14 días y solo funciona una vez:",
      enlace,
      "",
      "Durante la activación recibirás un código de recuperación. Guárdalo en un lugar seguro: nadie más, ni nuestro equipo de soporte, puede recuperar tus expedientes sin él.",
    ].join("\n"),
  };
}

export async function avisarActivacion(deps: Dependencias, req: Request, aviso: NonNullable<ResultadoConfirmacion["aviso"]>) {
  await enviarCorreo(deps, mensajeActivacion(deps, req, aviso));
}

/** Enlace de activación para la página de éxito o para reenviarlo por correo. */
export async function nuevaActivacionPendiente(
  deps: Dependencias,
  consultorioId: string,
): Promise<{ token: string; email: string; consultorio: string } | null> {
  return enCuentas(deps, async (c) => {
    const { rows } = await c.query(
      `SELECT u.id AS usuario_id, u.email, co.nombre, co.estado
         FROM consultorios co JOIN usuarios u ON u.consultorio_id = co.id AND u.rol = 'titular'
        WHERE co.id = $1`,
      [consultorioId],
    );
    const fila = rows[0];
    if (!fila || fila.estado !== "pendiente_activacion") return null;
    const token = await crearActivacion(c, deps, consultorioId, fila.usuario_id);
    return { token, email: fila.email, consultorio: fila.nombre };
  });
}
