// Punto de entrada del servidor: recibe un Request y devuelve un Response.
// No depende de Netlify, así que las pruebas ejercitan exactamente este mismo código.
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import {
  enConsultorio,
  enCuentas,
  enRol,
  enviarCorreo,
  secretoServidor,
  urlBase,
  type Dependencias,
} from "./contexto.mts";
import {
  ErrorHttp,
  cookieSesion,
  email as validarEmail,
  entero,
  json,
  leerCookie,
  leerCuerpo,
  sobre,
  texto,
  textoOpcional,
  uuid,
} from "./http.mts";
import { FirmaInvalida } from "./pagos/proveedor.mts";
import {
  avisarActivacion,
  conceptoPlan,
  mensajeActivacion,
  nuevaActivacionPendiente,
  obtenerProveedor,
  procesarEvento,
} from "./pagos/servicio.mts";
import { firmarSimulado, marcarOrdenPagada, urlsSimuladas } from "./pagos/simulado.mts";
import { PLANES, esCiclo, esPlan, estadoEfectivo, puedeEscribir, type Ciclo, type Plan } from "./planes.mts";
import {
  cifrarServidor,
  descifrarServidor,
  igualesSeguro,
  nuevoSecretoTotp,
  nuevoToken,
  protegerLlaveAuth,
  salFicticia,
  sha256,
  verificarLlaveAuth,
  verificarTotp,
} from "./seguridad.mts";

const COOKIE = "sg_sesion";
const COOKIE_SOPORTE = "sg_soporte";
const HORAS_SESION = 12;
const HORAS_SESION_SOPORTE = 8;
const ITERACIONES_POR_DEFECTO = 600_000;
const MAX_FALLOS = 8;
const MINUTOS_BLOQUEO = 15;

interface Sesion {
  usuarioId: string;
  consultorioId: string;
  email: string;
  nombre: string;
  rol: "titular" | "medico" | "asistente";
  cedula: string | null;
  debeCambiar: boolean;
  kdfSal: string;
  kdfIter: number;
  tkEnvuelta: string;
  consultorio: Record<string, any>;
}

interface SesionSoporte {
  soporteId: string;
  email: string;
  nombre: string;
  rol: "agente" | "administrador";
  debeCambiar: boolean;
  kdfSal: string;
  kdfIter: number;
  llaveEnvuelta: string;
}

type Contexto = { req: Request; deps: Dependencias; ip: string; parametros: Record<string, string>; url: URL };
type Manejador = (ctx: Contexto) => Promise<Response>;

// ---------------------------------------------------------------------------
// Utilidades de cuenta
// ---------------------------------------------------------------------------

function resumenConsultorio(fila: Record<string, any>, ahora: Date) {
  const plan = PLANES[fila.plan as Plan];
  const estado = estadoEfectivo(fila as { estado: string; pagado_hasta: Date | null }, ahora);
  return {
    id: fila.id,
    nombre: fila.nombre,
    plan: fila.plan,
    plan_nombre: plan.nombre,
    ciclo: fila.ciclo,
    estado,
    puede_escribir: puedeEscribir(estado),
    renovacion: fila.renovacion,
    pagado_hasta: fila.pagado_hasta,
    marca: fila.marca ?? {},
    modulos: plan.modulos,
    limites: { medicos: plan.medicos, asistentes: plan.asistentes },
  };
}

function exigirEscritura(sesion: Sesion, deps: Dependencias) {
  const estado = estadoEfectivo(sesion.consultorio as { estado: string; pagado_hasta: Date | null }, deps.ahora());
  if (!puedeEscribir(estado)) {
    throw new ErrorHttp(402, "cuenta_solo_lectura", "Tu plan venció. Puedes consultar y exportar tus expedientes; renueva para seguir registrando.");
  }
}

function exigirRol(sesion: Sesion, ...roles: Sesion["rol"][]) {
  if (!roles.includes(sesion.rol)) throw new ErrorHttp(403, "sin_permiso", "Tu rol no tiene permiso para esta acción.");
}

function exigirModulo(sesion: Sesion, modulo: string) {
  const plan = PLANES[sesion.consultorio.plan as Plan];
  if (!plan.modulos.includes(modulo as never)) {
    throw new ErrorHttp(403, "modulo_no_incluido", "Esta función no está incluida en tu plan.");
  }
}

async function comprobarBloqueo(deps: Dependencias, clave: string) {
  const { rows } = await enCuentas(deps, (c) =>
    c.query(`SELECT bloqueado_hasta FROM intentos_acceso WHERE clave = $1`, [clave]),
  );
  const hasta = rows[0]?.bloqueado_hasta;
  if (hasta && new Date(hasta).getTime() > deps.ahora().getTime()) {
    throw new ErrorHttp(429, "acceso_bloqueado", `Demasiados intentos. Espera ${MINUTOS_BLOQUEO} minutos y vuelve a intentar.`);
  }
}

async function registrarFallo(deps: Dependencias, clave: string) {
  await enCuentas(deps, (c) =>
    c.query(
      `INSERT INTO intentos_acceso (clave, fallos) VALUES ($1, 1)
       ON CONFLICT (clave) DO UPDATE SET
         fallos = CASE WHEN intentos_acceso.fallos + 1 >= $2 THEN 0 ELSE intentos_acceso.fallos + 1 END,
         bloqueado_hasta = CASE WHEN intentos_acceso.fallos + 1 >= $2 THEN $3::timestamptz ELSE intentos_acceso.bloqueado_hasta END,
         actualizado_en = now()`,
      [clave, MAX_FALLOS, new Date(deps.ahora().getTime() + MINUTOS_BLOQUEO * 60000)],
    ),
  );
}

async function limpiarFallos(deps: Dependencias, clave: string) {
  await enCuentas(deps, (c) => c.query(`DELETE FROM intentos_acceso WHERE clave = $1`, [clave]));
}

const claveAcceso = (tipo: string, correo: string) => sha256(`${tipo}|${correo}`);

async function iniciarSesion(c: PoolClient, deps: Dependencias, usuarioId: string, consultorioId: string) {
  const token = nuevoToken();
  const expira = new Date(deps.ahora().getTime() + HORAS_SESION * 3600000);
  await c.query(`INSERT INTO sesiones (token_hash, usuario_id, consultorio_id, expira_en) VALUES ($1, $2, $3, $4)`, [
    sha256(token),
    usuarioId,
    consultorioId,
    expira,
  ]);
  await c.query(`UPDATE usuarios SET ultimo_acceso = $2 WHERE id = $1`, [usuarioId, deps.ahora()]);
  await c.query(`INSERT INTO bitacora (consultorio_id, usuario_id, accion) VALUES ($1, $2, 'acceso')`, [consultorioId, usuarioId]);
  return cookieSesion(COOKIE, token, HORAS_SESION * 3600, deps.cookiesSeguras);
}

async function leerSesion(ctx: Contexto): Promise<Sesion> {
  const token = leerCookie(ctx.req, COOKIE);
  if (!token) throw new ErrorHttp(401, "sin_sesion", "Tu sesión terminó. Vuelve a entrar.");
  const { rows } = await enCuentas(ctx.deps, (c) =>
    c.query(
      `SELECT s.expira_en, u.id AS usuario_id, u.email, u.nombre AS usuario_nombre, u.rol, u.cedula, u.debe_cambiar,
              u.desactivado_en, u.kdf_sal, u.kdf_iter, u.tk_envuelta, co.*
         FROM sesiones s
         JOIN usuarios u ON u.id = s.usuario_id
         JOIN consultorios co ON co.id = s.consultorio_id
        WHERE s.token_hash = $1`,
      [sha256(token)],
    ),
  );
  const fila = rows[0];
  if (!fila || new Date(fila.expira_en).getTime() < ctx.deps.ahora().getTime() || fila.desactivado_en) {
    throw new ErrorHttp(401, "sin_sesion", "Tu sesión terminó. Vuelve a entrar.");
  }
  return {
    usuarioId: fila.usuario_id,
    consultorioId: fila.id,
    email: fila.email,
    nombre: fila.usuario_nombre,
    rol: fila.rol,
    cedula: fila.cedula,
    debeCambiar: fila.debe_cambiar,
    kdfSal: fila.kdf_sal,
    kdfIter: fila.kdf_iter,
    tkEnvuelta: fila.tk_envuelta,
    consultorio: fila,
  };
}

function datosSesion(sesion: Sesion, deps: Dependencias) {
  return {
    usuario: {
      id: sesion.usuarioId,
      email: sesion.email,
      nombre: sesion.nombre,
      rol: sesion.rol,
      cedula: sesion.cedula,
      debe_cambiar: sesion.debeCambiar,
    },
    consultorio: resumenConsultorio(sesion.consultorio, deps.ahora()),
    kdf_sal: sesion.kdfSal,
    kdf_iter: sesion.kdfIter,
    tk_envuelta: sesion.tkEnvuelta,
  };
}

function credenciales(cuerpo: Record<string, unknown>) {
  return {
    kdfSal: sobre(cuerpo.kdf_sal, "kdf_sal", 64),
    kdfIter: entero(cuerpo.kdf_iter, "kdf_iter", 100_000, 10_000_000),
    authKey: sobre(cuerpo.auth_key, "auth_key", 128),
    tkEnvuelta: sobre(cuerpo.tk_envuelta, "tk_envuelta", 512),
  };
}

const bitacora = (c: PoolClient, s: Sesion, accion: string, entidadId: string | null = null) =>
  c.query(`INSERT INTO bitacora (consultorio_id, usuario_id, accion, entidad_id) VALUES ($1, $2, $3, $4)`, [
    s.consultorioId,
    s.usuarioId,
    accion,
    entidadId,
  ]);

// ---------------------------------------------------------------------------
// Público
// ---------------------------------------------------------------------------

const config: Manejador = async ({ deps }) => {
  const llave = await obtenerLlaveSoporte(deps);
  return json({
    soporte_llave_publica: llave,
    pagos_modo: deps.env("PAGOS_MODO") ?? "conekta",
    ventas_abiertas: ventasAbiertas(deps),
    planes: Object.fromEntries(
      Object.entries(PLANES).map(([id, p]) => [id, { nombre: p.nombre, precios: p.precios, medicos: p.medicos, asistentes: p.asistentes, modulos: p.modulos }]),
    ),
  });
};

/**
 * Con pagos reales, las ventas quedan cerradas hasta que VENTAS_ABIERTAS valga "si". Así el sitio
 * puede publicarse antes de abrir, con la lista de fundadores, sin que nadie llegue a pagar por error.
 */
function ventasAbiertas(deps: Dependencias): boolean {
  if ((deps.env("PAGOS_MODO") ?? "conekta") === "simulado") return true;
  return deps.env("VENTAS_ABIERTAS") === "si";
}

/** De dónde llegó la persona: "colega", "congreso-mazatlan-2026", etc. Lo demás se descarta. */
function limpiarOrigen(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const limpio = valor.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,59}$/.test(limpio) ? limpio : null;
}

async function obtenerLlaveSoporte(deps: Dependencias): Promise<string | null> {
  const { rows } = await enCuentas(deps, (c) => c.query(`SELECT valor FROM plataforma WHERE clave = 'soporte_llave_publica'`));
  return rows[0]?.valor ?? null;
}

const crearCheckout: Manejador = async ({ req, deps }) => {
  const cuerpo = await leerCuerpo(req);
  const plan = cuerpo.plan;
  const ciclo = cuerpo.ciclo;
  if (!esPlan(plan) || !esCiclo(ciclo)) throw new ErrorHttp(400, "dato_invalido", "Elige un plan y un periodo válidos.");
  if (!ventasAbiertas(deps)) {
    throw new ErrorHttp(503, "ventas_cerradas", "Todavía no abrimos las inscripciones. Apúntate en la lista de fundadores y te avisamos.");
  }
  if (cuerpo.acepto_terminos !== true) {
    throw new ErrorHttp(400, "terminos_pendientes", "Para continuar acepta los términos y el aviso de privacidad.");
  }
  const correo = validarEmail(cuerpo.email);
  const nombreConsultorio = texto(cuerpo.nombre_consultorio, "Nombre del consultorio", { max: 160 });
  const nombreMedico = texto(cuerpo.nombre_medico, "Tu nombre", { max: 160 });
  const telefono = textoOpcional(cuerpo.telefono, "Teléfono", 20);
  const recurrente = cuerpo.recurrente === true;

  if (!(await obtenerLlaveSoporte(deps))) {
    throw new ErrorHttp(503, "plataforma_no_lista", "Todavía no abrimos las inscripciones. Vuelve a intentar más tarde.");
  }

  const proveedor = obtenerProveedor(deps, req);
  const monto = PLANES[plan].precios[ciclo];
  const token = nuevoToken();
  const solicitudId = randomUUID();

  await enCuentas(deps, async (c) => {
    const { rowCount } = await c.query(`SELECT 1 FROM usuarios WHERE email = $1`, [correo]);
    if ((rowCount ?? 0) > 0) throw new ErrorHttp(409, "correo_en_uso", "Ese correo ya tiene una cuenta. Entra con él o usa otro.");
    await c.query(
      `INSERT INTO solicitudes (id, email, nombre_consultorio, nombre_medico, telefono, plan, ciclo, recurrente, monto_centavos, proveedor, token_hash, datos_fiscales, origen, acepto_terminos_en)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [solicitudId, correo, nombreConsultorio, nombreMedico, telefono, plan, ciclo, recurrente, monto, proveedor.nombre, sha256(token), limpiarFiscales(cuerpo.datos_fiscales), limpiarOrigen(cuerpo.origen), deps.ahora()],
    );
  });

  const base = urlBase(deps, req);
  const urlExito = `${base}/pago-exitoso.html#${solicitudId}.${token}`;
  const urlFallo = `${base}/index.html#pago-no-completado`;
  const cobro = await proveedor.crearCobro({
    solicitudId,
    concepto: conceptoPlan(plan, ciclo),
    montoCentavos: monto,
    plan,
    ciclo,
    recurrente,
    cliente: { nombre: nombreMedico, email: correo, telefono },
    urlExito,
    urlFallo,
  });
  await enCuentas(deps, (c) => c.query(`UPDATE solicitudes SET proveedor_orden = $2 WHERE id = $1`, [solicitudId, cobro.ordenId]));
  return json({ url: cobro.url }, 201);
};

function limpiarFiscales(valor: unknown): string | null {
  if (!valor || typeof valor !== "object") return null;
  const v = valor as Record<string, unknown>;
  const datos = {
    rfc: textoOpcional(v.rfc, "RFC", 13),
    razon_social: textoOpcional(v.razon_social, "Razón social", 200),
    regimen: textoOpcional(v.regimen, "Régimen fiscal", 5),
    cp: textoOpcional(v.cp, "Código postal", 5),
    uso_cfdi: textoOpcional(v.uso_cfdi, "Uso de CFDI", 5),
  };
  return Object.values(datos).some(Boolean) ? JSON.stringify(datos) : null;
}

const estadoCheckout: Manejador = async ({ url, deps }) => {
  const id = uuid(url.searchParams.get("s"), "solicitud");
  const token = url.searchParams.get("t") ?? "";
  const { rows } = await enCuentas(deps, (c) =>
    c.query(`SELECT estado, consultorio_id, token_hash, email FROM solicitudes WHERE id = $1`, [id]),
  );
  const fila = rows[0];
  if (!fila || !igualesSeguro(sha256(token), fila.token_hash)) throw new ErrorHttp(404, "no_encontrado", "No encontramos esta solicitud.");
  if (fila.estado !== "pagada") return json({ estado: fila.estado });
  const activacion = await nuevaActivacionPendiente(deps, fila.consultorio_id);
  return json({ estado: "pagada", activar: activacion ? `#activar/${activacion.token}` : null, email: fila.email });
};

const registrarFundador: Manejador = async ({ req, deps }) => {
  const cuerpo = await leerCuerpo(req);
  // Campo trampa: una persona no lo ve. Se responde igual para no dar pistas a quien automatiza.
  if (typeof cuerpo.sitio_web === "string" && cuerpo.sitio_web.trim() !== "") return json({ ok: true }, 201);
  if (cuerpo.acepto_aviso !== true) {
    throw new ErrorHttp(400, "aviso_pendiente", "Para apuntarte acepta el aviso de privacidad.");
  }
  const correo = validarEmail(cuerpo.email);
  const nombre = texto(cuerpo.nombre, "Tu nombre", { max: 160 });
  const especialidad = textoOpcional(cuerpo.especialidad, "Especialidad", 80);
  const ciudad = textoOpcional(cuerpo.ciudad, "Ciudad", 80);
  const { rowCount } = await enCuentas(deps, (c) =>
    c.query(
      `INSERT INTO lista_fundadores (email, nombre, especialidad, ciudad, origen, acepto_aviso_en)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (email) DO NOTHING`,
      [correo, nombre, especialidad, ciudad, limpiarOrigen(cuerpo.origen), deps.ahora()],
    ),
  );
  if (rowCount) {
    // El registro ya quedó guardado; si el correo falla, no se le pide a la persona que lo repita.
    await enviarCorreo(deps, {
      para: correo,
      asunto: "Quedaste en la lista de fundadores de NUVORA",
      texto: `Hola, ${nombre}.\n\nGuardamos tu lugar en la lista. Te escribiremos a este correo cuando abramos, con la tarifa de fundador.\n\nApuntarte no te obliga a comprar. Si quieres salir de la lista, responde a este correo.\n\nNUVORA Health Technologies`,
    }).catch((error) => {
      console.error("No se pudo enviar la confirmación de la lista:", (error as Error).message);
    });
  }
  // La misma respuesta para un correo nuevo y uno repetido: no revela quién está en la lista.
  return json({ ok: true }, 201);
};

const webhookPago: Manejador = async ({ req, deps }) => {
  const cuerpo = await req.text();
  const proveedor = obtenerProveedor(deps, req);
  let evento;
  try {
    evento = proveedor.leerEvento(cuerpo, req.headers);
  } catch (error) {
    if (error instanceof FirmaInvalida) throw new ErrorHttp(401, "firma_invalida", "Firma no válida.");
    throw error;
  }
  const resultado = await procesarEvento(deps, proveedor, evento);
  if (resultado.aviso) {
    // El pago ya quedó registrado. Si el correo falla, el médico puede activar desde la página de éxito o pedir reenvío.
    await avisarActivacion(deps, req, resultado.aviso).catch((error) => {
      console.error("No se pudo enviar el correo de activación:", (error as Error).message);
    });
  }
  return json({ recibido: true, resultado: resultado.resultado });
};

const reenviarActivacion: Manejador = async ({ req, deps }) => {
  const cuerpo = await leerCuerpo(req);
  const correo = validarEmail(cuerpo.email);
  const clave = claveAcceso("reenvio", correo);
  await comprobarBloqueo(deps, clave);
  await registrarFallo(deps, clave);
  const { rows } = await enCuentas(deps, (c) =>
    c.query(
      `SELECT co.id FROM usuarios u JOIN consultorios co ON co.id = u.consultorio_id
        WHERE u.email = $1 AND u.rol = 'titular' AND co.estado = 'pendiente_activacion'`,
      [correo],
    ),
  );
  if (rows[0]) {
    const activacion = await nuevaActivacionPendiente(deps, rows[0].id);
    if (activacion) await enviarCorreo(deps, mensajeActivacion(deps, req, activacion));
  }
  // La respuesta es igual exista o no la cuenta.
  return json({ ok: true });
};

const leerActivacion: Manejador = async ({ parametros, deps }) => {
  const { rows } = await enCuentas(deps, (c) =>
    c.query(
      `SELECT a.expira_en, a.usado_en, u.email, u.nombre, co.nombre AS consultorio
         FROM activaciones a JOIN usuarios u ON u.id = a.usuario_id JOIN consultorios co ON co.id = a.consultorio_id
        WHERE a.token_hash = $1 AND a.tipo = 'activacion'`,
      [sha256(parametros.token)],
    ),
  );
  const fila = rows[0];
  if (!fila || fila.usado_en || new Date(fila.expira_en).getTime() < deps.ahora().getTime()) {
    throw new ErrorHttp(410, "enlace_vencido", "Este enlace ya se usó o venció. Pide uno nuevo con tu correo.");
  }
  return json({ email: fila.email, nombre: fila.nombre, consultorio: fila.consultorio, iteraciones: ITERACIONES_POR_DEFECTO });
};

const completarActivacion: Manejador = async ({ req, parametros, deps }) => {
  const cuerpo = await leerCuerpo(req);
  const datos = credenciales(cuerpo);
  const recAuth = sobre(cuerpo.rec_auth, "rec_auth", 128);
  const tkRec = sobre(cuerpo.tk_envuelta_rec, "tk_envuelta_rec", 512);
  const authHash = await protegerLlaveAuth(datos.authKey);

  const { cookie, sesionFila } = await enCuentas(deps, async (c) => {
    const { rows } = await c.query(
      `SELECT * FROM activaciones WHERE token_hash = $1 AND tipo = 'activacion' FOR UPDATE`,
      [sha256(parametros.token)],
    );
    const activacion = rows[0];
    if (!activacion || activacion.usado_en || new Date(activacion.expira_en).getTime() < deps.ahora().getTime()) {
      throw new ErrorHttp(410, "enlace_vencido", "Este enlace ya se usó o venció. Pide uno nuevo con tu correo.");
    }
    await c.query(
      `UPDATE usuarios SET kdf_sal = $2, kdf_iter = $3, auth_hash = $4, tk_envuelta = $5, debe_cambiar = false WHERE id = $1`,
      [activacion.usuario_id, datos.kdfSal, datos.kdfIter, authHash, datos.tkEnvuelta],
    );
    await c.query(
      `INSERT INTO recuperacion (consultorio_id, rec_auth_hash, tk_envuelta_rec) VALUES ($1, $2, $3)
       ON CONFLICT (consultorio_id) DO UPDATE SET rec_auth_hash = $2, tk_envuelta_rec = $3, actualizado_en = now()`,
      [activacion.consultorio_id, sha256(recAuth), tkRec],
    );
    await c.query(`UPDATE consultorios SET estado = 'activo', actualizado_en = now() WHERE id = $1`, [activacion.consultorio_id]);
    await c.query(`UPDATE activaciones SET usado_en = $2 WHERE consultorio_id = $1 AND usado_en IS NULL`, [activacion.consultorio_id, deps.ahora()]);
    const cookie = await iniciarSesion(c, deps, activacion.usuario_id, activacion.consultorio_id);
    const fila = await c.query(
      `SELECT u.id AS usuario_id, u.email, u.nombre AS usuario_nombre, u.rol, u.cedula, u.debe_cambiar, u.kdf_sal, u.kdf_iter, u.tk_envuelta, co.*
         FROM usuarios u JOIN consultorios co ON co.id = u.consultorio_id WHERE u.id = $1`,
      [activacion.usuario_id],
    );
    return { cookie, sesionFila: fila.rows[0] };
  });
  return json(respuestaAcceso(sesionFila, deps), 200, { "set-cookie": cookie });
};

function respuestaAcceso(fila: Record<string, any>, deps: Dependencias) {
  return {
    usuario: { id: fila.usuario_id, email: fila.email, nombre: fila.usuario_nombre, rol: fila.rol, cedula: fila.cedula, debe_cambiar: fila.debe_cambiar },
    consultorio: resumenConsultorio(fila, deps.ahora()),
    kdf_sal: fila.kdf_sal,
    kdf_iter: fila.kdf_iter,
    tk_envuelta: fila.tk_envuelta,
  };
}

const parametrosAcceso: Manejador = async ({ req, deps }) => {
  const cuerpo = await leerCuerpo(req);
  const correo = validarEmail(cuerpo.email);
  const { rows } = await enCuentas(deps, (c) => c.query(`SELECT kdf_sal, kdf_iter FROM usuarios WHERE email = $1`, [correo]));
  const fila = rows[0];
  if (fila?.kdf_sal) return json({ kdf_sal: fila.kdf_sal, kdf_iter: fila.kdf_iter });
  return json({ kdf_sal: salFicticia(secretoServidor(deps), correo), kdf_iter: ITERACIONES_POR_DEFECTO });
};

const entrar: Manejador = async ({ req, deps }) => {
  const cuerpo = await leerCuerpo(req);
  const correo = validarEmail(cuerpo.email);
  const authKey = sobre(cuerpo.auth_key, "auth_key", 128);
  const clave = claveAcceso("acceso", correo);
  await comprobarBloqueo(deps, clave);

  const { rows } = await enCuentas(deps, (c) =>
    c.query(
      `SELECT u.id AS usuario_id, u.email, u.nombre AS usuario_nombre, u.rol, u.cedula, u.debe_cambiar, u.kdf_sal, u.kdf_iter,
              u.tk_envuelta, u.auth_hash, u.desactivado_en, co.*
         FROM usuarios u JOIN consultorios co ON co.id = u.consultorio_id WHERE u.email = $1`,
      [correo],
    ),
  );
  const fila = rows[0];
  const valida = await verificarLlaveAuth(authKey, fila?.auth_hash);
  if (!fila || !valida || fila.desactivado_en) {
    await registrarFallo(deps, clave);
    throw new ErrorHttp(401, "credenciales_invalidas", "El correo o la contraseña no coinciden.");
  }
  await limpiarFallos(deps, clave);
  const cookie = await enCuentas(deps, (c) => iniciarSesion(c, deps, fila.usuario_id, fila.id));
  return json(respuestaAcceso(fila, deps), 200, { "set-cookie": cookie });
};

const salir: Manejador = async ({ req, deps }) => {
  const token = leerCookie(req, COOKIE);
  if (token) await enCuentas(deps, (c) => c.query(`DELETE FROM sesiones WHERE token_hash = $1`, [sha256(token)]));
  return json({ ok: true }, 200, { "set-cookie": cookieSesion(COOKIE, "", 0, deps.cookiesSeguras) });
};

const sesionActual: Manejador = async (ctx) => {
  const sesion = await leerSesion(ctx);
  return json(datosSesion(sesion, ctx.deps));
};

const cambiarContrasena: Manejador = async (ctx) => {
  const { req, deps } = ctx;
  const sesion = await leerSesion(ctx);
  const cuerpo = await leerCuerpo(req);
  const actual = sobre(cuerpo.auth_key_actual, "auth_key_actual", 128);
  const datos = credenciales(cuerpo);
  const clave = claveAcceso("acceso", sesion.email);
  await comprobarBloqueo(deps, clave);
  const { rows } = await enCuentas(deps, (c) => c.query(`SELECT auth_hash FROM usuarios WHERE id = $1`, [sesion.usuarioId]));
  if (!(await verificarLlaveAuth(actual, rows[0]?.auth_hash))) {
    await registrarFallo(deps, clave);
    throw new ErrorHttp(401, "credenciales_invalidas", "Tu contraseña actual no coincide.");
  }
  const authHash = await protegerLlaveAuth(datos.authKey);
  const tokenActual = sha256(leerCookie(req, COOKIE) ?? "");
  await enCuentas(deps, async (c) => {
    await c.query(
      `UPDATE usuarios SET kdf_sal = $2, kdf_iter = $3, auth_hash = $4, tk_envuelta = $5, debe_cambiar = false WHERE id = $1`,
      [sesion.usuarioId, datos.kdfSal, datos.kdfIter, authHash, datos.tkEnvuelta],
    );
    await c.query(`DELETE FROM sesiones WHERE usuario_id = $1 AND token_hash <> $2`, [sesion.usuarioId, tokenActual]);
    await c.query(`INSERT INTO bitacora (consultorio_id, usuario_id, accion) VALUES ($1, $2, 'contrasena_cambiada')`, [sesion.consultorioId, sesion.usuarioId]);
  });
  return json({ ok: true });
};

const recuperarPaso1: Manejador = async ({ req, deps }) => {
  const cuerpo = await leerCuerpo(req);
  const correo = validarEmail(cuerpo.email);
  const recAuth = sobre(cuerpo.rec_auth, "rec_auth", 128);
  const clave = claveAcceso("recuperacion", correo);
  await comprobarBloqueo(deps, clave);
  const { rows } = await enCuentas(deps, (c) =>
    c.query(
      `SELECT u.id AS usuario_id, u.consultorio_id, r.rec_auth_hash, r.tk_envuelta_rec
         FROM usuarios u JOIN recuperacion r ON r.consultorio_id = u.consultorio_id
        WHERE u.email = $1 AND u.rol = 'titular' AND u.desactivado_en IS NULL`,
      [correo],
    ),
  );
  const fila = rows[0];
  if (!fila || !igualesSeguro(sha256(recAuth), fila.rec_auth_hash)) {
    await registrarFallo(deps, clave);
    throw new ErrorHttp(401, "codigo_invalido", "El correo o el código de recuperación no coinciden.");
  }
  await limpiarFallos(deps, clave);
  const ticket = nuevoToken();
  await enCuentas(deps, (c) =>
    c.query(
      `INSERT INTO activaciones (token_hash, consultorio_id, usuario_id, tipo, expira_en) VALUES ($1, $2, $3, 'recuperacion', $4)`,
      [sha256(ticket), fila.consultorio_id, fila.usuario_id, new Date(deps.ahora().getTime() + 15 * 60000)],
    ),
  );
  return json({ ticket, tk_envuelta_rec: fila.tk_envuelta_rec });
};

const recuperarPaso2: Manejador = async ({ req, deps }) => {
  const cuerpo = await leerCuerpo(req);
  const ticket = sobre(cuerpo.ticket, "ticket", 128);
  const datos = credenciales(cuerpo);
  const authHash = await protegerLlaveAuth(datos.authKey);
  await enCuentas(deps, async (c) => {
    const { rows } = await c.query(`SELECT * FROM activaciones WHERE token_hash = $1 AND tipo = 'recuperacion' FOR UPDATE`, [sha256(ticket)]);
    const fila = rows[0];
    if (!fila || fila.usado_en || new Date(fila.expira_en).getTime() < deps.ahora().getTime()) {
      throw new ErrorHttp(410, "enlace_vencido", "La recuperación venció. Vuelve a empezar.");
    }
    await c.query(
      `UPDATE usuarios SET kdf_sal = $2, kdf_iter = $3, auth_hash = $4, tk_envuelta = $5, debe_cambiar = false WHERE id = $1`,
      [fila.usuario_id, datos.kdfSal, datos.kdfIter, authHash, datos.tkEnvuelta],
    );
    await c.query(`UPDATE activaciones SET usado_en = $2 WHERE token_hash = $1`, [sha256(ticket), deps.ahora()]);
    await c.query(`DELETE FROM sesiones WHERE usuario_id = $1`, [fila.usuario_id]);
    await c.query(`INSERT INTO bitacora (consultorio_id, usuario_id, accion) VALUES ($1, $2, 'contrasena_recuperada')`, [fila.consultorio_id, fila.usuario_id]);
  });
  return json({ ok: true });
};

const leerEnlaceFamilia: Manejador = async ({ parametros, deps }) => {
  const id = uuid(parametros.id);
  const fila = await enCuentas(deps, async (c) => {
    const { rows } = await c.query(`SELECT id, consultorio_id, cifrado, expira_en, revocado_en FROM enlaces_familia WHERE id = $1`, [id]);
    const enlace = rows[0];
    if (!enlace || enlace.revocado_en || new Date(enlace.expira_en).getTime() < deps.ahora().getTime()) return null;
    await c.query(`UPDATE enlaces_familia SET descargas = descargas + 1 WHERE id = $1`, [id]);
    const marca = await c.query(`SELECT nombre, marca FROM consultorios WHERE id = $1`, [enlace.consultorio_id]);
    return { cifrado: enlace.cifrado, expira_en: enlace.expira_en, consultorio: marca.rows[0].nombre, marca: marca.rows[0].marca };
  });
  if (!fila) throw new ErrorHttp(410, "enlace_vencido", "Este enlace venció o fue revocado. Pídele uno nuevo a tu médico.");
  return json(fila);
};

// ---------------------------------------------------------------------------
// Consultorio
// ---------------------------------------------------------------------------

const PATRON_COLOR = /^#[0-9a-fA-F]{6}$/;
const PATRON_LOGO = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

function limpiarMarca(valor: unknown) {
  if (!valor || typeof valor !== "object") throw new ErrorHttp(400, "dato_invalido", "Datos de marca no válidos.");
  const v = valor as Record<string, unknown>;
  const logo = v.logo === null || v.logo === undefined || v.logo === "" ? null : v.logo;
  if (logo !== null && (typeof logo !== "string" || !PATRON_LOGO.test(logo) || logo.length > 400_000)) {
    throw new ErrorHttp(400, "logo_invalido", "El logo debe ser PNG, JPG o WebP de máximo 300 KB.");
  }
  const color = (campo: string) => {
    const c = v[campo];
    if (c === undefined || c === null || c === "") return null;
    if (typeof c !== "string" || !PATRON_COLOR.test(c)) throw new ErrorHttp(400, "color_invalido", "Usa colores en formato #RRGGBB.");
    return c;
  };
  return {
    logo,
    color_primario: color("color_primario"),
    color_acento: color("color_acento"),
    medico_nombre: textoOpcional(v.medico_nombre, "Nombre del médico", 160),
    especialidad: textoOpcional(v.especialidad, "Especialidad", 160),
    cedulas: textoOpcional(v.cedulas, "Cédulas", 200),
    institucion: textoOpcional(v.institucion, "Institución", 200),
    domicilio: textoOpcional(v.domicilio, "Domicilio", 240),
    telefono: textoOpcional(v.telefono, "Teléfono", 40),
    pie_receta: textoOpcional(v.pie_receta, "Pie de receta", 240),
  };
}

const leerConsultorio: Manejador = async (ctx) => {
  const sesion = await leerSesion(ctx);
  return json({ consultorio: resumenConsultorio(sesion.consultorio, ctx.deps.ahora()) });
};

const guardarConsultorio: Manejador = async (ctx) => {
  const sesion = await leerSesion(ctx);
  exigirRol(sesion, "titular");
  exigirEscritura(sesion, ctx.deps);
  const cuerpo = await leerCuerpo(ctx.req);
  const nombre = texto(cuerpo.nombre, "Nombre del consultorio", { max: 160 });
  const marca = limpiarMarca(cuerpo.marca);
  const fila = await enConsultorio(ctx.deps, sesion.consultorioId, async (c) => {
    const { rows } = await c.query(
      `UPDATE consultorios SET nombre = $2, marca = $3, actualizado_en = now() WHERE id = $1 RETURNING *`,
      [sesion.consultorioId, nombre, JSON.stringify(marca)],
    );
    await bitacora(c, sesion, "marca_actualizada");
    return rows[0];
  });
  return json({ consultorio: resumenConsultorio(fila, ctx.deps.ahora()) });
};

const listarUsuarios: Manejador = async (ctx) => {
  const sesion = await leerSesion(ctx);
  exigirRol(sesion, "titular");
  const { rows } = await enConsultorio(ctx.deps, sesion.consultorioId, (c) =>
    c.query(`SELECT id, email, nombre, rol, cedula, debe_cambiar, desactivado_en, ultimo_acceso, creado_en FROM usuarios ORDER BY creado_en`),
  );
  return json({ usuarios: rows });
};

const crearUsuario: Manejador = async (ctx) => {
  const sesion = await leerSesion(ctx);
  exigirRol(sesion, "titular");
  exigirEscritura(sesion, ctx.deps);
  const cuerpo = await leerCuerpo(ctx.req);
  const correo = validarEmail(cuerpo.email);
  const nombre = texto(cuerpo.nombre, "Nombre", { max: 160 });
  const rol = cuerpo.rol;
  if (rol !== "medico" && rol !== "asistente") throw new ErrorHttp(400, "dato_invalido", "Elige el rol: médico o asistente.");
  const cedula = textoOpcional(cuerpo.cedula, "Cédula", 40);
  const datos = credenciales(cuerpo);
  const plan = PLANES[sesion.consultorio.plan as Plan];
  const authHash = await protegerLlaveAuth(datos.authKey);

  const { rowCount: enUso } = await enCuentas(ctx.deps, (c) => c.query(`SELECT 1 FROM usuarios WHERE email = $1`, [correo]));
  if ((enUso ?? 0) > 0) throw new ErrorHttp(409, "correo_en_uso", "Ese correo ya tiene una cuenta. Usa otro.");

  const usuario = await enConsultorio(ctx.deps, sesion.consultorioId, async (c) => {
    await c.query(`SELECT id FROM consultorios WHERE id = $1 FOR UPDATE`, [sesion.consultorioId]);
    const { rows } = await c.query(
      `SELECT count(*) FILTER (WHERE rol IN ('titular', 'medico'))::int AS medicos, count(*) FILTER (WHERE rol = 'asistente')::int AS asistentes
         FROM usuarios WHERE desactivado_en IS NULL`,
    );
    const limite = rol === "medico" ? plan.medicos : plan.asistentes;
    const actuales = rol === "medico" ? rows[0].medicos : rows[0].asistentes;
    if (actuales >= limite) {
      throw new ErrorHttp(403, "limite_plan", `Tu plan ${plan.nombre} incluye ${limite} ${rol === "medico" ? "médico(s)" : "asistente(s)"}. Cambia de plan para agregar más.`);
    }
    const id = randomUUID();
    await c.query(
      `INSERT INTO usuarios (id, consultorio_id, email, nombre, rol, cedula, kdf_sal, kdf_iter, auth_hash, tk_envuelta, debe_cambiar)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)`,
      [id, sesion.consultorioId, correo, nombre, rol, cedula, datos.kdfSal, datos.kdfIter, authHash, datos.tkEnvuelta],
    );
    await bitacora(c, sesion, "usuario_creado", id);
    return { id, email: correo, nombre, rol, cedula };
  });
  return json({ usuario }, 201);
};

const actualizarUsuario: Manejador = async (ctx) => {
  const sesion = await leerSesion(ctx);
  exigirRol(sesion, "titular");
  const id = uuid(ctx.parametros.id);
  const cuerpo = await leerCuerpo(ctx.req);
  if (id === sesion.usuarioId && cuerpo.desactivar === true) {
    throw new ErrorHttp(400, "accion_no_permitida", "No puedes desactivar tu propia cuenta de titular.");
  }
  await enConsultorio(ctx.deps, sesion.consultorioId, async (c) => {
    const { rowCount } = await c.query(`SELECT 1 FROM usuarios WHERE id = $1`, [id]);
    if (!rowCount) throw new ErrorHttp(404, "no_encontrado", "No encontramos este usuario.");
    if (cuerpo.desactivar === true) {
      await c.query(`UPDATE usuarios SET desactivado_en = $2 WHERE id = $1`, [id, ctx.deps.ahora()]);
      await bitacora(c, sesion, "usuario_desactivado", id);
    } else if (cuerpo.activar === true) {
      await c.query(`UPDATE usuarios SET desactivado_en = NULL WHERE id = $1`, [id]);
      await bitacora(c, sesion, "usuario_reactivado", id);
    } else {
      const datos = credenciales(cuerpo);
      const authHash = await protegerLlaveAuth(datos.authKey);
      await c.query(
        `UPDATE usuarios SET kdf_sal = $2, kdf_iter = $3, auth_hash = $4, tk_envuelta = $5, debe_cambiar = true WHERE id = $1`,
        [id, datos.kdfSal, datos.kdfIter, authHash, datos.tkEnvuelta],
      );
      await c.query(`DELETE FROM sesiones WHERE usuario_id = $1`, [id]);
      await bitacora(c, sesion, "contrasena_restablecida", id);
    }
  });
  return json({ ok: true });
};

const actualizarRecuperacion: Manejador = async (ctx) => {
  const sesion = await leerSesion(ctx);
  exigirRol(sesion, "titular");
  const cuerpo = await leerCuerpo(ctx.req);
  const recAuth = sobre(cuerpo.rec_auth, "rec_auth", 128);
  const tkRec = sobre(cuerpo.tk_envuelta_rec, "tk_envuelta_rec", 512);
  await enCuentas(ctx.deps, async (c) => {
    await c.query(`UPDATE recuperacion SET rec_auth_hash = $2, tk_envuelta_rec = $3, actualizado_en = now() WHERE consultorio_id = $1`, [
      sesion.consultorioId,
      sha256(recAuth),
      tkRec,
    ]);
    await c.query(`INSERT INTO bitacora (consultorio_id, usuario_id, accion) VALUES ($1, $2, 'codigo_recuperacion_renovado')`, [sesion.consultorioId, sesion.usuarioId]);
  });
  return json({ ok: true });
};

const listarPacientes: Manejador = async (ctx) => {
  const sesion = await leerSesion(ctx);
  const despues = ctx.url.searchParams.get("despues");
  const { rows } = await enConsultorio(ctx.deps, sesion.consultorioId, (c) =>
    despues
      ? c.query(
          `SELECT id, cifrado, ultima_consulta_en, ultima_receta_en, creado_en, actualizado_en FROM pacientes
            WHERE archivado_en IS NULL AND id > $1 ORDER BY id LIMIT 2000`,
          [uuid(despues)],
        )
      : c.query(
          `SELECT id, cifrado, ultima_consulta_en, ultima_receta_en, creado_en, actualizado_en FROM pacientes
            WHERE archivado_en IS NULL ORDER BY id LIMIT 2000`,
        ),
  );
  return json({ pacientes: rows, siguiente: rows.length === 2000 ? rows[rows.length - 1].id : null });
};

const crearPaciente: Manejador = async (ctx) => {
  const sesion = await leerSesion(ctx);
  exigirEscritura(sesion, ctx.deps);
  const cuerpo = await leerCuerpo(ctx.req);
  const id = uuid(cuerpo.id);
  const cifrado = sobre(cuerpo.cifrado, "cifrado", 200_000);
  const sellado = sobre(cuerpo.nombre_sellado, "nombre_sellado", 2048);
  const fila = await enConsultorio(ctx.deps, sesion.consultorioId, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO pacientes (id, consultorio_id, cifrado, nombre_sellado) VALUES ($1, $2, $3, $4)
       RETURNING id, cifrado, ultima_consulta_en, ultima_receta_en, creado_en, actualizado_en`,
      [id, sesion.consultorioId, cifrado, sellado],
    );
    await bitacora(c, sesion, "paciente_creado", id);
    return rows[0];
  });
  return json({ paciente: fila }, 201);
};

const actualizarPaciente: Manejador = async (ctx) => {
  const sesion = await leerSesion(ctx);
  exigirEscritura(sesion, ctx.deps);
  const id = uuid(ctx.parametros.id);
  const cuerpo = await leerCuerpo(ctx.req);
  const cifrado = sobre(cuerpo.cifrado, "cifrado", 200_000);
  const sellado = sobre(cuerpo.nombre_sellado, "nombre_sellado", 2048);
  const fila = await enConsultorio(ctx.deps, sesion.consultorioId, async (c) => {
    const { rows } = await c.query(
      `UPDATE pacientes SET cifrado = $2, nombre_sellado = $3, actualizado_en = now() WHERE id = $1
       RETURNING id, cifrado, ultima_consulta_en, ultima_receta_en, creado_en, actualizado_en`,
      [id, cifrado, sellado],
    );
    if (!rows[0]) throw new ErrorHttp(404, "no_encontrado", "No encontramos este paciente.");
    await bitacora(c, sesion, "paciente_actualizado", id);
    return rows[0];
  });
  return json({ paciente: fila });
};

const TIPOS_ASISTENTE = ["somatometria", "vacuna"];
const TIPOS = ["consulta", "receta", "somatometria", "desarrollo", "vacuna", "documento"];

const listarRegistros: Manejador = async (ctx) => {
  const sesion = await leerSesion(ctx);
  const pacienteId = uuid(ctx.parametros.id);
  const filas = await enConsultorio(ctx.deps, sesion.consultorioId, async (c) => {
    const { rowCount } = await c.query(`SELECT 1 FROM pacientes WHERE id = $1`, [pacienteId]);
    if (!rowCount) throw new ErrorHttp(404, "no_encontrado", "No encontramos este paciente.");
    const { rows } = await c.query(
      `SELECT id, tipo, cifrado, autor_id, sello, anulado_en, creado_en FROM registros
        WHERE paciente_id = $1 AND ($2::text[] IS NULL OR tipo = ANY($2)) ORDER BY secuencia DESC LIMIT 1000`,
      [pacienteId, sesion.rol === "asistente" ? TIPOS_ASISTENTE : null],
    );
    await bitacora(c, sesion, "expediente_abierto", pacienteId);
    return rows;
  });
  return json({ registros: filas });
};

const crearRegistros: Manejador = async (ctx) => {
  const sesion = await leerSesion(ctx);
  exigirEscritura(sesion, ctx.deps);
  const pacienteId = uuid(ctx.parametros.id);
  const cuerpo = await leerCuerpo(ctx.req);
  const lista = cuerpo.registros;
  if (!Array.isArray(lista) || lista.length === 0 || lista.length > 5) {
    throw new ErrorHttp(400, "dato_invalido", "Envía entre 1 y 5 registros.");
  }
  const limpios = lista.map((r: any) => {
    if (!TIPOS.includes(r?.tipo)) throw new ErrorHttp(400, "dato_invalido", "Tipo de registro no válido.");
    if (sesion.rol === "asistente" && !TIPOS_ASISTENTE.includes(r.tipo)) {
      throw new ErrorHttp(403, "sin_permiso", "Tu rol no tiene permiso para registrar notas o recetas.");
    }
    return { id: uuid(r.id), tipo: r.tipo as string, cifrado: sobre(r.cifrado, "cifrado", 400_000) };
  });
  const creados = await enConsultorio(ctx.deps, sesion.consultorioId, async (c) => {
    const salida = [];
    for (const r of limpios) {
      const { rows } = await c.query(
        `INSERT INTO registros (id, consultorio_id, paciente_id, tipo, cifrado, autor_id) VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, tipo, cifrado, autor_id, sello, anulado_en, creado_en`,
        [r.id, sesion.consultorioId, pacienteId, r.tipo, r.cifrado, sesion.usuarioId],
      );
      await bitacora(c, sesion, `${r.tipo}_creada`, r.id);
      salida.push(rows[0]);
    }
    return salida;
  });
  return json({ registros: creados }, 201);
};

const anularRegistro: Manejador = async (ctx) => {
  const sesion = await leerSesion(ctx);
  exigirRol(sesion, "titular", "medico");
  exigirEscritura(sesion, ctx.deps);
  const id = uuid(ctx.parametros.id);
  await enConsultorio(ctx.deps, sesion.consultorioId, async (c) => {
    const { rowCount } = await c.query(
      `UPDATE registros SET anulado_en = $2, anulado_por = $3 WHERE id = $1 AND anulado_en IS NULL`,
      [id, ctx.deps.ahora(), sesion.usuarioId],
    );
    if (!rowCount) throw new ErrorHttp(404, "no_encontrado", "No encontramos este registro o ya estaba anulado.");
    await bitacora(c, sesion, "registro_anulado", id);
  });
  return json({ ok: true });
};

const crearEnlaceFamilia: Manejador = async (ctx) => {
  const sesion = await leerSesion(ctx);
  exigirModulo(sesion, "familia");
  exigirRol(sesion, "titular", "medico");
  exigirEscritura(sesion, ctx.deps);
  const cuerpo = await leerCuerpo(ctx.req);
  const id = uuid(cuerpo.id);
  const pacienteId = uuid(cuerpo.paciente_id);
  const cifrado = sobre(cuerpo.cifrado, "cifrado", 400_000);
  const dias = entero(cuerpo.dias, "dias", 1, 30);
  const expira = new Date(ctx.deps.ahora().getTime() + dias * 86400000);
  await enConsultorio(ctx.deps, sesion.consultorioId, async (c) => {
    const { rowCount } = await c.query(`SELECT 1 FROM pacientes WHERE id = $1`, [pacienteId]);
    if (!rowCount) throw new ErrorHttp(404, "no_encontrado", "No encontramos este paciente.");
    await c.query(
      `INSERT INTO enlaces_familia (id, consultorio_id, paciente_id, cifrado, expira_en, creado_por) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, sesion.consultorioId, pacienteId, cifrado, expira, sesion.usuarioId],
    );
    await bitacora(c, sesion, "enlace_familia_creado", pacienteId);
  });
  return json({ id, expira_en: expira }, 201);
};

const revocarEnlaceFamilia: Manejador = async (ctx) => {
  const sesion = await leerSesion(ctx);
  const id = uuid(ctx.parametros.id);
  await enConsultorio(ctx.deps, sesion.consultorioId, async (c) => {
    const { rowCount } = await c.query(`UPDATE enlaces_familia SET revocado_en = $2 WHERE id = $1`, [id, ctx.deps.ahora()]);
    if (!rowCount) throw new ErrorHttp(404, "no_encontrado", "No encontramos este enlace.");
    await bitacora(c, sesion, "enlace_familia_revocado", id);
  });
  return json({ ok: true });
};

const leerBitacora: Manejador = async (ctx) => {
  const sesion = await leerSesion(ctx);
  exigirRol(sesion, "titular");
  const datos = await enConsultorio(ctx.deps, sesion.consultorioId, async (c) => {
    const internos = await c.query(
      `SELECT b.accion, b.en, u.nombre AS usuario FROM bitacora b LEFT JOIN usuarios u ON u.id = b.usuario_id ORDER BY b.en DESC LIMIT 200`,
    );
    const soporte = await c.query(`SELECT accion, motivo, soporte_nombre, en FROM bitacora_soporte ORDER BY en DESC LIMIT 200`);
    return { internos: internos.rows, soporte: soporte.rows };
  });
  return json(datos);
};

const leerCuenta: Manejador = async (ctx) => {
  const sesion = await leerSesion(ctx);
  exigirRol(sesion, "titular");
  const { rows } = await enConsultorio(ctx.deps, sesion.consultorioId, (c) =>
    c.query(`SELECT monto_centavos, moneda, metodo, periodo_hasta, pagado_en, cfdi_estado FROM pagos ORDER BY pagado_en DESC LIMIT 60`),
  );
  return json({ consultorio: resumenConsultorio(sesion.consultorio, ctx.deps.ahora()), pagos: rows, datos_fiscales: sesion.consultorio.datos_fiscales });
};

const renovarCuenta: Manejador = async (ctx) => {
  const sesion = await leerSesion(ctx);
  exigirRol(sesion, "titular");
  const cuerpo = await leerCuerpo(ctx.req);
  const plan = (cuerpo.plan ?? sesion.consultorio.plan) as Plan;
  const ciclo = (cuerpo.ciclo ?? sesion.consultorio.ciclo) as Ciclo;
  if (!esPlan(plan) || !esCiclo(ciclo)) throw new ErrorHttp(400, "dato_invalido", "Elige un plan y un periodo válidos.");
  const recurrente = cuerpo.recurrente === true;
  const proveedor = obtenerProveedor(ctx.deps, ctx.req);
  const monto = PLANES[plan].precios[ciclo];
  const token = nuevoToken();
  const solicitudId = randomUUID();
  await enCuentas(ctx.deps, (c) =>
    c.query(
      `INSERT INTO solicitudes (id, tipo, email, nombre_consultorio, nombre_medico, plan, ciclo, recurrente, monto_centavos, proveedor, token_hash, acepto_terminos_en, consultorio_id)
       VALUES ($1, 'renovacion', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [solicitudId, sesion.email, sesion.consultorio.nombre, sesion.nombre, plan, ciclo, recurrente, monto, proveedor.nombre, sha256(token), ctx.deps.ahora(), sesion.consultorioId],
    ),
  );
  const base = urlBase(ctx.deps, ctx.req);
  const cobro = await proveedor.crearCobro({
    solicitudId,
    concepto: conceptoPlan(plan, ciclo),
    montoCentavos: monto,
    plan,
    ciclo,
    recurrente,
    cliente: { nombre: sesion.nombre, email: sesion.email },
    urlExito: `${base}/app.html#ajustes-cuenta`,
    urlFallo: `${base}/app.html#ajustes-cuenta`,
  });
  await enCuentas(ctx.deps, (c) => c.query(`UPDATE solicitudes SET proveedor_orden = $2 WHERE id = $1`, [solicitudId, cobro.ordenId]));
  return json({ url: cobro.url }, 201);
};

// ---------------------------------------------------------------------------
// Soporte: nombres de pacientes, última consulta y última receta. Nada más.
// ---------------------------------------------------------------------------

async function leerSoporte(ctx: Contexto): Promise<SesionSoporte> {
  const token = leerCookie(ctx.req, COOKIE_SOPORTE);
  if (!token) throw new ErrorHttp(401, "sin_sesion", "Tu sesión terminó. Vuelve a entrar.");
  const { rows } = await enCuentas(ctx.deps, (c) =>
    c.query(
      `SELECT s.expira_en, u.* FROM soporte_sesiones s JOIN soporte_usuarios u ON u.id = s.soporte_id WHERE s.token_hash = $1`,
      [sha256(token)],
    ),
  );
  const fila = rows[0];
  if (!fila || new Date(fila.expira_en).getTime() < ctx.deps.ahora().getTime() || fila.desactivado_en) {
    throw new ErrorHttp(401, "sin_sesion", "Tu sesión terminó. Vuelve a entrar.");
  }
  return {
    soporteId: fila.id,
    email: fila.email,
    nombre: fila.nombre,
    rol: fila.rol,
    debeCambiar: fila.debe_cambiar,
    kdfSal: fila.kdf_sal,
    kdfIter: fila.kdf_iter,
    llaveEnvuelta: fila.llave_envuelta,
  };
}

const instalarSoporte: Manejador = async ({ req, deps }) => {
  const esperado = deps.env("SOPORTE_TOKEN_INSTALACION");
  const cuerpo = await leerCuerpo(req);
  if (!esperado || typeof cuerpo.token !== "string" || !igualesSeguro(cuerpo.token, esperado)) {
    throw new ErrorHttp(403, "token_invalido", "El token de instalación no es válido.");
  }
  const correo = validarEmail(cuerpo.email);
  const nombre = texto(cuerpo.nombre, "Nombre", { max: 160 });
  const kdfSal = sobre(cuerpo.kdf_sal, "kdf_sal", 64);
  const kdfIter = entero(cuerpo.kdf_iter, "kdf_iter", 100_000, 10_000_000);
  const authKey = sobre(cuerpo.auth_key, "auth_key", 128);
  const llaveEnvuelta = sobre(cuerpo.llave_envuelta, "llave_envuelta", 8192);
  const llavePublica = sobre(cuerpo.llave_publica, "llave_publica", 2048);
  const secreto = nuevoSecretoTotp();
  const authHash = await protegerLlaveAuth(authKey);
  await enCuentas(deps, async (c) => {
    const { rows } = await c.query(`SELECT count(*)::int AS n FROM soporte_usuarios`);
    if (rows[0].n > 0) throw new ErrorHttp(409, "ya_instalado", "El panel de soporte ya está instalado.");
    await c.query(`INSERT INTO plataforma (clave, valor) VALUES ('soporte_llave_publica', $1)`, [llavePublica]);
    await c.query(
      `INSERT INTO soporte_usuarios (email, nombre, rol, kdf_sal, kdf_iter, auth_hash, llave_envuelta, totp_cifrado)
       VALUES ($1, $2, 'administrador', $3, $4, $5, $6, $7)`,
      [correo, nombre, kdfSal, kdfIter, authHash, llaveEnvuelta, cifrarServidor(secretoServidor(deps), secreto)],
    );
  });
  return json({ totp_secreto: secreto }, 201);
};

const parametrosSoporte: Manejador = async ({ req, deps }) => {
  const cuerpo = await leerCuerpo(req);
  const correo = validarEmail(cuerpo.email);
  const { rows } = await enCuentas(deps, (c) => c.query(`SELECT kdf_sal, kdf_iter FROM soporte_usuarios WHERE email = $1`, [correo]));
  if (rows[0]) return json({ kdf_sal: rows[0].kdf_sal, kdf_iter: rows[0].kdf_iter });
  return json({ kdf_sal: salFicticia(secretoServidor(deps), `soporte|${correo}`), kdf_iter: ITERACIONES_POR_DEFECTO });
};

const entrarSoporte: Manejador = async ({ req, deps }) => {
  const cuerpo = await leerCuerpo(req);
  const correo = validarEmail(cuerpo.email);
  const authKey = sobre(cuerpo.auth_key, "auth_key", 128);
  const totp = typeof cuerpo.totp === "string" ? cuerpo.totp.trim() : "";
  const clave = claveAcceso("soporte", correo);
  await comprobarBloqueo(deps, clave);
  const { rows } = await enCuentas(deps, (c) => c.query(`SELECT * FROM soporte_usuarios WHERE email = $1`, [correo]));
  const fila = rows[0];
  const claveValida = await verificarLlaveAuth(authKey, fila?.auth_hash);
  const totpValido =
    !!fila && !fila.desactivado_en && verificarTotp(descifrarServidor(secretoServidor(deps), fila.totp_cifrado), totp, deps.ahora().getTime());
  if (!fila || !claveValida || !totpValido) {
    await registrarFallo(deps, clave);
    throw new ErrorHttp(401, "credenciales_invalidas", "El correo, la contraseña o el código no coinciden.");
  }
  await limpiarFallos(deps, clave);
  const token = nuevoToken();
  await enCuentas(deps, async (c) => {
    await c.query(`INSERT INTO soporte_sesiones (token_hash, soporte_id, expira_en) VALUES ($1, $2, $3)`, [
      sha256(token),
      fila.id,
      new Date(deps.ahora().getTime() + HORAS_SESION_SOPORTE * 3600000),
    ]);
    await c.query(`UPDATE soporte_usuarios SET ultimo_acceso = $2 WHERE id = $1`, [fila.id, deps.ahora()]);
  });
  return json(
    { usuario: { id: fila.id, email: fila.email, nombre: fila.nombre, rol: fila.rol, debe_cambiar: fila.debe_cambiar }, llave_envuelta: fila.llave_envuelta, kdf_sal: fila.kdf_sal, kdf_iter: fila.kdf_iter },
    200,
    { "set-cookie": cookieSesion(COOKIE_SOPORTE, token, HORAS_SESION_SOPORTE * 3600, deps.cookiesSeguras) },
  );
};

const salirSoporte: Manejador = async ({ req, deps }) => {
  const token = leerCookie(req, COOKIE_SOPORTE);
  if (token) await enCuentas(deps, (c) => c.query(`DELETE FROM soporte_sesiones WHERE token_hash = $1`, [sha256(token)]));
  return json({ ok: true }, 200, { "set-cookie": cookieSesion(COOKIE_SOPORTE, "", 0, deps.cookiesSeguras) });
};

const sesionSoporte: Manejador = async (ctx) => {
  const s = await leerSoporte(ctx);
  return json({
    usuario: { id: s.soporteId, email: s.email, nombre: s.nombre, rol: s.rol, debe_cambiar: s.debeCambiar },
    llave_envuelta: s.llaveEnvuelta,
    kdf_sal: s.kdfSal,
    kdf_iter: s.kdfIter,
  });
};

const cambiarSoporte: Manejador = async (ctx) => {
  const s = await leerSoporte(ctx);
  const cuerpo = await leerCuerpo(ctx.req);
  const actual = sobre(cuerpo.auth_key_actual, "auth_key_actual", 128);
  const kdfSal = sobre(cuerpo.kdf_sal, "kdf_sal", 64);
  const kdfIter = entero(cuerpo.kdf_iter, "kdf_iter", 100_000, 10_000_000);
  const authKey = sobre(cuerpo.auth_key, "auth_key", 128);
  const llaveEnvuelta = sobre(cuerpo.llave_envuelta, "llave_envuelta", 8192);
  const { rows } = await enCuentas(ctx.deps, (c) => c.query(`SELECT auth_hash FROM soporte_usuarios WHERE id = $1`, [s.soporteId]));
  if (!(await verificarLlaveAuth(actual, rows[0]?.auth_hash))) {
    throw new ErrorHttp(401, "credenciales_invalidas", "Tu contraseña actual no coincide.");
  }
  const authHash = await protegerLlaveAuth(authKey);
  await enCuentas(ctx.deps, (c) =>
    c.query(
      `UPDATE soporte_usuarios SET kdf_sal = $2, kdf_iter = $3, auth_hash = $4, llave_envuelta = $5, debe_cambiar = false WHERE id = $1`,
      [s.soporteId, kdfSal, kdfIter, authHash, llaveEnvuelta],
    ),
  );
  return json({ ok: true });
};

const crearAgente: Manejador = async (ctx) => {
  const s = await leerSoporte(ctx);
  if (s.rol !== "administrador") throw new ErrorHttp(403, "sin_permiso", "Solo un administrador puede crear agentes.");
  const cuerpo = await leerCuerpo(ctx.req);
  const correo = validarEmail(cuerpo.email);
  const nombre = texto(cuerpo.nombre, "Nombre", { max: 160 });
  const kdfSal = sobre(cuerpo.kdf_sal, "kdf_sal", 64);
  const kdfIter = entero(cuerpo.kdf_iter, "kdf_iter", 100_000, 10_000_000);
  const authKey = sobre(cuerpo.auth_key, "auth_key", 128);
  const llaveEnvuelta = sobre(cuerpo.llave_envuelta, "llave_envuelta", 8192);
  const secreto = nuevoSecretoTotp();
  const authHash = await protegerLlaveAuth(authKey);
  await enCuentas(ctx.deps, (c) =>
    c.query(
      `INSERT INTO soporte_usuarios (email, nombre, rol, kdf_sal, kdf_iter, auth_hash, llave_envuelta, totp_cifrado, debe_cambiar)
       VALUES ($1, $2, 'agente', $3, $4, $5, $6, $7, true)`,
      [correo, nombre, kdfSal, kdfIter, authHash, llaveEnvuelta, cifrarServidor(secretoServidor(ctx.deps), secreto)],
    ),
  );
  return json({ totp_secreto: secreto }, 201);
};

const buscarConsultorios: Manejador = async (ctx) => {
  await leerSoporte(ctx);
  const q = (ctx.url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 100);
  const patron = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
  const { rows } = await enRol(ctx.deps, "sigilo_soporte", {}, (c) =>
    c.query(
      `SELECT id, nombre, plan, ciclo, estado, pagado_hasta, contacto_email, n_pacientes, ultima_actividad_en
         FROM consultorios WHERE lower(nombre) LIKE $1 OR lower(contacto_email) LIKE $1
        ORDER BY ultima_actividad_en DESC NULLS LAST LIMIT 50`,
      [patron],
    ),
  );
  const ahora = ctx.deps.ahora();
  return json({
    consultorios: rows.map((f) => ({ ...f, estado: estadoEfectivo(f, ahora), plan_nombre: PLANES[f.plan as Plan].nombre })),
  });
};

const pacientesSoporte: Manejador = async (ctx) => {
  const s = await leerSoporte(ctx);
  const consultorioId = uuid(ctx.parametros.id);
  const cuerpo = await leerCuerpo(ctx.req);
  const motivo = texto(cuerpo.motivo, "Motivo", { min: 5, max: 300 });
  const filas = await enRol(ctx.deps, "sigilo_soporte", { "sigilo.consultorio_soporte": consultorioId }, async (c) => {
    const existe = await c.query(`SELECT 1 FROM consultorios WHERE id = $1`, [consultorioId]);
    if (!existe.rowCount) throw new ErrorHttp(404, "no_encontrado", "No encontramos este consultorio.");
    await c.query(
      `INSERT INTO bitacora_soporte (consultorio_id, soporte_id, soporte_nombre, accion, motivo) VALUES ($1, $2, $3, 'consulto_lista_de_pacientes', $4)`,
      [consultorioId, s.soporteId, s.nombre, motivo],
    );
    const { rows } = await c.query(
      `SELECT id, nombre_sellado, ultima_consulta_en, ultima_receta_en FROM pacientes
        WHERE archivado_en IS NULL ORDER BY ultima_consulta_en DESC NULLS LAST LIMIT 5000`,
    );
    return rows;
  });
  return json({ pacientes: filas });
};

const metricasSoporte: Manejador = async (ctx) => {
  const s = await leerSoporte(ctx);
  if (s.rol !== "administrador") throw new ErrorHttp(403, "sin_permiso", "Solo un administrador puede ver las métricas.");
  const datos = await enRol(ctx.deps, "sigilo_soporte", {}, async (c) => {
    const consultorios = await c.query(`SELECT plan, ciclo, estado, pagado_hasta FROM consultorios`);
    const pagos = await c.query(
      `SELECT to_char(pagado_en, 'YYYY-MM') AS mes, sum(monto_centavos)::bigint AS centavos, count(*)::int AS pagos FROM pagos GROUP BY 1 ORDER BY 1 DESC LIMIT 24`,
    );
    const origenes = await c.query(
      `SELECT coalesce(origen, 'sin_dato') AS origen, count(*)::int AS altas FROM solicitudes
        WHERE tipo = 'alta' AND estado = 'pagada' GROUP BY 1 ORDER BY 2 DESC, 1`,
    );
    const fundadores = await c.query(`SELECT count(*)::int AS total FROM lista_fundadores`);
    return { consultorios: consultorios.rows, pagos: pagos.rows, origenes: origenes.rows, fundadores: fundadores.rows[0].total };
  });
  const ahora = ctx.deps.ahora();
  const activos = datos.consultorios.filter((f) => ["activo", "gracia"].includes(estadoEfectivo(f, ahora)));
  const mrr = activos.reduce((suma, f) => {
    const precio = PLANES[f.plan as Plan].precios[f.ciclo as Ciclo];
    return suma + (f.ciclo === "anual" ? precio / 12 : precio);
  }, 0);
  return json({
    activos: activos.length,
    total: datos.consultorios.length,
    ingreso_mensual_recurrente_centavos: Math.round(mrr),
    pagos: datos.pagos,
    altas_por_origen: datos.origenes,
    fundadores: datos.fundadores,
  });
};

const listarFundadores: Manejador = async (ctx) => {
  const s = await leerSoporte(ctx);
  if (s.rol !== "administrador") throw new ErrorHttp(403, "sin_permiso", "Solo un administrador puede ver la lista de fundadores.");
  const { rows } = await enRol(ctx.deps, "sigilo_soporte", {}, (c) =>
    c.query(`SELECT nombre, email, especialidad, ciudad, origen, creado_en FROM lista_fundadores ORDER BY creado_en LIMIT 5000`),
  );
  return json({ fundadores: rows });
};

// ---------------------------------------------------------------------------
// Simulador de pagos (solo fuera de producción)
// ---------------------------------------------------------------------------

function exigirSimulador(deps: Dependencias) {
  if ((deps.env("PAGOS_MODO") ?? "conekta") !== "simulado" || deps.entorno === "production") {
    throw new ErrorHttp(404, "no_encontrado", "No encontrado.");
  }
}

const simuladorOrden: Manejador = async ({ url, deps }) => {
  exigirSimulador(deps);
  const datos = urlsSimuladas(url.searchParams.get("orden") ?? "");
  if (!datos) throw new ErrorHttp(404, "no_encontrado", "Orden desconocida.");
  return json(datos);
};

const simuladorPagar: Manejador = async ({ req, deps }) => {
  exigirSimulador(deps);
  const cuerpo = await leerCuerpo(req);
  const orden = texto(cuerpo.orden, "orden", { max: 100 });
  marcarOrdenPagada(orden, typeof cuerpo.metodo === "string" ? cuerpo.metodo : "card");
  const proveedor = obtenerProveedor(deps, req);
  const evento = JSON.stringify({ id: `evt_${orden}`, type: "order.paid", orden });
  const firma = firmarSimulado(deps.env("SIMULADOR_SECRETO") ?? "secreto-de-desarrollo", evento);
  const resultado = await procesarEvento(deps, proveedor, proveedor.leerEvento(evento, new Headers({ digest: firma })));
  if (resultado.aviso) await avisarActivacion(deps, req, resultado.aviso).catch(() => {});
  return json({ resultado: resultado.resultado, exito: urlsSimuladas(orden)?.exito });
};

// ---------------------------------------------------------------------------
// Enrutador
// ---------------------------------------------------------------------------

type Ruta = { metodo: string; patron: RegExp; nombres: string[]; manejador: Manejador };

function ruta(metodo: string, plantilla: string, manejador: Manejador): Ruta {
  const nombres: string[] = [];
  const patron = plantilla.replace(/:([a-z_]+)/g, (_, nombre) => {
    nombres.push(nombre);
    return "([^/]+)";
  });
  return { metodo, patron: new RegExp(`^${patron}$`), nombres, manejador };
}

const RUTAS: Ruta[] = [
  ruta("GET", "/api/config", config),
  ruta("POST", "/api/fundadores", registrarFundador),
  ruta("POST", "/api/checkout", crearCheckout),
  ruta("GET", "/api/checkout/estado", estadoCheckout),
  ruta("POST", "/api/webhooks/pago", webhookPago),
  ruta("POST", "/api/activacion/reenviar", reenviarActivacion),
  ruta("GET", "/api/activacion/:token", leerActivacion),
  ruta("POST", "/api/activacion/:token", completarActivacion),
  ruta("POST", "/api/auth/parametros", parametrosAcceso),
  ruta("POST", "/api/auth/entrar", entrar),
  ruta("POST", "/api/auth/salir", salir),
  ruta("POST", "/api/auth/cambiar", cambiarContrasena),
  ruta("POST", "/api/auth/recuperar/paso1", recuperarPaso1),
  ruta("POST", "/api/auth/recuperar/paso2", recuperarPaso2),
  ruta("GET", "/api/sesion", sesionActual),
  ruta("GET", "/api/consultorio", leerConsultorio),
  ruta("PUT", "/api/consultorio", guardarConsultorio),
  ruta("PUT", "/api/recuperacion", actualizarRecuperacion),
  ruta("GET", "/api/usuarios", listarUsuarios),
  ruta("POST", "/api/usuarios", crearUsuario),
  ruta("PATCH", "/api/usuarios/:id", actualizarUsuario),
  ruta("GET", "/api/pacientes", listarPacientes),
  ruta("POST", "/api/pacientes", crearPaciente),
  ruta("PUT", "/api/pacientes/:id", actualizarPaciente),
  ruta("GET", "/api/pacientes/:id/registros", listarRegistros),
  ruta("POST", "/api/pacientes/:id/registros", crearRegistros),
  ruta("POST", "/api/registros/:id/anular", anularRegistro),
  ruta("POST", "/api/familia", crearEnlaceFamilia),
  ruta("GET", "/api/familia/:id", leerEnlaceFamilia),
  ruta("DELETE", "/api/familia/:id", revocarEnlaceFamilia),
  ruta("GET", "/api/bitacora", leerBitacora),
  ruta("GET", "/api/cuenta", leerCuenta),
  ruta("POST", "/api/cuenta/renovar", renovarCuenta),
  ruta("POST", "/api/soporte/instalar", instalarSoporte),
  ruta("POST", "/api/soporte/parametros", parametrosSoporte),
  ruta("POST", "/api/soporte/entrar", entrarSoporte),
  ruta("POST", "/api/soporte/salir", salirSoporte),
  ruta("GET", "/api/soporte/sesion", sesionSoporte),
  ruta("POST", "/api/soporte/cambiar", cambiarSoporte),
  ruta("POST", "/api/soporte/usuarios", crearAgente),
  ruta("GET", "/api/soporte/consultorios", buscarConsultorios),
  ruta("POST", "/api/soporte/consultorios/:id/pacientes", pacientesSoporte),
  ruta("GET", "/api/soporte/metricas", metricasSoporte),
  ruta("GET", "/api/soporte/fundadores", listarFundadores),
  ruta("GET", "/api/simulador/orden", simuladorOrden),
  ruta("POST", "/api/simulador/pagar", simuladorPagar),
];

let rolesVerificados = false;

/** Si un rol pudiera saltarse RLS, el servidor se niega a atender. Falla cerrado. */
async function verificarRoles(deps: Dependencias) {
  if (rolesVerificados) return;
  const { rows } = await deps.pool.query(
    `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('sigilo_cuentas', 'sigilo_clinico', 'sigilo_soporte')`,
  );
  if (rows.length !== 3 || rows.some((r) => r.rolsuper || r.rolbypassrls)) {
    throw new Error("Los roles de la base de datos no aíslan los datos. El servidor no atenderá.");
  }
  rolesVerificados = true;
}

function origenPermitido(req: Request, deps: Dependencias, url: URL): boolean {
  if (req.method === "GET" || url.pathname === "/api/webhooks/pago") return true;
  const origen = req.headers.get("origin");
  if (!origen) return true; // Sin navegador de por medio; las cookies son SameSite=Strict.
  const permitido = deps.env("URL_BASE")?.replace(/\/$/, "") ?? `${url.protocol}//${url.host}`;
  return origen === permitido;
}

export function crearManejador(deps: Dependencias) {
  return async (req: Request, extra: { ip?: string } = {}): Promise<Response> => {
    const url = new URL(req.url);
    try {
      await verificarRoles(deps);
      if (!origenPermitido(req, deps, url)) throw new ErrorHttp(403, "origen_no_permitido", "Origen no permitido.");
      for (const r of RUTAS) {
        if (r.metodo !== req.method) continue;
        const coincidencia = r.patron.exec(url.pathname);
        if (!coincidencia) continue;
        const parametros: Record<string, string> = {};
        r.nombres.forEach((nombre, i) => {
          parametros[nombre] = decodeURIComponent(coincidencia[i + 1]);
        });
        return await r.manejador({ req, deps, ip: extra.ip ?? "", parametros, url });
      }
      throw new ErrorHttp(404, "no_encontrado", "No encontrado.");
    } catch (error) {
      if (error instanceof ErrorHttp) return json({ error: error.codigo, mensaje: error.message }, error.estado);
      const pg = error as { code?: string; message?: string };
      if (pg.code === "23505") return json({ error: "duplicado", mensaje: "Ese registro ya existe." }, 409);
      if (pg.code === "P0002") return json({ error: "no_encontrado", mensaje: "No encontramos este paciente." }, 404);
      console.error("Error interno:", pg.message);
      return json({ error: "error_interno", mensaje: "Ocurrió un problema en el servidor. Vuelve a intentar." }, 500);
    }
  };
}

export function reiniciarVerificacionParaPruebas() {
  rolesVerificados = false;
}
