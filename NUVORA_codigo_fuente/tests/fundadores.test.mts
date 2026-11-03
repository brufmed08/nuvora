import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { codigoTotp, descifrarServidor } from "../src/servidor/seguridad.mts";
import { crearEntorno, cripto, crearConsultorio, instalarSoporte, ITER_PRUEBA, type Entorno } from "./base.mts";

const FUNDADORA = { nombre: "Dra. Lista", email: "dra.lista@ejemplo.test", especialidad: "Pediatría", ciudad: "Culiacán", origen: "congreso-mazatlan-2026", acepto_aviso: true };

describe("lista de fundadores y apertura de ventas", () => {
  let e: Entorno;
  let soporte: Awaited<ReturnType<typeof instalarSoporte>>;
  let cookieSoporte: string;

  before(async () => {
    e = await crearEntorno();
    soporte = await instalarSoporte(e);
    const sal = await e.llamar("POST", "/api/soporte/parametros", { email: soporte.correo });
    const { authKey } = await cripto.derivarDeContrasena(soporte.contrasena, sal.datos.kdf_sal, sal.datos.kdf_iter);
    const { rows } = await e.pool.query(`SELECT totp_cifrado FROM soporte_usuarios WHERE email = $1`, [soporte.correo]);
    const secreto = descifrarServidor("clave-de-pruebas-de-al-menos-32-caracteres", rows[0].totp_cifrado);
    const entrar = await e.llamar("POST", "/api/soporte/entrar", { email: soporte.correo, auth_key: authKey, totp: codigoTotp(secreto, Date.now()) });
    assert.equal(entrar.estado, 200);
    cookieSoporte = entrar.cookie!;
  });
  after(async () => {
    await e.cerrar();
  });

  test("apuntarse guarda los datos y confirma por correo", async () => {
    const r = await e.llamar("POST", "/api/fundadores", FUNDADORA);
    assert.equal(r.estado, 201);
    const { rows } = await e.pool.query(`SELECT * FROM lista_fundadores WHERE email = $1`, [FUNDADORA.email]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].origen, "congreso-mazatlan-2026");
    assert.equal(e.correos.filter((c) => c.para === FUNDADORA.email).length, 1);
  });

  test("un correo repetido responde igual, sin duplicar ni reenviar", async () => {
    const r = await e.llamar("POST", "/api/fundadores", { ...FUNDADORA, nombre: "Otro nombre" });
    assert.equal(r.estado, 201);
    const { rows } = await e.pool.query(`SELECT nombre FROM lista_fundadores WHERE email = $1`, [FUNDADORA.email]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].nombre, "Dra. Lista");
    assert.equal(e.correos.filter((c) => c.para === FUNDADORA.email).length, 1);
  });

  test("sin aceptar el aviso de privacidad no se guarda nada", async () => {
    const r = await e.llamar("POST", "/api/fundadores", { ...FUNDADORA, email: "sin.aviso@ejemplo.test", acepto_aviso: false });
    assert.equal(r.estado, 400);
    const { rowCount } = await e.pool.query(`SELECT 1 FROM lista_fundadores WHERE email = 'sin.aviso@ejemplo.test'`);
    assert.equal(rowCount, 0);
  });

  test("el campo trampa finge éxito y no guarda nada", async () => {
    const r = await e.llamar("POST", "/api/fundadores", { ...FUNDADORA, email: "robot@ejemplo.test", sitio_web: "http://spam.test" });
    assert.equal(r.estado, 201);
    const { rowCount } = await e.pool.query(`SELECT 1 FROM lista_fundadores WHERE email = 'robot@ejemplo.test'`);
    assert.equal(rowCount, 0);
    assert.equal(e.correos.filter((c) => c.para === "robot@ejemplo.test").length, 0);
  });

  test("un origen raro se descarta en lugar de guardarse", async () => {
    await e.llamar("POST", "/api/fundadores", { ...FUNDADORA, email: "origen.raro@ejemplo.test", origen: "<script>alert(1)</script>" });
    const { rows } = await e.pool.query(`SELECT origen FROM lista_fundadores WHERE email = 'origen.raro@ejemplo.test'`);
    assert.equal(rows[0].origen, null);
  });

  test("un médico o alguien sin sesión no puede leer la lista", async () => {
    const sinSesion = await e.llamar("GET", "/api/soporte/fundadores");
    assert.equal(sinSesion.estado, 401);
    const medico = await crearConsultorio(e, soporte.publica, "medico.lista@ejemplo.test", "contrasena-larga-lista-1");
    const conMedico = await e.llamar("GET", "/api/soporte/fundadores", undefined, medico.cookie);
    assert.equal(conMedico.estado, 401);
  });

  test("el administrador de soporte ve la lista y las altas por origen", async () => {
    const lista = await e.llamar("GET", "/api/soporte/fundadores", undefined, cookieSoporte);
    assert.equal(lista.estado, 200);
    assert.ok(lista.datos.fundadores.some((f: { email: string }) => f.email === FUNDADORA.email));

    const checkout = await e.llamar("POST", "/api/checkout", { plan: "esencial", ciclo: "mensual", email: "con.origen@ejemplo.test", nombre_consultorio: "Con origen", nombre_medico: "Dra. Origen", origen: "colega", acepto_terminos: true });
    assert.equal(checkout.estado, 201);
    const orden = new URL(checkout.datos.url).searchParams.get("orden")!;
    assert.equal((await e.llamar("POST", "/api/simulador/pagar", { orden })).estado, 200);

    const m = await e.llamar("GET", "/api/soporte/metricas", undefined, cookieSoporte);
    assert.equal(m.estado, 200);
    assert.ok(m.datos.fundadores >= 2);
    assert.deepEqual(m.datos.altas_por_origen.find((o: { origen: string }) => o.origen === "colega"), { origen: "colega", altas: 1 });
  });

  test("un agente que no es administrador no puede leer la lista", async () => {
    const sal = cripto.nuevaSal();
    const contrasena = "contrasena-del-agente-2";
    const d = await cripto.derivarDeContrasena(contrasena, sal, ITER_PRUEBA);
    const par = await cripto.nuevoParSoporte();
    const creado = await e.llamar(
      "POST",
      "/api/soporte/usuarios",
      { nombre: "Agente Dos", email: "agente.dos@ejemplo.test", kdf_sal: sal, kdf_iter: ITER_PRUEBA, auth_key: d.authKey, llave_envuelta: await cripto.envolverPrivadaSoporte(par.privadaBytes, d.llaveEnvoltura) },
      cookieSoporte,
    );
    assert.equal(creado.estado, 201);
    const entrar = await e.llamar("POST", "/api/soporte/entrar", { email: "agente.dos@ejemplo.test", auth_key: d.authKey, totp: codigoTotp(creado.datos.totp_secreto, Date.now()) });
    assert.equal(entrar.estado, 200);
    const lista = await e.llamar("GET", "/api/soporte/fundadores", undefined, entrar.cookie);
    assert.equal(lista.estado, 403);
  });

  test("la lista no le abre a soporte nada más de las solicitudes", async () => {
    const cliente = await e.pool.connect();
    try {
      await cliente.query("BEGIN");
      await cliente.query("SET LOCAL ROLE sigilo_soporte");
      await assert.rejects(cliente.query("SELECT email FROM solicitudes"), /permission denied/);
    } finally {
      await cliente.query("ROLLBACK");
      cliente.release();
    }
  });

  test("con pagos reales, las ventas quedan cerradas hasta abrirlas a propósito", async () => {
    const cerrado = await crearEntorno({ PAGOS_MODO: "conekta", CONEKTA_LLAVE_PRIVADA: "key_prueba", CONEKTA_LLAVE_WEBHOOK: "x" });
    await instalarSoporte(cerrado);
    const config = await cerrado.llamar("GET", "/api/config");
    assert.equal(config.datos.ventas_abiertas, false);
    const r = await cerrado.llamar("POST", "/api/checkout", { plan: "esencial", ciclo: "mensual", email: "antes@ejemplo.test", nombre_consultorio: "Antes", nombre_medico: "Dr. Antes", acepto_terminos: true });
    assert.equal(r.estado, 503);
    assert.equal(r.datos.error, "ventas_cerradas");
    const { rowCount } = await cerrado.pool.query(`SELECT 1 FROM solicitudes`);
    assert.equal(rowCount, 0);
    const lista = await cerrado.llamar("POST", "/api/fundadores", { ...FUNDADORA });
    assert.equal(lista.estado, 201);
    cerrado.variables.VENTAS_ABIERTAS = "si";
    assert.equal((await cerrado.llamar("GET", "/api/config")).datos.ventas_abiertas, true);
    await cerrado.cerrar();
  });
});
