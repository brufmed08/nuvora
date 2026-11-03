// Integración con Conekta: checkout hospedado, webhooks firmados con RSA y suscripciones con tarjeta.
// Referencias: developers.conekta.com/docs/checkout-redireccionado, /docs/component,
// /docs/autenticación-webhooks y /docs/notificaciones-por-webhook.
import { createVerify } from "node:crypto";
import type { Ciclo, Plan } from "../planes.mts";
import { FirmaInvalida, type DatosCobro, type EventoPago, type OrdenConsultada, type ProveedorPago } from "./proveedor.mts";

const API = "https://api.conekta.io";
const VERSION = "application/vnd.conekta-v2.3.0+json";

export interface ConfiguracionConekta {
  llavePrivada: string;
  llaveWebhook: string;
  planes: (plan: Plan, ciclo: Ciclo) => string | undefined;
  fetch: typeof fetch;
}

export function crearConekta(config: ConfiguracionConekta): ProveedorPago {
  const llamar = async (metodo: string, ruta: string, cuerpo?: unknown) => {
    const respuesta = await config.fetch(`${API}${ruta}`, {
      method: metodo,
      headers: {
        accept: VERSION,
        "accept-language": "es",
        authorization: `Bearer ${config.llavePrivada}`,
        "content-type": "application/json",
      },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    const datos = (await respuesta.json().catch(() => ({}))) as Record<string, any>;
    if (!respuesta.ok) {
      const detalle = datos?.details?.[0]?.message ?? datos?.message ?? `HTTP ${respuesta.status}`;
      throw new Error(`Conekta rechazó la solicitud: ${detalle}`);
    }
    return datos;
  };

  return {
    nombre: "conekta",

    async crearCobro(datos: DatosCobro) {
      const checkout: Record<string, unknown> = {
        type: "HostedPayment",
        name: datos.concepto.slice(0, 120),
        success_url: datos.urlExito,
        failure_url: datos.urlFallo,
        redirection_time: 4,
      };
      if (datos.recurrente) {
        const planConekta = config.planes(datos.plan, datos.ciclo);
        if (!planConekta) throw new Error(`Falta el plan de Conekta para ${datos.plan}/${datos.ciclo}.`);
        checkout.plan_ids = [planConekta];
        // Las suscripciones de Conekta solo admiten tarjeta.
        checkout.excluded_payment_methods = ["cash", "bank_transfer", "bnpl", "pay_by_bank"];
      } else {
        checkout.excluded_payment_methods = ["bnpl"];
      }
      const orden = await llamar("POST", "/orders", {
        currency: "MXN",
        customer_info: {
          name: datos.cliente.nombre,
          email: datos.cliente.email,
          phone: datos.cliente.telefono || "0000000000",
        },
        line_items: [{ name: datos.concepto.slice(0, 120), quantity: 1, unit_price: datos.montoCentavos }],
        metadata: { solicitud_id: datos.solicitudId },
        checkout,
      });
      const url = orden?.checkout?.url;
      if (!orden?.id || !url) throw new Error("Conekta no devolvió la página de pago.");
      return { ordenId: String(orden.id), url: String(url) };
    },

    leerEvento(cuerpo: string, cabeceras: Headers): EventoPago {
      const firma = cabeceras.get("digest");
      if (!firma) throw new FirmaInvalida("Aviso sin firma.");
      const verificador = createVerify("RSA-SHA256");
      verificador.update(cuerpo, "utf8");
      verificador.end();
      let valida = false;
      try {
        valida = verificador.verify(config.llaveWebhook, firma, "base64");
      } catch {
        valida = false;
      }
      if (!valida) throw new FirmaInvalida("La firma del aviso no es válida.");

      const evento = JSON.parse(cuerpo) as Record<string, any>;
      const tipo = String(evento.type ?? "");
      const objeto = evento?.data?.object ?? {};
      const id = String(evento.id ?? `${tipo}:${objeto.id ?? ""}`);
      switch (tipo) {
        case "order.paid":
          return { id, tipo: "pago_confirmado", ordenId: String(objeto.id) };
        case "subscription.paid":
          return {
            id,
            tipo: "pago_confirmado",
            ordenId: String(objeto.last_billing_cycle_order_id ?? ""),
            clienteProveedor: objeto.customer_id ? String(objeto.customer_id) : undefined,
          };
        case "subscription.payment_failed":
          return { id, tipo: "pago_fallido", clienteProveedor: objeto.customer_id ? String(objeto.customer_id) : undefined };
        case "subscription.canceled":
          return { id, tipo: "suscripcion_cancelada", clienteProveedor: objeto.customer_id ? String(objeto.customer_id) : undefined };
        default:
          return { id, tipo: "ignorado" };
      }
    },

    async consultarOrden(ordenId: string): Promise<OrdenConsultada> {
      const orden = await llamar("GET", `/orders/${encodeURIComponent(ordenId)}`);
      const cargo = orden?.charges?.data?.[0];
      return {
        ordenId,
        pagada: orden?.payment_status === "paid",
        montoCentavos: Number(orden?.amount ?? 0),
        moneda: String(orden?.currency ?? "").toUpperCase(),
        metodo: cargo?.payment_method?.type ? String(cargo.payment_method.type) : null,
        clienteProveedor: orden?.customer_info?.customer_id ? String(orden.customer_info.customer_id) : null,
        solicitudId: orden?.metadata?.solicitud_id ? String(orden.metadata.solicitud_id) : null,
      };
    },
  };
}
