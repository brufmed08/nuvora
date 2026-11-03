// Pasarela simulada para desarrollo y pruebas. Se niega a funcionar en producción (ver servicio.mts).
// Reproduce lo que importa de la real: aviso firmado, y confirmación consultando la orden.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { FirmaInvalida, type DatosCobro, type EventoPago, type OrdenConsultada, type ProveedorPago } from "./proveedor.mts";

interface OrdenSimulada extends OrdenConsultada {
  urlExito: string;
  urlFallo: string;
}

const ordenes = new Map<string, OrdenSimulada>();

export function firmarSimulado(secreto: string, cuerpo: string): string {
  return createHmac("sha256", secreto).update(cuerpo).digest("base64");
}

export function marcarOrdenPagada(ordenId: string, metodo = "card"): OrdenSimulada {
  const orden = ordenes.get(ordenId);
  if (!orden) throw new Error("orden_desconocida");
  orden.pagada = true;
  orden.metodo = metodo;
  return orden;
}

export function crearSimulado(secreto: string, urlBase: () => string): ProveedorPago {
  return {
    nombre: "simulado",

    async crearCobro(datos: DatosCobro) {
      const ordenId = `sim_${randomUUID()}`;
      ordenes.set(ordenId, {
        ordenId,
        pagada: false,
        montoCentavos: datos.montoCentavos,
        moneda: "MXN",
        metodo: null,
        clienteProveedor: datos.recurrente ? `cus_${ordenId}` : null,
        solicitudId: datos.solicitudId,
        urlExito: datos.urlExito,
        urlFallo: datos.urlFallo,
      });
      return { ordenId, url: `${urlBase()}/simulador-pago.html?orden=${encodeURIComponent(ordenId)}` };
    },

    leerEvento(cuerpo: string, cabeceras: Headers): EventoPago {
      const firma = cabeceras.get("digest") ?? "";
      const esperada = firmarSimulado(secreto, cuerpo);
      const a = Buffer.from(firma);
      const b = Buffer.from(esperada);
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw new FirmaInvalida("La firma del aviso no es válida.");
      const evento = JSON.parse(cuerpo) as { id: string; type: string; orden: string };
      if (evento.type === "order.paid") return { id: evento.id, tipo: "pago_confirmado", ordenId: evento.orden };
      return { id: evento.id, tipo: "ignorado" };
    },

    async consultarOrden(ordenId: string): Promise<OrdenConsultada> {
      const orden = ordenes.get(ordenId);
      if (!orden) throw new Error("orden_desconocida");
      return orden;
    },
  };
}

export function urlsSimuladas(ordenId: string) {
  const orden = ordenes.get(ordenId);
  return orden ? { exito: orden.urlExito, fallo: orden.urlFallo, monto: orden.montoCentavos } : null;
}
