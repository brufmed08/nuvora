// Utilidades HTTP y validación de entrada.
export class ErrorHttp extends Error {
  constructor(
    public estado: number,
    public codigo: string,
    mensaje: string,
  ) {
    super(mensaje);
  }
}

const CABECERAS_BASE: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export function json(datos: unknown, estado = 200, cabeceras: Record<string, string | string[]> = {}): Response {
  const salida = new Headers(CABECERAS_BASE);
  for (const [nombre, valor] of Object.entries(cabeceras)) {
    if (Array.isArray(valor)) valor.forEach((v) => salida.append(nombre, v));
    else salida.set(nombre, valor);
  }
  return new Response(JSON.stringify(datos), { status: estado, headers: salida });
}

export function leerCookie(req: Request, nombre: string): string | null {
  const encabezado = req.headers.get("cookie");
  if (!encabezado) return null;
  for (const parte of encabezado.split(";")) {
    const [clave, ...resto] = parte.trim().split("=");
    if (clave === nombre) return resto.join("=");
  }
  return null;
}

export function cookieSesion(nombre: string, valor: string, segundos: number, segura: boolean): string {
  return [
    `${nombre}=${valor}`,
    "Path=/api",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${segundos}`,
    segura ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

const LIMITE_CUERPO = 1_500_000;

export async function leerCuerpo(req: Request): Promise<Record<string, unknown>> {
  const texto = await req.text();
  if (texto.length > LIMITE_CUERPO) throw new ErrorHttp(413, "demasiado_grande", "La información enviada es demasiado grande.");
  if (!texto) return {};
  try {
    const valor = JSON.parse(texto);
    if (valor && typeof valor === "object" && !Array.isArray(valor)) return valor as Record<string, unknown>;
  } catch {
    // cae al error de abajo
  }
  throw new ErrorHttp(400, "solicitud_invalida", "La solicitud no tiene un formato válido.");
}

function invalido(campo: string, detalle: string): ErrorHttp {
  return new ErrorHttp(400, "dato_invalido", `${campo}: ${detalle}`);
}

export function texto(valor: unknown, campo: string, opciones: { min?: number; max?: number } = {}): string {
  const { min = 1, max = 300 } = opciones;
  if (typeof valor !== "string") throw invalido(campo, "falta este dato.");
  const limpio = valor.trim();
  if (limpio.length < min) throw invalido(campo, "falta este dato.");
  if (limpio.length > max) throw invalido(campo, `máximo ${max} caracteres.`);
  return limpio;
}

export function textoOpcional(valor: unknown, campo: string, max = 300): string | null {
  if (valor === undefined || valor === null || valor === "") return null;
  return texto(valor, campo, { max });
}

const PATRON_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function uuid(valor: unknown, campo = "id"): string {
  if (typeof valor !== "string" || !PATRON_UUID.test(valor)) throw invalido(campo, "identificador no válido.");
  return valor.toLowerCase();
}

const PATRON_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function email(valor: unknown, campo = "correo"): string {
  const limpio = texto(valor, campo, { max: 254 }).toLowerCase();
  if (!PATRON_EMAIL.test(limpio)) throw invalido(campo, "escribe un correo válido.");
  return limpio;
}

const PATRON_SOBRE = /^[A-Za-z0-9+/=._-]+$/;

/** Texto cifrado o llave en base64. Solo se comprueba forma y tamaño: el servidor no puede leerlo. */
export function sobre(valor: unknown, campo: string, max = 400_000): string {
  if (typeof valor !== "string" || valor.length === 0) throw invalido(campo, "falta este dato.");
  if (valor.length > max) throw invalido(campo, "demasiado grande.");
  if (!PATRON_SOBRE.test(valor)) throw invalido(campo, "formato no válido.");
  return valor;
}

export function entero(valor: unknown, campo: string, min: number, max: number): number {
  if (typeof valor !== "number" || !Number.isInteger(valor) || valor < min || valor > max) {
    throw invalido(campo, `debe estar entre ${min} y ${max}.`);
  }
  return valor;
}
