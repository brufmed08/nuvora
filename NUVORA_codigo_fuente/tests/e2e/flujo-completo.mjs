// Prueba de punta a punta en un navegador real: compra, activación, expediente, receta, soporte y aislamiento.
// Uso: node tests/e2e/flujo-completo.mjs  (requiere scripts/servidor-local.mts en marcha)
import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const BASE = process.env.BASE ?? "http://localhost:8899";
const SALIDA = process.env.CAPTURAS ?? "capturas";
mkdirSync(SALIDA, { recursive: true });

const sufijo = Date.now();
const DOCTORA = { correo: `dra.${sufijo}@ejemplo.test`, contrasena: "una frase larga de prueba 1", consultorio: "Pediatría Sol" };
const OTRO = { correo: `dr.${sufijo}@ejemplo.test`, contrasena: "otra frase larga de prueba 2", consultorio: "Clínica Luna" };
const SOPORTE = { correo: `soporte.${sufijo}@ejemplo.test`, contrasena: "frase larga del agente 3" };
const PACIENTE = { nombres: "Valeria", apellido1: "Mendoza", apellido2: "Ruiz" };
const DIAGNOSTICO = "Faringoamigdalitis aguda de prueba";

let fallos = 0;
function comprobar(condicion, mensaje) {
  if (condicion) console.log(`  ok  ${mensaje}`);
  else {
    fallos += 1;
    console.error(`  FALLA  ${mensaje}`);
  }
}

function totp(secreto) {
  const alfabeto = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let valor = 0;
  const bytes = [];
  for (const c of secreto) {
    valor = (valor << 5) | alfabeto.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac("sha1", Buffer.from(bytes)).update(contador).digest();
  const d = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(d) & 0x7fffffff) % 1000000).padStart(6, "0");
}

function logoPng() {
  // PNG real de 120x60: bloque azul con franja durazno.
  const ancho = 120;
  const alto = 60;
  const crudo = Buffer.alloc((ancho * 3 + 1) * alto);
  for (let y = 0; y < alto; y++) {
    const fila = y * (ancho * 3 + 1);
    crudo[fila] = 0;
    for (let x = 0; x < ancho; x++) {
      const i = fila + 1 + x * 3;
      const franja = y > 40;
      crudo[i] = franja ? 0xf5 : 0x44;
      crudo[i + 1] = franja ? 0xa5 : 0x7d;
      crudo[i + 2] = franja ? 0x87 : 0xc0;
    }
  }
  const tabla = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = tabla[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const bloque = (tipo, datos) => {
    const t = Buffer.from(tipo);
    const l = Buffer.alloc(4);
    l.writeUInt32BE(datos.length);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(Buffer.concat([t, datos])));
    return Buffer.concat([l, t, datos, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ancho, 0);
  ihdr.writeUInt32BE(alto, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), bloque("IHDR", ihdr), bloque("IDAT", deflateSync(crudo)), bloque("IEND", Buffer.alloc(0))]);
}

const navegador = await chromium.launch();
const errores = [];

async function nuevaPagina(opciones = {}) {
  const contexto = await navegador.newContext({ viewport: { width: 1280, height: 900 }, ...opciones });
  const pagina = await contexto.newPage();
  pagina.on("console", (m) => {
    if (m.type() === "error" && !/status of 4\d\d/.test(m.text())) errores.push(m.text());
  });
  pagina.on("pageerror", (e) => errores.push(e.message));
  return pagina;
}

async function comprar(pagina, datos, plan) {
  await pagina.goto(`${BASE}/`);
  await pagina.click(`[data-comprar="${plan}"]`);
  await pagina.fill("#compra-consultorio", datos.consultorio);
  await pagina.fill("#compra-nombre", datos.nombre);
  await pagina.fill("#compra-correo", datos.correo);
  await pagina.check("#compra-terminos");
  await pagina.click('#f-compra button[type="submit"]');
  await pagina.waitForURL(/simulador-pago/);
  await pagina.click("#b-simular-tarjeta");
  await pagina.waitForURL(/pago-exitoso/);
  await pagina.waitForSelector("#b-activar");
  await pagina.click("#b-activar");
  await pagina.waitForSelector("#activar-contrasena");
  await pagina.fill("#activar-contrasena", datos.contrasena);
  await pagina.fill("#activar-confirmacion", datos.contrasena);
  await pagina.click('#f-activar button[type="submit"]');
  await pagina.waitForSelector("#codigo-recuperacion");
  const codigo = await pagina.textContent("#codigo-recuperacion");
  await pagina.fill("#confirmar-codigo", codigo.split("-").at(-1));
  return codigo;
}

try {
  console.log("Instalación del panel de soporte");
  const paginaSoporte = await nuevaPagina();
  await paginaSoporte.goto(`${BASE}/soporte.html#instalar`);
  await paginaSoporte.fill("#instalar-token", "token-local");
  await paginaSoporte.fill("#instalar-nombre", "Agente Prueba");
  await paginaSoporte.fill("#instalar-correo", SOPORTE.correo);
  await paginaSoporte.fill("#instalar-contrasena", SOPORTE.contrasena);
  await paginaSoporte.click('#f-instalar button[type="submit"]');
  await paginaSoporte.waitForSelector("#totp-secreto");
  const secreto = await paginaSoporte.textContent("#totp-secreto");
  comprobar(secreto.length >= 16, "se generó el secreto del segundo factor");

  console.log("Página de venta");
  const pagina = await nuevaPagina();
  await pagina.goto(`${BASE}/`);
  await pagina.screenshot({ path: join(SALIDA, "01-venta.png"), fullPage: true });
  await pagina.click("#pestana-soporte");
  await pagina.locator(".miradas").screenshot({ path: join(SALIDA, "02-venta-soporte.png") });
  comprobar(await pagina.isVisible("#mirada-soporte"), "las pestañas del ejemplo funcionan");
  await pagina.click("#ciclo-anual");
  comprobar((await pagina.textContent('[data-precio="esencial"]')).includes("3,490"), "el precio anual se actualiza");

  console.log("Compra, pago y activación");
  await comprar(pagina, { ...DOCTORA, nombre: "Dra. Paula Sol" }, "profesional");
  await pagina.locator("#f-confirmar-codigo").screenshot({ path: join(SALIDA, "03-codigo.png") });
  await pagina.click('#f-confirmar-codigo button[type="submit"]');
  await pagina.waitForSelector("text=Todavía no tienes pacientes");
  comprobar(true, "el médico entra al pagar y activar, sin intervención manual");

  console.log("Marca del consultorio");
  await pagina.click('a[href="#ajustes-marca"]');
  await pagina.waitForSelector("#marca-logo");
  const rutaLogo = join(SALIDA, "logo-prueba.png");
  writeFileSync(rutaLogo, logoPng());
  await pagina.setInputFiles("#marca-logo", rutaLogo);
  await pagina.waitForSelector("#vista-previa img");
  await pagina.fill("#marca-medico", "Dra. Paula Sol Méndez");
  await pagina.fill("#marca-especialidad", "Pediatría y neonatología");
  await pagina.fill("#marca-cedulas", "1234567 / 7654321");
  await pagina.fill("#marca-institucion", "Universidad de ejemplo");
  await pagina.fill("#marca-domicilio", "Av. Ejemplo 100, Culiacán, Sinaloa");
  await pagina.fill("#marca-telefono", "667 000 0000");
  await pagina.evaluate(() => {
    const c = document.querySelector("#marca-color");
    c.value = "#2f7f79";
    c.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await pagina.click('#f-marca button[type="submit"]');
  await pagina.waitForSelector('.barra img[alt^="Logo"]');
  comprobar(true, "el logo subido aparece en la barra del consultorio");
  await pagina.screenshot({ path: join(SALIDA, "04-marca.png"), fullPage: true });

  console.log("Paciente, nota y receta");
  await pagina.click('nav a[href="#pacientes"]');
  await pagina.click('a[href="#ficha/nueva"]');
  await pagina.fill("#ficha-nombres", PACIENTE.nombres);
  await pagina.fill("#ficha-apellido1", PACIENTE.apellido1);
  await pagina.fill("#ficha-apellido2", PACIENTE.apellido2);
  await pagina.fill("#ficha-nacimiento", "2024-08-01");
  await pagina.selectOption("#ficha-sexo", "F");
  await pagina.fill("#ficha-semanas", "34");
  await pagina.fill("#ficha-alergias", "Penicilina <script>window.__xss=1</script>");
  await pagina.click('#f-ficha button[type="submit"]');
  await pagina.waitForSelector("text=Aún no hay notas");
  comprobar((await pagina.evaluate(() => window.__xss)) === undefined, "el texto capturado no puede ejecutar código");
  comprobar((await pagina.textContent(".aviso")).includes("<script>"), "las alergias se muestran como texto");

  await pagina.click('a[href^="#nueva-nota/"]');
  await pagina.fill("#nota-motivo", "Tos y fiebre de dos días");
  await pagina.fill("#nota-evolucion", "Inicia hace 48 horas con fiebre de hasta 38.5 °C.");
  await pagina.fill("#nota-peso", "12.4");
  await pagina.fill("#nota-talla", "88");
  await pagina.fill("#nota-pc", "47.5");
  await pagina.fill("#nota-temperatura", "38.1");
  await pagina.fill("#nota-exploracion", "Faringe hiperémica, sin datos de dificultad respiratoria.");
  await pagina.fill("#nota-diagnosticos", DIAGNOSTICO);
  await pagina.fill("#nota-plan", "Líquidos abundantes y vigilar signos de alarma.");
  await pagina.fill("#med-nombre-0", "Paracetamol");
  await pagina.fill("#med-presentacion-0", "suspensión 160 mg/5 ml");
  await pagina.fill("#med-dosis-0", "5.5 ml");
  await pagina.fill("#med-via-0", "oral");
  await pagina.fill("#med-frecuencia-0", "cada 6 horas si hay fiebre");
  await pagina.fill("#med-duracion-0", "3 días");
  await pagina.screenshot({ path: join(SALIDA, "05-nota.png"), fullPage: true });
  await pagina.click('#f-nota button[type="submit"]');
  await pagina.waitForSelector(`text=${DIAGNOSTICO}`);
  comprobar(true, "la nota se guarda y se vuelve a leer descifrada");

  await pagina.click('[data-accion="ver-receta"]');
  await pagina.waitForSelector(".hoja");
  await pagina.locator(".hoja").screenshot({ path: join(SALIDA, "06-receta.png") });
  const textoHoja = await pagina.textContent(".hoja");
  comprobar(textoHoja.includes("Dra. Paula Sol Méndez") && textoHoja.includes("Paracetamol"), "la receta lleva los datos del médico y el medicamento");
  comprobar(await pagina.isVisible(".hoja img"), "la receta lleva el logo del consultorio");
  await pagina.screenshot({ path: join(SALIDA, "07-expediente.png"), fullPage: true });

  console.log("Curvas de crecimiento");
  const url = pagina.url();
  const pacienteId = /paciente\/([0-9a-f-]+)/.exec(url)[1];
  await pagina.click(`a[href="#paciente/${pacienteId}/crecimiento"]`);
  await pagina.waitForSelector(".curva svg circle");
  comprobar(true, "la curva dibuja las medidas de la paciente");
  await pagina.locator("#zona-paciente").screenshot({ path: join(SALIDA, "08-curva.png") });

  console.log("Enlace para la familia");
  await pagina.click(`a[href="#paciente/${pacienteId}/notas"]`);
  await pagina.click('[data-accion="enlace-familia"]');
  await pagina.click('#f-familia button[type="submit"]');
  await pagina.waitForSelector("#familia-enlace");
  const enlace = await pagina.inputValue("#familia-enlace");
  comprobar(enlace.includes("#"), "la llave del enlace va después del #");
  const familia = await nuevaPagina({ viewport: { width: 400, height: 800 } });
  const peticiones = [];
  familia.on("request", (r) => peticiones.push(r.url()));
  await familia.goto(enlace);
  await familia.waitForSelector(".hoja");
  comprobar((await familia.textContent(".hoja")).includes("Paracetamol"), "la familia abre la receta sin cuenta");
  const llaveEnlace = enlace.split(".").at(-1);
  comprobar(!peticiones.some((u) => u.includes(llaveEnlace) && new URL(u).hash === ""), "la llave nunca viaja al servidor");
  await familia.screenshot({ path: join(SALIDA, "09-familia-telefono.png"), fullPage: true });
  await familia.context().close();
  await pagina.click('[data-accion="cerrar-dialogo"]');

  console.log("Usuarios y roles");
  await pagina.click('a[href="#ajustes-marca"]');
  await pagina.click('a[href="#ajustes-usuarios"]');
  await pagina.fill("#usuario-nombre", "Ana Asistente");
  await pagina.fill("#usuario-correo", `ana.${sufijo}@ejemplo.test`);
  await pagina.selectOption("#usuario-rol", "asistente");
  await pagina.click('#f-usuario button[type="submit"]');
  await pagina.waitForSelector("#contrasena-temporal");
  const temporal = await pagina.textContent("#contrasena-temporal");
  await pagina.screenshot({ path: join(SALIDA, "10-usuarios.png"), fullPage: true });

  const asistente = await nuevaPagina();
  await asistente.goto(`${BASE}/app.html`);
  await asistente.fill("#entrar-correo", `ana.${sufijo}@ejemplo.test`);
  await asistente.fill("#entrar-contrasena", temporal);
  await asistente.click('#f-entrar button[type="submit"]');
  await asistente.waitForSelector("#cambiar-nueva");
  comprobar(true, "el usuario nuevo debe cambiar su contraseña temporal");
  await asistente.fill("#cambiar-actual", temporal);
  await asistente.fill("#cambiar-nueva", "frase propia de la asistente 4");
  await asistente.fill("#cambiar-confirmacion", "frase propia de la asistente 4");
  await asistente.click('#f-cambiar button[type="submit"]');
  await asistente.waitForSelector("text=Valeria Mendoza Ruiz");
  comprobar(true, "el usuario adicional abre los datos del mismo consultorio con su propia contraseña");
  await asistente.click("text=Valeria Mendoza Ruiz");
  await asistente.waitForSelector("text=Las notas clínicas solo las consultan médicos");
  comprobar(!(await asistente.content()).includes(DIAGNOSTICO), "la asistente no ve el diagnóstico");
  comprobar((await asistente.locator('a[href^="#ajustes"]').count()) === 0, "la asistente no ve ajustes");
  await asistente.context().close();

  console.log("Aislamiento entre consultorios");
  const otro = await nuevaPagina();
  await comprar(otro, { ...OTRO, nombre: "Dr. Luis Luna" }, "esencial");
  await otro.click('#f-confirmar-codigo button[type="submit"]');
  await otro.waitForSelector("text=Todavía no tienes pacientes");
  comprobar(!(await otro.content()).includes("Valeria"), "otro consultorio no ve a la paciente");
  const directo = await otro.evaluate(async (id) => (await fetch(`/api/pacientes/${id}/registros`)).status, pacienteId);
  comprobar(directo === 404, "pedir el expediente directamente al servidor responde 404");
  comprobar((await otro.locator('a[href="#paciente/x/crecimiento"]').count()) === 0, "el plan Esencial no muestra curvas");
  await otro.context().close();

  console.log("Panel de soporte");
  await paginaSoporte.goto(`${BASE}/soporte.html`);
  await paginaSoporte.fill("#soporte-correo", SOPORTE.correo);
  await paginaSoporte.fill("#soporte-contrasena", SOPORTE.contrasena);
  await paginaSoporte.fill("#soporte-totp", totp(secreto));
  await paginaSoporte.click('#f-soporte button[type="submit"]');
  await paginaSoporte.waitForSelector("#buscar-consultorio");
  await paginaSoporte.screenshot({ path: join(SALIDA, "11-soporte-consultorios.png"), fullPage: true });
  await paginaSoporte.fill("#buscar-consultorio", DOCTORA.consultorio);
  await paginaSoporte.waitForFunction((n) => document.querySelectorAll("#cuerpo-consultorios tr").length === 1 && document.querySelector("#cuerpo-consultorios").textContent.includes(n), DOCTORA.consultorio);
  await paginaSoporte.click('[data-accion="abrir"]');
  await paginaSoporte.fill("#soporte-motivo", "Ticket 77: la doctora no encuentra a una paciente");
  await paginaSoporte.click('#f-motivo button[type="submit"]');
  await paginaSoporte.waitForSelector("#cuerpo-lista");
  const tablaSoporte = await paginaSoporte.textContent("main");
  comprobar(tablaSoporte.includes("Valeria Mendoza Ruiz"), "soporte ve el nombre de la paciente");
  const encabezados = await paginaSoporte.locator("main th").allTextContents();
  comprobar(JSON.stringify(encabezados) === JSON.stringify(["Paciente", "Última consulta", "Última receta"]), "soporte solo tiene esas tres columnas");
  comprobar(!tablaSoporte.includes(DIAGNOSTICO) && !tablaSoporte.includes("Paracetamol") && !tablaSoporte.includes("Penicilina"), "soporte no ve diagnóstico, medicamentos ni alergias");
  await paginaSoporte.screenshot({ path: join(SALIDA, "12-soporte-pacientes.png"), fullPage: true });
  const intentoNotas = await paginaSoporte.evaluate(async (id) => (await fetch(`/api/pacientes/${id}/registros`)).status, pacienteId);
  comprobar(intentoNotas === 401, "la sesión de soporte no sirve para pedir notas");

  console.log("Bitácora del titular");
  await pagina.click('a[href="#ajustes-bitacora"]');
  await pagina.waitForSelector("text=Ticket 77");
  comprobar(true, "la doctora ve el acceso de soporte y su motivo");
  await pagina.screenshot({ path: join(SALIDA, "13-bitacora.png"), fullPage: true });

  console.log("Bloqueo: la llave solo vive en memoria");
  await pagina.reload();
  await pagina.waitForSelector("#desbloquear-contrasena");
  comprobar(true, "al recargar, la llave desaparece y se pide la contraseña");
  await pagina.fill("#desbloquear-contrasena", "contraseña equivocada");
  await pagina.click('#f-desbloquear button[type="submit"]');
  await pagina.waitForSelector("text=Esa contraseña no coincide");
  await pagina.fill("#desbloquear-contrasena", DOCTORA.contrasena);
  await pagina.click('#f-desbloquear button[type="submit"]');
  await pagina.waitForSelector("text=Plan Profesional, mensual, text=Accesos del equipo de soporte", { timeout: 10000 }).catch(() => {});
  comprobar(!(await pagina.isVisible("#desbloquear-contrasena")), "con la contraseña correcta se desbloquea");

  console.log("Lista de fundadores");
  const correoLista = `lista.${sufijo}@ejemplo.test`;
  const lista = await nuevaPagina();
  await lista.goto(`${BASE}/fundadores.html?o=congreso-prueba`);
  await lista.screenshot({ path: join(SALIDA, "15-fundadores.png"), fullPage: true });
  await lista.fill("#fundador-nombre", "Dra. Lista de Prueba");
  await lista.fill("#fundador-correo", correoLista);
  await lista.selectOption("#fundador-especialidad", "Neonatología");
  await lista.fill("#fundador-ciudad", "Culiacán");
  await lista.check("#fundador-aviso");
  await lista.click('#f-fundadores button[type="submit"]');
  await lista.waitForSelector("text=Tu lugar quedó apartado");
  comprobar((await lista.textContent('[role="status"]')).includes(correoLista), "la lista confirma con el correo de la persona");
  await lista.screenshot({ path: join(SALIDA, "16-fundadores-listo.png"), fullPage: true });
  await lista.context().close();
  await paginaSoporte.click('[data-ir="metricas"]');
  await paginaSoporte.waitForSelector("text=Lista de fundadores");
  const metricas = await paginaSoporte.textContent("main");
  comprobar(metricas.includes(correoLista) && metricas.includes("congreso-prueba"), "el administrador de soporte ve el registro y de dónde llegó");
  await paginaSoporte.screenshot({ path: join(SALIDA, "17-soporte-metricas.png"), fullPage: true });

  console.log("Teléfono y modo oscuro");
  const telefono = await nuevaPagina({ viewport: { width: 400, height: 800 }, colorScheme: "dark" });
  await telefono.goto(`${BASE}/`);
  const desborde = await telefono.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  comprobar(!desborde, "la página de venta no se desborda en un teléfono");
  await telefono.screenshot({ path: join(SALIDA, "14-venta-telefono-oscuro.png"), fullPage: true });
  await telefono.goto(`${BASE}/fundadores.html`);
  const desbordeLista = await telefono.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  comprobar(!desbordeLista, "la lista de fundadores no se desborda en un teléfono");
  await telefono.screenshot({ path: join(SALIDA, "18-fundadores-telefono-oscuro.png"), fullPage: true });
  await telefono.context().close();

  comprobar(errores.length === 0, `sin errores en consola${errores.length ? `: ${errores.join(" | ")}` : ""}`);
} catch (error) {
  fallos += 1;
  console.error("ERROR:", error.message);
} finally {
  await navegador.close();
}

console.log(fallos ? `\n${fallos} comprobaciones fallaron` : "\nTodas las comprobaciones pasaron");
process.exit(fallos ? 1 : 0);
