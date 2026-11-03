import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { codigoTotp, descifrarServidor } from "../src/servidor/seguridad.mts";
import { crearConsultorio, crearEntorno, crearPaciente, crearRegistro, cripto, instalarSoporte, type Consultorio, type Entorno } from "./base.mts";

describe("privacidad y aislamiento", () => {
  let e: Entorno;
  let soporte: Awaited<ReturnType<typeof instalarSoporte>>;
  let a: Consultorio;
  let b: Consultorio;
  let pacienteA: string;
  let cookieSoporte: string;
  const NOMBRE = "Mariana Quintero Solís";
  const DIAGNOSTICO = "Bronquiolitis-diagnostico-secreto";

  before(async () => {
    e = await crearEntorno();
    soporte = await instalarSoporte(e);
    a = await crearConsultorio(e, soporte.publica, "dra.a@ejemplo.test", "contrasena-larga-a-1", { nombre: "Consultorio A" });
    b = await crearConsultorio(e, soporte.publica, "dr.b@ejemplo.test", "contrasena-larga-b-1", { nombre: "Consultorio B" });
    pacienteA = await crearPaciente(e, a, { nombre: NOMBRE, curp: "QUSM200101MSLNLR09" });
    const nota = await crearRegistro(e, a, pacienteA, "consulta", { diagnostico: DIAGNOSTICO });
    assert.equal(nota.estado, 201);
    const receta = await crearRegistro(e, a, pacienteA, "receta", { medicamentos: [{ nombre: "Paracetamol-secreto" }] });
    assert.equal(receta.estado, 201);

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

  test("la base de datos no contiene en claro ningún dato clínico ni nombre", async () => {
    const { rows } = await e.pool.query(`
      SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND data_type IN ('text', 'jsonb', 'character varying')`);
    const buscados = [NOMBRE, "Mariana", "Quintero", "QUSM200101", DIAGNOSTICO, "Paracetamol-secreto"];
    for (const { table_name, column_name } of rows) {
      const r = await e.pool.query(`SELECT "${column_name}"::text AS v FROM "${table_name}"`);
      for (const fila of r.rows) {
        for (const buscado of buscados) {
          assert.ok(!String(fila.v ?? "").includes(buscado), `${buscado} aparece en ${table_name}.${column_name}`);
        }
      }
    }
  });

  test("el médico sí puede leer lo que guardó", async () => {
    const lista = await e.llamar("GET", "/api/pacientes", undefined, a.cookie);
    const fila = lista.datos.pacientes[0];
    const datos = await cripto.descifrarJson(a.llave, fila.cifrado, cripto.contexto(a.consultorioId, "paciente", fila.id));
    assert.equal(datos.nombre, NOMBRE);
    const registros = await e.llamar("GET", `/api/pacientes/${pacienteA}/registros`, undefined, a.cookie);
    const nota = registros.datos.registros.find((r: any) => r.tipo === "consulta");
    const contenido = await cripto.descifrarJson(a.llave, nota.cifrado, cripto.contexto(a.consultorioId, "consulta", nota.id));
    assert.equal(contenido.diagnostico, DIAGNOSTICO);
  });

  test("otro consultorio no ve ni puede tocar al paciente", async () => {
    const lista = await e.llamar("GET", "/api/pacientes", undefined, b.cookie);
    assert.equal(lista.datos.pacientes.length, 0);
    const registros = await e.llamar("GET", `/api/pacientes/${pacienteA}/registros`, undefined, b.cookie);
    assert.equal(registros.estado, 404);
    const insertar = await crearRegistro(e, b, pacienteA, "consulta", { intento: true });
    assert.equal(insertar.estado, 404);
    const editar = await e.llamar("PUT", `/api/pacientes/${pacienteA}`, { cifrado: "v1.AAAA.BBBB", nombre_sellado: "AAAA" }, b.cookie);
    assert.equal(editar.estado, 404);
  });

  test("la llave de otro consultorio no abre los datos, y mover un texto cifrado lo invalida", async () => {
    const { rows } = await e.pool.query(`SELECT id, cifrado FROM pacientes WHERE id = $1`, [pacienteA]);
    await assert.rejects(cripto.descifrarJson(b.llave, rows[0].cifrado, cripto.contexto(a.consultorioId, "paciente", pacienteA)));
    await assert.rejects(cripto.descifrarJson(a.llave, rows[0].cifrado, cripto.contexto(a.consultorioId, "paciente", cripto.nuevoId())));
  });

  test("RLS aísla en la base de datos aunque el código olvide filtrar", async () => {
    const c = await e.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE sigilo_clinico");
      assert.equal((await c.query(`SELECT * FROM pacientes`)).rowCount, 0, "sin consultorio no se ve nada");
      await c.query(`SELECT set_config('sigilo.consultorio', $1, true)`, [b.consultorioId]);
      assert.equal((await c.query(`SELECT * FROM pacientes`)).rowCount, 0, "otro consultorio no ve nada");
      assert.equal((await c.query(`SELECT * FROM registros`)).rowCount, 0);
      await c.query(`SELECT set_config('sigilo.consultorio', $1, true)`, [a.consultorioId]);
      assert.equal((await c.query(`SELECT * FROM pacientes`)).rowCount, 1);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });

  test("soporte no puede leer contenido cifrado ni notas, ni siquiera por SQL", async () => {
    const intentos = [
      `SELECT cifrado FROM pacientes`,
      `SELECT * FROM pacientes`,
      `SELECT * FROM registros`,
      `SELECT * FROM usuarios`,
      `SELECT * FROM recuperacion`,
      `SELECT * FROM enlaces_familia`,
      `SELECT marca FROM consultorios`,
      `UPDATE pacientes SET nombre_sellado = 'x'`,
      `DELETE FROM pacientes`,
    ];
    for (const sql of intentos) {
      const c = await e.pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL ROLE sigilo_soporte");
        await c.query(`SELECT set_config('sigilo.consultorio_soporte', $1, true)`, [a.consultorioId]);
        await assert.rejects(c.query(sql), /permission denied/, sql);
      } finally {
        await c.query("ROLLBACK").catch(() => {});
        c.release();
      }
    }
  });

  test("soporte solo recibe nombre sellado, última consulta y última receta", async () => {
    const r = await e.llamar("POST", `/api/soporte/consultorios/${a.consultorioId}/pacientes`, { motivo: "Ticket 123: no aparece un paciente" }, cookieSoporte);
    assert.equal(r.estado, 200);
    assert.equal(r.datos.pacientes.length, 1);
    const fila = r.datos.pacientes[0];
    assert.deepEqual(Object.keys(fila).sort(), ["id", "nombre_sellado", "ultima_consulta_en", "ultima_receta_en"]);
    assert.equal(await cripto.abrirSello(soporte.privada, fila.nombre_sellado), NOMBRE);
    assert.ok(fila.ultima_consulta_en);
    assert.ok(fila.ultima_receta_en);
    const texto = JSON.stringify(r.datos);
    assert.ok(!texto.includes("cifrado"));
    assert.ok(!texto.includes(DIAGNOSTICO));
  });

  test("soporte no puede abrir la lista sin motivo, y sin sesión no entra", async () => {
    const sinMotivo = await e.llamar("POST", `/api/soporte/consultorios/${a.consultorioId}/pacientes`, { motivo: "" }, cookieSoporte);
    assert.equal(sinMotivo.estado, 400);
    const sinSesion = await e.llamar("POST", `/api/soporte/consultorios/${a.consultorioId}/pacientes`, { motivo: "Ticket 1234" });
    assert.equal(sinSesion.estado, 401);
    const conSesionMedico = await e.llamar("POST", `/api/soporte/consultorios/${a.consultorioId}/pacientes`, { motivo: "Ticket 1234" }, a.cookie);
    assert.equal(conSesionMedico.estado, 401);
  });

  test("el titular ve en su bitácora cada vez que soporte entró", async () => {
    const r = await e.llamar("GET", "/api/bitacora", undefined, a.cookie);
    assert.equal(r.estado, 200);
    const accesos = r.datos.soporte;
    assert.ok(accesos.length >= 1);
    assert.equal(accesos.at(-1).soporte_nombre, "Agente Uno");
    assert.match(accesos.at(-1).motivo, /Ticket 123/);
    const deB = await e.llamar("GET", "/api/bitacora", undefined, b.cookie);
    assert.equal(deB.datos.soporte.length, 0);
  });

  test("soporte sin segundo factor no entra", async () => {
    const sal = await e.llamar("POST", "/api/soporte/parametros", { email: soporte.correo });
    const { authKey } = await cripto.derivarDeContrasena(soporte.contrasena, sal.datos.kdf_sal, sal.datos.kdf_iter);
    const r = await e.llamar("POST", "/api/soporte/entrar", { email: soporte.correo, auth_key: authKey, totp: "000000" });
    assert.equal(r.estado, 401);
  });

  test("las notas no se pueden alterar ni borrar, y su hora la pone el servidor", async () => {
    const c = await e.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE sigilo_clinico");
      await c.query(`SELECT set_config('sigilo.consultorio', $1, true)`, [a.consultorioId]);
      await assert.rejects(c.query(`UPDATE registros SET cifrado = 'alterado'`), /permission denied/);
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      c.release();
    }
    const c2 = await e.pool.connect();
    try {
      await c2.query("BEGIN");
      await c2.query("SET LOCAL ROLE sigilo_clinico");
      await c2.query(`SELECT set_config('sigilo.consultorio', $1, true)`, [a.consultorioId]);
      await assert.rejects(c2.query(`DELETE FROM registros`), /permission denied/);
    } finally {
      await c2.query("ROLLBACK").catch(() => {});
      c2.release();
    }
    const { rows } = await e.pool.query(`SELECT sello FROM registros WHERE paciente_id = $1 ORDER BY secuencia`, [pacienteA]);
    assert.equal(rows.length, 2);
    assert.match(rows[0].sello, /^[0-9a-f]{64}$/);
    assert.notEqual(rows[0].sello, rows[1].sello);
  });

  test("el servidor rechaza atender si un rol pudiera saltarse el aislamiento", async () => {
    const { reiniciarVerificacionParaPruebas } = await import("../src/servidor/app.mts");
    await e.pool.query(`ALTER ROLE sigilo_soporte BYPASSRLS`).catch(() => {});
    reiniciarVerificacionParaPruebas();
    const r = await e.llamar("GET", "/api/config");
    await e.pool.query(`ALTER ROLE sigilo_soporte NOBYPASSRLS`).catch(() => {});
    reiniciarVerificacionParaPruebas();
    assert.equal(r.estado, 500);
    assert.equal((await e.llamar("GET", "/api/config")).estado, 200);
  });
});
