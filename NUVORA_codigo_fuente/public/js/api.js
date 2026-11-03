// Comunicación con el servidor. La demostración sustituye esta salida por un servidor en memoria.
export class ErrorApi extends Error {
  constructor(estado, codigo, mensaje) {
    super(mensaje);
    this.estado = estado;
    this.codigo = codigo;
  }
}

export const esDemo = () => typeof globalThis.__SIGILO_API__ === "function";

export async function api(metodo, ruta, cuerpo) {
  if (esDemo()) return globalThis.__SIGILO_API__(metodo, ruta, cuerpo);
  let respuesta;
  try {
    respuesta = await fetch(ruta, {
      method: metodo,
      credentials: "same-origin",
      headers: cuerpo === undefined ? {} : { "content-type": "application/json" },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
  } catch {
    throw new ErrorApi(0, "sin_conexion", "No hay conexión con el servidor. Revisa tu internet y vuelve a intentar. Tu nota sigue en pantalla.");
  }
  let datos = null;
  try {
    datos = await respuesta.json();
  } catch {
    datos = null;
  }
  if (!respuesta.ok) {
    throw new ErrorApi(respuesta.status, datos?.error ?? "error", datos?.mensaje ?? "Ocurrió un problema. Vuelve a intentar.");
  }
  return datos;
}
