// Catálogo de planes. Los precios están en centavos de peso e incluyen IVA.
export type Plan = "esencial" | "profesional" | "clinica";
export type Ciclo = "mensual" | "anual";
export type Modulo = "notas" | "recetas" | "marca" | "exportar" | "bitacora" | "crecimiento" | "familia";

export interface DefinicionPlan {
  nombre: string;
  precios: Record<Ciclo, number>;
  medicos: number;
  asistentes: number;
  modulos: Modulo[];
}

const BASE: Modulo[] = ["notas", "recetas", "marca", "exportar", "bitacora"];

export const PLANES: Record<Plan, DefinicionPlan> = {
  esencial: {
    nombre: "Esencial",
    precios: { mensual: 34900, anual: 349000 },
    medicos: 1,
    asistentes: 1,
    modulos: BASE,
  },
  profesional: {
    nombre: "Profesional",
    precios: { mensual: 54900, anual: 549000 },
    medicos: 1,
    asistentes: 2,
    modulos: [...BASE, "crecimiento", "familia"],
  },
  clinica: {
    nombre: "Clínica",
    precios: { mensual: 149000, anual: 1490000 },
    medicos: 5,
    asistentes: 5,
    modulos: [...BASE, "crecimiento", "familia"],
  },
};

export const DIAS_GRACIA = 7;

export function esPlan(valor: unknown): valor is Plan {
  return valor === "esencial" || valor === "profesional" || valor === "clinica";
}

export function esCiclo(valor: unknown): valor is Ciclo {
  return valor === "mensual" || valor === "anual";
}

/** Fin del periodo pagado: nunca descuenta tiempo que el cliente ya tenía pagado. */
export function extenderPeriodo(desde: Date, ciclo: Ciclo): Date {
  const fin = new Date(desde.getTime());
  const dia = fin.getUTCDate();
  fin.setUTCMonth(fin.getUTCMonth() + (ciclo === "anual" ? 12 : 1));
  // 31 de enero + 1 mes no debe saltar a marzo.
  if (fin.getUTCDate() !== dia) fin.setUTCDate(0);
  return fin;
}

export type EstadoEfectivo = "pendiente_activacion" | "activo" | "gracia" | "solo_lectura" | "cancelado";

export function estadoEfectivo(
  consultorio: { estado: string; pagado_hasta: Date | string | null },
  ahora: Date,
): EstadoEfectivo {
  if (consultorio.estado === "pendiente_activacion") return "pendiente_activacion";
  if (consultorio.estado === "cancelado") return "cancelado";
  if (consultorio.estado === "solo_lectura") return "solo_lectura";
  if (!consultorio.pagado_hasta) return "solo_lectura";
  const hasta = new Date(consultorio.pagado_hasta).getTime();
  if (ahora.getTime() <= hasta) return "activo";
  if (ahora.getTime() <= hasta + DIAS_GRACIA * 86400000) return "gracia";
  return "solo_lectura";
}

export function puedeEscribir(estado: EstadoEfectivo): boolean {
  return estado === "activo" || estado === "gracia";
}
