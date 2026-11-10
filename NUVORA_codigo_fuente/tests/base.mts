// Arnés de pruebas: Postgres real, con un dueño parecido al de un servicio administrado
// (puede crear roles y saltarse RLS), para demostrar que el aislamiento no depende de su buena conducta.
import { readFileSync, readdirSync } from "node:fs";
import pg from "pg";
import { crearManejador, reiniciarVerificacionParaPruebas } from "../src/servidor/app.mts";
import type { Dependencias, MensajeCorreo } from "../src/servidor/contexto.mts";
import * as cripto from "../public/js/cripto.js";

const ADMIN = process.env.PRUEBAS_DB_ADMIN ?? "postgres://neondb_owner:pruebas@127.0.0.1:5432/postgres";

export const ITER_PRUEBA = 100_000;

export async function crearEntorno(extra: Record<string, string> = {}, opciones: Partial<Dependencias> = {}) {
  const nombre = `sigilo_prueba_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${nombre}`);
  await admin.end();

  const url = new URL(ADMIN);
  url.pathname = `/${nombre}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
  // Las migraciones viven en la raíz del repositorio, una carpeta por versión, como las lee Netlify.
  const MIGRACIONES = "../netlify/database/migrations";
  for (const version of readdirSync(MIGRACIONES).sort()) {
    await pool.query(readFileSync(`${MIGRACIONES}/${version}/migration.sql`, "utf8"));
  }
  reiniciarVerificacionParaPruebas();

  const correos: MensajeCorreo[] = [];
  let reloj: Date | null = null;
  const variables: Record<string, string> = {
    SERVIDOR_CLAVE: "clave-de-pruebas-de-al-menos-32-caracteres",
    SOPORTE_TOKEN_INSTALACION: "token-instalacion",
    PAGOS_MODO: "simulado",
    SIMULADOR_SECRETO: "secreto-simulador",
    ...extra,
  };
  const deps: Dependencias = {
    pool,
    env: (k) => variables[k],
    entorno: "test",
    ahora: () => reloj ?? new Date(),
    fetch: globalThis.fetch,
    enviarCorreo: async (m) => {
      correos.push(m);
    },
    cookiesSeguras: false,
    ...opciones,
  };
  const manejar = crearManejador(deps);

  async function llamar(metodo: string, ruta: string, cuerpo?: unknown, cookie?: string, cabeceras: Record<string, string> = {}) {
    const respuesta = await manejar(
      new Request(`http://localhost:8888${ruta}`, {
        method: metodo,
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...cabeceras },
        body: cuerpo === undefined ? undefined : typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo),
      }),
    );
    const texto = await respuesta.text();
    let datos: any = null;
    try {
      datos = JSON.parse(texto);
    } catch {
      datos = texto;
    }
    const setCookie = respuesta.headers.get("set-cookie");
    return { estado: respuesta.status, datos, cookie: setCookie ? setCookie.split(";")[0] : undefined, setCookie };
  }

  return {
    pool,
    deps,
    variables,
    correos,
    llamar,
    fijarReloj: (fecha: Date | null) => {
      reloj = fecha;
    },
    cerrar: async () => {
      await pool.end();
      const a = new pg.Client({ connectionString: ADMIN });
      await a.connect();
      await a.query(`DROP DATABASE ${nombre} WITH (FORCE)`);
      await a.end();
    },
  };
}

export type Entorno = Awaited<ReturnType<typeof crearEntorno>>;

export async function instalarSoporte(e: Entorno, correo = "soporte@sigilo.test", contrasena = "contrasena-soporte-1") {
  const par = await cripto.nuevoParSoporte();
  const sal = cripto.nuevaSal();
  const { authKey, llaveEnvoltura } = await cripto.derivarDeContrasena(contrasena, sal, ITER_PRUEBA);
  const r = await e.llamar("POST", "/api/soporte/instalar", {
    token: "token-instalacion",
    email: correo,
    nombre: "Agente Uno",
    kdf_sal: sal,
    kdf_iter: ITER_PRUEBA,
    auth_key: authKey,
    llave_publica: par.publica,
    llave_envuelta: await cripto.envolverPrivadaSoporte(par.privadaBytes, llaveEnvoltura),
  });
  return { ...r, publica: par.publica, privada: await cripto.importarPrivadaSoporte(par.privadaBytes), contrasena, correo };
}

/** Recorre el flujo completo: checkout, pago simulado, activación. Devuelve la sesión del titular. */
export async function crearConsultorio(
  e: Entorno,
  publica: string,
  correo: string,
  contrasena: string,
  opciones: { plan?: string; ciclo?: string; nombre?: string } = {},
) {
  const { plan = "profesional", ciclo = "mensual", nombre = "Consultorio de prueba" } = opciones;
  const checkout = await e.llamar("POST", "/api/checkout", {
    plan,
    ciclo,
    email: correo,
    nombre_consultorio: nombre,
    nombre_medico: "Dra. Prueba",
    acepto_terminos: true,
  });
  if (checkout.estado !== 201) throw new Error(`checkout: ${JSON.stringify(checkout.datos)}`);
  const orden = new URL(checkout.datos.url).searchParams.get("orden")!;
  const pago = await e.llamar("POST", "/api/simulador/pagar", { orden });
  if (pago.estado !== 200) throw new Error(`pago: ${JSON.stringify(pago.datos)}`);
  const correoActivacion = e.correos.filter((c) => c.para === correo).at(-1)!;
  const token = /#activar\/([\w-]+)/.exec(correoActivacion.texto)![1];

  const sal = cripto.nuevaSal();
  const { authKey, llaveEnvoltura } = await cripto.derivarDeContrasena(contrasena, sal, ITER_PRUEBA);
  const tk = cripto.nuevaLlaveConsultorio();
  const codigo = cripto.nuevoCodigoRecuperacion();
  const rec = await cripto.derivarDeCodigo(codigo);
  const activar = await e.llamar("POST", `/api/activacion/${token}`, {
    kdf_sal: sal,
    kdf_iter: ITER_PRUEBA,
    auth_key: authKey,
    tk_envuelta: await cripto.envolverLlave(tk, llaveEnvoltura),
    rec_auth: rec.recAuth,
    tk_envuelta_rec: await cripto.envolverLlave(tk, rec.llaveEnvoltura),
  });
  if (activar.estado !== 200) throw new Error(`activar: ${JSON.stringify(activar.datos)}`);
  return {
    cookie: activar.cookie!,
    consultorioId: activar.datos.consultorio.id as string,
    usuarioId: activar.datos.usuario.id as string,
    tkBytes: tk,
    llave: await cripto.importarLlaveConsultorio(tk),
    codigo,
    correo,
    contrasena,
    publica,
  };
}

export type Consultorio = Awaited<ReturnType<typeof crearConsultorio>>;

export async function crearPaciente(e: Entorno, co: Consultorio, datos: { nombre: string; [k: string]: unknown }) {
  const id = cripto.nuevoId();
  const r = await e.llamar(
    "POST",
    "/api/pacientes",
    {
      id,
      cifrado: await cripto.cifrarJson(co.llave, datos, cripto.contexto(co.consultorioId, "paciente", id)),
      nombre_sellado: await cripto.sellarNombre(co.publica, datos.nombre),
    },
    co.cookie,
  );
  if (r.estado !== 201) throw new Error(`paciente: ${JSON.stringify(r.datos)}`);
  return id;
}

export async function crearRegistro(e: Entorno, co: Consultorio, pacienteId: string, tipo: string, contenido: unknown, cookie?: string) {
  const id = cripto.nuevoId();
  return e.llamar(
    "POST",
    `/api/pacientes/${pacienteId}/registros`,
    { registros: [{ id, tipo, cifrado: await cripto.cifrarJson(co.llave, contenido, cripto.contexto(co.consultorioId, tipo, id)) }] },
    cookie ?? co.cookie,
  );
}

export { cripto };
