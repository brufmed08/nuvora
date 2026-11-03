// Dependencias compartidas y transacciones con rol limitado.
import type { Pool, PoolClient } from "pg";

export interface MensajeCorreo {
  para: string;
  asunto: string;
  texto: string;
}

export interface Dependencias {
  pool: Pool;
  env: (clave: string) => string | undefined;
  entorno: string;
  ahora: () => Date;
  fetch: typeof fetch;
  enviarCorreo?: (mensaje: MensajeCorreo) => Promise<void>;
  cookiesSeguras: boolean;
}

export type Rol = "sigilo_cuentas" | "sigilo_clinico" | "sigilo_soporte";

/**
 * Ejecuta una transacción con un rol limitado. El rol y el consultorio valen solo durante
 * la transacción, así que no se heredan entre peticiones aunque la conexión se reutilice.
 */
export async function enRol<T>(
  deps: Dependencias,
  rol: Rol,
  ajustes: Record<string, string>,
  trabajo: (cliente: PoolClient) => Promise<T>,
): Promise<T> {
  const cliente = await deps.pool.connect();
  try {
    await cliente.query("BEGIN");
    await cliente.query(`SET LOCAL ROLE ${rol}`);
    for (const [clave, valor] of Object.entries(ajustes)) {
      await cliente.query("SELECT set_config($1, $2, true)", [clave, valor]);
    }
    const resultado = await trabajo(cliente);
    await cliente.query("COMMIT");
    return resultado;
  } catch (error) {
    await cliente.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    cliente.release();
  }
}

export const enCuentas = <T,>(deps: Dependencias, trabajo: (c: PoolClient) => Promise<T>) =>
  enRol(deps, "sigilo_cuentas", {}, trabajo);

export const enConsultorio = <T,>(deps: Dependencias, consultorioId: string, trabajo: (c: PoolClient) => Promise<T>) =>
  enRol(deps, "sigilo_clinico", { "sigilo.consultorio": consultorioId }, trabajo);

export function urlBase(deps: Dependencias, req: Request): string {
  const configurada = deps.env("URL_BASE");
  if (configurada) return configurada.replace(/\/$/, "");
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

export function secretoServidor(deps: Dependencias): string {
  const secreto = deps.env("SERVIDOR_CLAVE");
  if (!secreto || secreto.length < 32) {
    throw new Error("Falta SERVIDOR_CLAVE (mínimo 32 caracteres).");
  }
  return secreto;
}

export async function enviarCorreo(deps: Dependencias, mensaje: MensajeCorreo): Promise<void> {
  if (deps.enviarCorreo) return deps.enviarCorreo(mensaje);
  const llave = deps.env("RESEND_API_KEY");
  const remitente = deps.env("CORREO_REMITENTE");
  if (!llave || !remitente) {
    throw new Error("Faltan RESEND_API_KEY o CORREO_REMITENTE para enviar correo.");
  }
  const respuesta = await deps.fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${llave}`, "content-type": "application/json" },
    body: JSON.stringify({ from: remitente, to: [mensaje.para], subject: mensaje.asunto, text: mensaje.texto }),
  });
  if (!respuesta.ok) throw new Error(`El servicio de correo respondió ${respuesta.status}.`);
}
