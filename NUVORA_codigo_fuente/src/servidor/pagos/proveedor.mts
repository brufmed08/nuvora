// Contrato común de las pasarelas de pago.
import type { Ciclo, Plan } from "../planes.mts";

export interface DatosCobro {
  solicitudId: string;
  concepto: string;
  montoCentavos: number;
  plan: Plan;
  ciclo: Ciclo;
  recurrente: boolean;
  cliente: { nombre: string; email: string; telefono?: string | null };
  urlExito: string;
  urlFallo: string;
}

export interface EventoPago {
  id: string;
  tipo: "pago_confirmado" | "pago_fallido" | "suscripcion_cancelada" | "ignorado";
  ordenId?: string;
  clienteProveedor?: string;
}

export interface OrdenConsultada {
  ordenId: string;
  pagada: boolean;
  montoCentavos: number;
  moneda: string;
  metodo: string | null;
  clienteProveedor: string | null;
  solicitudId: string | null;
}

export interface ProveedorPago {
  nombre: string;
  crearCobro(datos: DatosCobro): Promise<{ ordenId: string; url: string }>;
  /** Lanza un error si la firma no es válida. Nunca confía en un aviso sin firma. */
  leerEvento(cuerpo: string, cabeceras: Headers): EventoPago;
  /** Vuelve a preguntar a la pasarela: el aviso por sí solo no basta para dar acceso. */
  consultarOrden(ordenId: string): Promise<OrdenConsultada>;
}

export class FirmaInvalida extends Error {}
