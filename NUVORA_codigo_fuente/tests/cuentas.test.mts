import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { crearConsultorio, crearEntorno, crearPaciente, crearRegistro, cripto, instalarSoporte, ITER_PRUEBA, type Consultorio, type Entorno } from "./base.mts";

async function entrar(e: Entorno, correo: string, contrasena: string) {
  const p = await e.llamar("POST", "/api/auth/parametros", { email: correo });
  const d = await cripto.derivarDeContrasena(contrasena, p.datos.kdf_sal, p.datos.kdf_iter);
  const r = await e.llamar("POST", "/api/auth/entrar", { email: correo, auth_key: d.authKey });
  return { ...r, llaveEnvoltura: d.llaveEnvoltura };
}

async function crearUsuario(e: Entorno, co: Consultorio, correo: string, rol: string, contrasena: string) {
  const sal = cripto.nuevaSal();
  const d = await cripto.derivarDeContrasena(contrasena, sal, ITER_PRUEBA);
  return e.llamar(
    "POST",
    "/api/usuarios",
    { email: correo, nombre: `Usuario ${rol}`, rol, kdf_sal: sal, kdf_iter: ITER_PRUEBA, auth_key: d.authKey, tk_envuelta: await cripto.envolverLlave(co.tkBytes, d.llaveEnvoltura) },
    co.cookie,
  );
}

describe("cuentas, roles y planes", () => {
  let e: Entorno;
  let publica: string;

  before(async () => {
    e = await crearEntorno();
    publica = (await instalarSoporte(e)).publica;
  });
  after(async () => {
    await e.cerrar();
  });

  test("no se abren inscripciones hasta instalar soporte", async () => {
    const otro = await crearEntorno();
    const r = await otro.llamar("POST", "/api/checkout", { plan: "esencial", ciclo: "mensual", email: "x@y.test", nombre_consultorio: "X", nombre_medico: "Y", acepto_terminos: true });
    assert.equal(r.estado, 503);
    await otro.cerrar();
  });

  test("hay que aceptar términos para pagar", async () => {
    const r = await e.llamar("POST", "/api/checkout", { plan: "esencial", ciclo: "mensual", email: "x@y.test", nombre_consultorio: "X", nombre_medico: "Y" });
    assert.equal(r.estado, 400);
    assert.equal(r.datos.error, "terminos_pendientes");
  });

  test("el precio lo pone el servidor, no el navegador", async () => {
    const r = await e.llamar("POST", "/api/checkout", { plan: "clinica", ciclo: "anual", monto_centavos: 100, email: "precio@y.test", nombre_consultorio: "X", nombre_medico: "Y", acepto_terminos: true });
    assert.equal(r.estado, 201);
    const { rows } = await e.pool.query(`SELECT monto_centavos FROM solicitudes WHERE email = 'precio@y.test'`);
    assert.equal(rows[0].monto_centavos, 1490000);
  });

  test("sin pago no hay acceso; con pago se activa una sola vez", async () => {
    const correo = "activar@ejemplo.test";
    const checkout = await e.llamar("POST", "/api/checkout", { plan: "esencial", ciclo: "mensual", email: correo, nombre_consultorio: "Uno", nombre_medico: "Dr. Uno", acepto_terminos: true });
    const orden = new URL(checkout.datos.url).searchParams.get("orden")!;
    assert.equal((await e.pool.query(`SELECT 1 FROM usuarios WHERE email = $1`, [correo])).rowCount, 0);

    const p1 = await e.llamar("POST", "/api/simulador/pagar", { orden });
    assert.equal(p1.datos.resultado, "activada");
    const p2 = await e.llamar("POST", "/api/simulador/pagar", { orden });
    assert.equal(p2.datos.resultado, "duplicado");
    assert.equal((await e.pool.query(`SELECT 1 FROM consultorios WHERE contacto_email = $1`, [correo])).rowCount, 1);
    assert.equal((await e.pool.query(`SELECT 1 FROM pagos p JOIN consultorios c ON c.id = p.consultorio_id WHERE c.contacto_email = $1`, [correo])).rowCount, 1);

    const token = /#activar\/([\w-]+)/.exec(e.correos.filter((c) => c.para === correo).at(-1)!.texto)![1];
    const info = await e.llamar("GET", `/api/activacion/${token}`);
    assert.equal(info.datos.email, correo);

    const sal = cripto.nuevaSal();
    const d = await cripto.derivarDeContrasena("contrasena-larga-uno", sal, ITER_PRUEBA);
    const tk = cripto.nuevaLlaveConsultorio();
    const rec = await cripto.derivarDeCodigo(cripto.nuevoCodigoRecuperacion());
    const cuerpo = { kdf_sal: sal, kdf_iter: ITER_PRUEBA, auth_key: d.authKey, tk_envuelta: await cripto.envolverLlave(tk, d.llaveEnvoltura), rec_auth: rec.recAuth, tk_envuelta_rec: await cripto.envolverLlave(tk, rec.llaveEnvoltura) };
    assert.equal((await e.llamar("POST", `/api/activacion/${token}`, cuerpo)).estado, 200);
    assert.equal((await e.llamar("POST", `/api/activacion/${token}`, cuerpo)).estado, 410);
  });

  test("un aviso con firma falsa no activa nada", async () => {
    const checkout = await e.llamar("POST", "/api/checkout", { plan: "esencial", ciclo: "mensual", email: "falso@ejemplo.test", nombre_consultorio: "Falso", nombre_medico: "Dr. Falso", acepto_terminos: true });
    const orden = new URL(checkout.datos.url).searchParams.get("orden")!;
    const evento = JSON.stringify({ id: "evt_falso", type: "order.paid", orden });
    const r = await e.llamar("POST", "/api/webhooks/pago", evento, undefined, { digest: "firma-falsa" });
    assert.equal(r.estado, 401);
    assert.equal((await e.pool.query(`SELECT 1 FROM consultorios WHERE contacto_email = 'falso@ejemplo.test'`)).rowCount, 0);
  });

  test("un aviso bien firmado de una orden que no se pagó tampoco activa", async () => {
    const { firmarSimulado } = await import("../src/servidor/pagos/simulado.mts");
    const checkout = await e.llamar("POST", "/api/checkout", { plan: "esencial", ciclo: "mensual", email: "sinpago@ejemplo.test", nombre_consultorio: "Sin pago", nombre_medico: "Dr. Sin", acepto_terminos: true });
    const orden = new URL(checkout.datos.url).searchParams.get("orden")!;
    const evento = JSON.stringify({ id: "evt_sinpago", type: "order.paid", orden });
    const r = await e.llamar("POST", "/api/webhooks/pago", evento, undefined, { digest: firmarSimulado("secreto-simulador", evento) });
    assert.equal(r.estado, 200);
    assert.equal((await e.pool.query(`SELECT 1 FROM consultorios WHERE contacto_email = 'sinpago@ejemplo.test'`)).rowCount, 0);
  });

  test("la página de éxito puede activar con su propio token, y un token falso no", async () => {
    const checkout = await e.llamar("POST", "/api/checkout", { plan: "esencial", ciclo: "anual", email: "exito@ejemplo.test", nombre_consultorio: "Éxito", nombre_medico: "Dr. Éxito", acepto_terminos: true });
    const orden = new URL(checkout.datos.url).searchParams.get("orden")!;
    const pago = await e.llamar("POST", "/api/simulador/pagar", { orden });
    const [id, token] = new URL(pago.datos.exito).hash.slice(1).split(".");
    const bueno = await e.llamar("GET", `/api/checkout/estado?s=${id}&t=${token}`);
    assert.equal(bueno.datos.estado, "pagada");
    assert.match(bueno.datos.activar, /^#activar\//);
    const malo = await e.llamar("GET", `/api/checkout/estado?s=${id}&t=falso`);
    assert.equal(malo.estado, 404);
  });

  test("cada médico tiene su usuario; el asistente no lee notas", async () => {
    const co = await crearConsultorio(e, publica, "titular.roles@ejemplo.test", "contrasena-larga-roles", { plan: "profesional" });
    const paciente = await crearPaciente(e, co, { nombre: "Paciente Roles" });
    await crearRegistro(e, co, paciente, "consulta", { nota: "contenido" });
    await crearRegistro(e, co, paciente, "somatometria", { peso: 8 });

    const r = await crearUsuario(e, co, "asistente@ejemplo.test", "asistente", "temporal-asistente-1");
    assert.equal(r.estado, 201);
    const asistente = await entrar(e, "asistente@ejemplo.test", "temporal-asistente-1");
    assert.equal(asistente.estado, 200);
    assert.equal(asistente.datos.usuario.debe_cambiar, true);

    const tk = await cripto.abrirLlave(asistente.datos.tk_envuelta, asistente.llaveEnvoltura);
    assert.deepEqual(Array.from(tk), Array.from(co.tkBytes), "el nuevo usuario abre la misma llave del consultorio");

    const registros = await e.llamar("GET", `/api/pacientes/${paciente}/registros`, undefined, asistente.cookie);
    assert.deepEqual(registros.datos.registros.map((x: any) => x.tipo), ["somatometria"]);
    const crearNota = await crearRegistro(e, co, paciente, "consulta", { nota: "no" }, asistente.cookie);
    assert.equal(crearNota.estado, 403);
    assert.equal((await e.llamar("GET", "/api/usuarios", undefined, asistente.cookie)).estado, 403);
    assert.equal((await e.llamar("GET", "/api/bitacora", undefined, asistente.cookie)).estado, 403);
  });

  test("el plan limita usuarios", async () => {
    const co = await crearConsultorio(e, publica, "titular.limite@ejemplo.test", "contrasena-larga-limite", { plan: "esencial" });
    assert.equal((await crearUsuario(e, co, "medico2@ejemplo.test", "medico", "temporal-medico-22")).estado, 403);
    assert.equal((await crearUsuario(e, co, "asist1@ejemplo.test", "asistente", "temporal-asist-111")).estado, 201);
    assert.equal((await crearUsuario(e, co, "asist2@ejemplo.test", "asistente", "temporal-asist-222")).estado, 403);
  });

  test("el enlace para la familia requiere plan que lo incluya", async () => {
    const co = await crearConsultorio(e, publica, "titular.enlace@ejemplo.test", "contrasena-larga-enlace", { plan: "esencial" });
    const p = await crearPaciente(e, co, { nombre: "Paciente Enlace" });
    const r = await e.llamar("POST", "/api/familia", { id: cripto.nuevoId(), paciente_id: p, cifrado: "v1.AAAA.BBBB", dias: 7 }, co.cookie);
    assert.equal(r.estado, 403);
  });

  test("el enlace se abre solo con su llave, vence y se puede revocar", async () => {
    const co = await crearConsultorio(e, publica, "titular.fam@ejemplo.test", "contrasena-larga-familia", { plan: "profesional" });
    const p = await crearPaciente(e, co, { nombre: "Paciente Familia" });
    const { cifrado, llaveEnlace } = await cripto.cifrarParaEnlace({ receta: "Amoxicilina-enlace" });
    const id = cripto.nuevoId();
    assert.equal((await e.llamar("POST", "/api/familia", { id, paciente_id: p, cifrado, dias: 7 }, co.cookie)).estado, 201);
    const r = await e.llamar("GET", `/api/familia/${id}`);
    assert.equal(r.estado, 200);
    assert.ok(!JSON.stringify(r.datos).includes("Amoxicilina"));
    assert.deepEqual(await cripto.descifrarDeEnlace(r.datos.cifrado, llaveEnlace), { receta: "Amoxicilina-enlace" });

    e.fijarReloj(new Date(Date.now() + 8 * 86400000));
    assert.equal((await e.llamar("GET", `/api/familia/${id}`)).estado, 410);
    e.fijarReloj(null);

    assert.equal((await e.llamar("DELETE", `/api/familia/${id}`, undefined, co.cookie)).estado, 200);
    assert.equal((await e.llamar("GET", `/api/familia/${id}`)).estado, 410);
  });

  test("al vencer: gracia, luego solo lectura. Nunca se pierde el acceso a los expedientes", async () => {
    const co = await crearConsultorio(e, publica, "titular.vence@ejemplo.test", "contrasena-larga-vence", { plan: "esencial", ciclo: "mensual" });
    const p = await crearPaciente(e, co, { nombre: "Paciente Vence" });

    e.fijarReloj(new Date(Date.now() + 33 * 86400000));
    const enGracia = await e.llamar("GET", "/api/sesion", undefined, (await entrar(e, co.correo, co.contrasena)).cookie);
    assert.equal(enGracia.datos.consultorio.estado, "gracia");

    e.fijarReloj(new Date(Date.now() + 45 * 86400000));
    const s = await entrar(e, co.correo, co.contrasena);
    assert.equal(s.datos.consultorio.estado, "solo_lectura");
    assert.equal(s.datos.consultorio.puede_escribir, false);
    assert.equal((await crearRegistro(e, co, p, "consulta", { n: 1 }, s.cookie)).estado, 402);
    assert.equal((await e.llamar("GET", "/api/pacientes", undefined, s.cookie)).datos.pacientes.length, 1);
    assert.equal((await e.llamar("GET", `/api/pacientes/${p}/registros`, undefined, s.cookie)).estado, 200);
    e.fijarReloj(null);
  });

  test("renovar extiende sin descontar lo ya pagado y permite cambiar de plan", async () => {
    const co = await crearConsultorio(e, publica, "titular.renueva@ejemplo.test", "contrasena-larga-renueva", { plan: "esencial", ciclo: "mensual" });
    const antes = (await e.pool.query(`SELECT pagado_hasta FROM consultorios WHERE id = $1`, [co.consultorioId])).rows[0].pagado_hasta;
    const r = await e.llamar("POST", "/api/cuenta/renovar", { plan: "profesional", ciclo: "anual" }, co.cookie);
    assert.equal(r.estado, 201);
    const orden = new URL(r.datos.url).searchParams.get("orden")!;
    const sinPagar = (await e.pool.query(`SELECT plan FROM consultorios WHERE id = $1`, [co.consultorioId])).rows[0];
    assert.equal(sinPagar.plan, "esencial", "el plan no cambia antes del pago");
    assert.equal((await e.llamar("POST", "/api/simulador/pagar", { orden })).datos.resultado, "renovada");
    const fila = (await e.pool.query(`SELECT plan, ciclo, pagado_hasta FROM consultorios WHERE id = $1`, [co.consultorioId])).rows[0];
    assert.equal(fila.plan, "profesional");
    assert.equal(fila.ciclo, "anual");
    assert.ok(new Date(fila.pagado_hasta).getTime() > new Date(antes).getTime() + 300 * 86400000);
  });

  test("cambiar contraseña conserva la llave; la anterior deja de servir", async () => {
    const co = await crearConsultorio(e, publica, "titular.cambio@ejemplo.test", "contrasena-larga-vieja", { plan: "esencial" });
    const p = await e.llamar("POST", "/api/auth/parametros", { email: co.correo });
    const actual = await cripto.derivarDeContrasena(co.contrasena, p.datos.kdf_sal, p.datos.kdf_iter);
    const sal = cripto.nuevaSal();
    const nueva = await cripto.derivarDeContrasena("contrasena-larga-nueva", sal, ITER_PRUEBA);
    const r = await e.llamar("POST", "/api/auth/cambiar", { auth_key_actual: actual.authKey, kdf_sal: sal, kdf_iter: ITER_PRUEBA, auth_key: nueva.authKey, tk_envuelta: await cripto.envolverLlave(co.tkBytes, nueva.llaveEnvoltura) }, co.cookie);
    assert.equal(r.estado, 200);
    assert.equal((await entrar(e, co.correo, co.contrasena)).estado, 401);
    const s = await entrar(e, co.correo, "contrasena-larga-nueva");
    assert.equal(s.estado, 200);
    assert.deepEqual(Array.from(await cripto.abrirLlave(s.datos.tk_envuelta, s.llaveEnvoltura)), Array.from(co.tkBytes));
  });

  test("el código de recuperación devuelve el acceso sin perder datos; soporte no interviene", async () => {
    const co = await crearConsultorio(e, publica, "titular.recupera@ejemplo.test", "contrasena-larga-olvido", { plan: "esencial" });
    const paciente = await crearPaciente(e, co, { nombre: "Paciente Recupera" });

    const falso = await cripto.derivarDeCodigo(cripto.nuevoCodigoRecuperacion());
    assert.equal((await e.llamar("POST", "/api/auth/recuperar/paso1", { email: co.correo, rec_auth: falso.recAuth })).estado, 401);

    const rec = await cripto.derivarDeCodigo(co.codigo);
    const p1 = await e.llamar("POST", "/api/auth/recuperar/paso1", { email: co.correo, rec_auth: rec.recAuth });
    assert.equal(p1.estado, 200);
    const tk = await cripto.abrirLlave(p1.datos.tk_envuelta_rec, rec.llaveEnvoltura);

    const sal = cripto.nuevaSal();
    const nueva = await cripto.derivarDeContrasena("contrasena-larga-recuperada", sal, ITER_PRUEBA);
    const p2 = await e.llamar("POST", "/api/auth/recuperar/paso2", { ticket: p1.datos.ticket, kdf_sal: sal, kdf_iter: ITER_PRUEBA, auth_key: nueva.authKey, tk_envuelta: await cripto.envolverLlave(tk, nueva.llaveEnvoltura) });
    assert.equal(p2.estado, 200);
    assert.equal((await e.llamar("POST", "/api/auth/recuperar/paso2", { ticket: p1.datos.ticket, kdf_sal: sal, kdf_iter: ITER_PRUEBA, auth_key: nueva.authKey, tk_envuelta: "v1.AAAA.BBBB" })).estado, 410);

    const s = await entrar(e, co.correo, "contrasena-larga-recuperada");
    const llave = await cripto.importarLlaveConsultorio(await cripto.abrirLlave(s.datos.tk_envuelta, s.llaveEnvoltura));
    const lista = await e.llamar("GET", "/api/pacientes", undefined, s.cookie);
    const fila = lista.datos.pacientes.find((x: any) => x.id === paciente);
    assert.equal((await cripto.descifrarJson(llave, fila.cifrado, cripto.contexto(co.consultorioId, "paciente", paciente))).nombre, "Paciente Recupera");
  });

  test("demasiados intentos bloquean el acceso; un correo inexistente no se distingue", async () => {
    const co = await crearConsultorio(e, publica, "titular.bloqueo@ejemplo.test", "contrasena-larga-bloqueo", { plan: "esencial" });
    for (let i = 0; i < 8; i++) {
      assert.equal((await entrar(e, co.correo, "incorrecta-incorrecta")).estado, 401);
    }
    assert.equal((await entrar(e, co.correo, co.contrasena)).estado, 429);

    const existe = await e.llamar("POST", "/api/auth/parametros", { email: co.correo });
    const noExiste = await e.llamar("POST", "/api/auth/parametros", { email: "nadie@ejemplo.test" });
    assert.deepEqual(Object.keys(existe.datos), Object.keys(noExiste.datos));
    const noExiste2 = await e.llamar("POST", "/api/auth/parametros", { email: "nadie@ejemplo.test" });
    assert.equal(noExiste.datos.kdf_sal, noExiste2.datos.kdf_sal);
  });

  test("otro origen no puede operar con la sesión", async () => {
    const r = await e.llamar("POST", "/api/auth/salir", {}, undefined, { origin: "https://sitio-malicioso.test" });
    assert.equal(r.estado, 403);
  });

  test("la marca rechaza logos peligrosos", async () => {
    const co = await crearConsultorio(e, publica, "titular.marca@ejemplo.test", "contrasena-larga-marca", { plan: "esencial" });
    const svg = await e.llamar("PUT", "/api/consultorio", { nombre: "X", marca: { logo: "data:image/svg+xml;base64,PHN2Zz4=" } }, co.cookie);
    assert.equal(svg.estado, 400);
    const color = await e.llamar("PUT", "/api/consultorio", { nombre: "X", marca: { color_primario: "red;}" } }, co.cookie);
    assert.equal(color.estado, 400);
    const bien = await e.llamar("PUT", "/api/consultorio", { nombre: "Clínica Sol", marca: { logo: "data:image/png;base64,iVBORw0KGgo=", color_primario: "#447DC0", medico_nombre: "Dra. Sol" } }, co.cookie);
    assert.equal(bien.estado, 200);
    assert.equal(bien.datos.consultorio.marca.medico_nombre, "Dra. Sol");
  });

  test("la pasarela simulada se niega a correr en producción", async () => {
    const prod = await crearEntorno({ PAGOS_MODO: "simulado" }, { entorno: "production" });
    const s = await prod.llamar("POST", "/api/simulador/pagar", { orden: "x" });
    assert.equal(s.estado, 404);
    await prod.cerrar();
  });
});
