// Servidor de desarrollo y de pruebas de punta a punta: sirve /public y atiende /api con el mismo código de producción.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import pg from "pg";
import { crearManejador } from "../src/servidor/app.mts";

const TIPOS: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const correos: { para: string; asunto: string; texto: string }[] = [];
const puerto = Number(process.env.PUERTO ?? 8899);
const pool = new pg.Pool({ connectionString: process.env.SIGILO_DB_URL, max: 8 });
const variables: Record<string, string> = {
  SERVIDOR_CLAVE: process.env.SERVIDOR_CLAVE ?? "clave-de-desarrollo-de-al-menos-32-caracteres",
  SOPORTE_TOKEN_INSTALACION: process.env.SOPORTE_TOKEN_INSTALACION ?? "token-local",
  PAGOS_MODO: "simulado",
  SIMULADOR_SECRETO: "secreto-simulador",
};
const manejar = crearManejador({
  pool,
  env: (k) => variables[k],
  entorno: "development",
  ahora: () => new Date(),
  fetch: globalThis.fetch,
  enviarCorreo: async (m) => {
    correos.push(m);
  },
  cookiesSeguras: false,
});

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname === "/__correos") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(correos));
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    const trozos: Buffer[] = [];
    for await (const t of req) trozos.push(t as Buffer);
    const cuerpo = Buffer.concat(trozos);
    const peticion = new Request(url, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : cuerpo,
    });
    const respuesta = await manejar(peticion);
    res.statusCode = respuesta.status;
    respuesta.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(Buffer.from(await respuesta.arrayBuffer()));
    return;
  }
  const relativa = url.pathname === "/" ? "/index.html" : url.pathname;
  const ruta = normalize(join("public", relativa));
  if (!ruta.startsWith("public")) {
    res.statusCode = 403;
    res.end();
    return;
  }
  try {
    const datos = await readFile(ruta);
    res.setHeader("content-type", TIPOS[extname(ruta)] ?? "application/octet-stream");
    res.setHeader("content-security-policy", CSP);
    res.end(datos);
  } catch {
    res.statusCode = 404;
    res.end("No encontrado");
  }
}).listen(puerto, () => console.log(`NUVORA local en http://localhost:${puerto}`));
