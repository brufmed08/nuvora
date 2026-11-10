// Panel de soporte. Por diseño solo puede mostrar el nombre del paciente, su última consulta y su última receta.
// Los nombres se abren aquí, en el navegador del agente; el servidor no puede leerlos.
import { api, ErrorApi, esDemo } from "./api.js";
import * as cripto from "./cripto.js";
import { contrasenaTemporal, datosDeFormulario, fecha, fechaHora, h, pesos, pintar, validarContrasena } from "./util.js";

const ESTADOS = { activo: "Activo", gracia: "En gracia", solo_lectura: "Solo lectura", cancelado: "Cancelado", pendiente_activacion: "Por activar" };

const estado = { raiz: null, usuario: null, privada: null, privadaBytes: null };

function pantalla(titulo, contenido) {
  return h`<div class="centro-pantalla"><div class="angosto pila" style="width:100%">
    <div class="fila"><img class="logo" src="/img/nuvora-logo.png" alt="NUVORA Health" height="54"><strong style="font-size:18px">Soporte</strong></div>
    <div class="superficie pila"><h1>${titulo}</h1>${contenido}</div>
  </div></div>`;
}

function marco(contenido) {
  return h`<header class="barra">
    <div class="marca-consultorio"><img class="logo-icono" src="/img/nuvora-icono.png" alt=""><span>Soporte</span></div>
    <nav aria-label="Principal">
      <a href="#" data-ir="consultorios">Consultorios</a>
      ${estado.usuario.rol === "administrador" ? h`<a href="#" data-ir="pruebas">Pruebas gratis</a><a href="#" data-ir="metricas">Métricas</a><a href="#" data-ir="agentes">Agentes</a>` : ""}
      <span class="tenue chico" style="padding:6px 10px">${estado.usuario.nombre}</span>
      <button class="boton discreto" data-accion="salir">Salir</button>
    </nav>
  </header><main class="contenido">${contenido}</main>`;
}

function alEnviar(selector, trabajo) {
  const formulario = estado.raiz.querySelector(selector);
  if (!formulario) return;
  formulario.addEventListener("submit", async (e) => {
    e.preventDefault();
    const boton = formulario.querySelector('button[type="submit"]');
    const zona = formulario.querySelector("[data-error]");
    if (zona) zona.textContent = "";
    if (boton) boton.disabled = true;
    try {
      await trabajo(datosDeFormulario(formulario));
    } catch (error) {
      if (zona) zona.textContent = error.message;
    } finally {
      if (boton) boton.disabled = false;
    }
  });
}

function vistaEntrar(aviso) {
  pintar(
    estado.raiz,
    pantalla(
      "Entrar a soporte",
      h`${aviso ? h`<p class="aviso">${aviso}</p>` : ""}
      <form id="f-soporte" class="pila">
        <label class="campo">Correo<input id="soporte-correo" name="email" type="email" autocomplete="username" required></label>
        <label class="campo">Contraseña<input id="soporte-contrasena" name="contrasena" type="password" autocomplete="current-password" required></label>
        <label class="campo">Código de tu app autenticadora<input id="soporte-totp" name="totp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label>
        <p class="error" data-error role="alert"></p>
        <button class="boton" type="submit">Entrar</button>
      </form>`,
    ),
  );
  alEnviar("#f-soporte", async ({ email, contrasena, totp }) => {
    const p = await api("POST", "/api/soporte/parametros", { email });
    const d = await cripto.derivarDeContrasena(contrasena, p.kdf_sal, p.kdf_iter);
    const r = await api("POST", "/api/soporte/entrar", { email, auth_key: d.authKey, totp });
    estado.usuario = r.usuario;
    estado.privadaBytes = await cripto.abrirPrivadaSoporte(r.llave_envuelta, d.llaveEnvoltura);
    estado.privada = await cripto.importarPrivadaSoporte(estado.privadaBytes);
    estado.kdf = { sal: r.kdf_sal, iter: r.kdf_iter };
    if (r.usuario.debe_cambiar) vistaCambiar();
    else await vistaInicial();
  });
}

function vistaInstalar() {
  pintar(
    estado.raiz,
    pantalla(
      "Instalar el panel de soporte",
      h`<p class="tenue">Solo se hace una vez, antes de abrir inscripciones. Tu navegador genera la llave con la que se sellan los nombres.</p>
      <form id="f-instalar" class="pila">
        <label class="campo">Token de instalación<input id="instalar-token" name="token" type="password" required></label>
        <label class="campo">Tu nombre<input id="instalar-nombre" name="nombre" required></label>
        <label class="campo">Correo<input id="instalar-correo" name="email" type="email" required></label>
        <label class="campo">Contraseña, al menos 12 caracteres<input id="instalar-contrasena" name="contrasena" type="password" autocomplete="new-password" required minlength="12"></label>
        <p class="error" data-error role="alert"></p>
        <button class="boton" type="submit">Instalar</button>
      </form>`,
    ),
  );
  alEnviar("#f-instalar", async ({ token, nombre, email, contrasena }) => {
    const problema = validarContrasena(contrasena);
    if (problema) throw new Error(problema);
    const par = await cripto.nuevoParSoporte();
    const sal = cripto.nuevaSal();
    const d = await cripto.derivarDeContrasena(contrasena, sal);
    const r = await api("POST", "/api/soporte/instalar", {
      token,
      nombre,
      email,
      kdf_sal: sal,
      kdf_iter: cripto.ITERACIONES,
      auth_key: d.authKey,
      llave_publica: par.publica,
      llave_envuelta: await cripto.envolverPrivadaSoporte(par.privadaBytes, d.llaveEnvoltura),
    });
    pintar(
      estado.raiz,
      pantalla(
        "Configura tu segundo factor",
        h`<p>Agrega este secreto a tu app autenticadora. Solo se muestra una vez.</p>
        <div class="codigo-recuperacion" id="totp-secreto">${r.totp_secreto}</div>
        <p class="aviso">Si pierdes esta contraseña, nadie podrá volver a abrir los nombres sellados. Crea un segundo administrador pronto.</p>
        <a class="boton" href="/soporte.html">Ya lo guardé, entrar</a>`,
      ),
    );
  });
}

function vistaCambiar() {
  pintar(
    estado.raiz,
    pantalla(
      "Crea tu contraseña",
      h`<form id="f-cambiar-soporte" class="pila">
        <label class="campo">Contraseña temporal<input name="actual" type="password" required></label>
        <label class="campo">Contraseña nueva, al menos 12 caracteres<input name="nueva" type="password" autocomplete="new-password" required minlength="12"></label>
        <p class="error" data-error role="alert"></p>
        <button class="boton" type="submit">Guardar</button>
      </form>`,
    ),
  );
  alEnviar("#f-cambiar-soporte", async ({ actual, nueva }) => {
    const problema = validarContrasena(nueva);
    if (problema) throw new Error(problema);
    const anterior = await cripto.derivarDeContrasena(actual, estado.kdf.sal, estado.kdf.iter);
    const sal = cripto.nuevaSal();
    const d = await cripto.derivarDeContrasena(nueva, sal);
    await api("POST", "/api/soporte/cambiar", { auth_key_actual: anterior.authKey, kdf_sal: sal, kdf_iter: cripto.ITERACIONES, auth_key: d.authKey, llave_envuelta: await cripto.envolverPrivadaSoporte(estado.privadaBytes, d.llaveEnvoltura) });
    estado.usuario.debe_cambiar = false;
    estado.kdf = { sal, iter: cripto.ITERACIONES };
    await vistaInicial();
  });
}

function filasConsultorios(lista) {
  if (!lista.length) return h`<tr><td colspan="6" class="tenue">Ningún consultorio coincide.</td></tr>`;
  return lista.map(
    (c) => h`<tr>
      <td><strong>${c.nombre}</strong><br><span class="tenue chico">${c.contacto_email}</span></td>
      <td>${c.plan_nombre}, ${c.ciclo}</td>
      <td><span class="insignia ${c.estado === "activo" ? "ok" : c.estado === "gracia" || c.estado === "solo_lectura" ? "alerta" : ""}">${ESTADOS[c.estado]}</span>${c.en_prueba ? h` <span class="insignia">Prueba gratis</span>` : ""}</td>
      <td>${fecha(c.pagado_hasta)}</td>
      <td>${c.n_pacientes}</td>
      <td><button class="boton secundario" data-accion="abrir" data-id="${c.id}" data-nombre="${c.nombre}">Ver pacientes</button></td>
    </tr>`,
  );
}

async function vistaConsultorios() {
  const { consultorios } = await api("GET", "/api/soporte/consultorios?q=");
  pintar(
    estado.raiz,
    marco(h`<h1>Consultorios</h1>
      <label class="campo">Buscar por nombre o correo<input id="buscar-consultorio" type="search" autocomplete="off"></label>
      <div class="superficie desborde" style="padding:0"><table>
        <thead><tr><th>Consultorio</th><th>Plan</th><th>Estado</th><th>Pagado hasta</th><th>Pacientes</th><th></th></tr></thead>
        <tbody id="cuerpo-consultorios">${filasConsultorios(consultorios)}</tbody>
      </table></div>`),
  );
  let espera;
  estado.raiz.querySelector("#buscar-consultorio").addEventListener("input", (e) => {
    clearTimeout(espera);
    espera = setTimeout(async () => {
      const r = await api("GET", `/api/soporte/consultorios?q=${encodeURIComponent(e.target.value)}`);
      pintar(estado.raiz.querySelector("#cuerpo-consultorios"), filasConsultorios(r.consultorios));
    }, 250);
  });
}

function vistaMotivo(id, nombre) {
  pintar(
    estado.raiz,
    marco(h`<h1>${nombre}</h1>
      <form id="f-motivo" class="superficie pila angosto">
        <p>Antes de ver la lista de pacientes, escribe el motivo. El médico titular lo verá en su bitácora, con tu nombre y la hora.</p>
        <label class="campo">Motivo y número de ticket<input id="soporte-motivo" name="motivo" required minlength="5" maxlength="300"></label>
        <p class="error" data-error role="alert"></p>
        <div class="fila"><button class="boton" type="submit">Ver pacientes</button><a class="boton secundario" href="#" data-ir="consultorios">Cancelar</a></div>
      </form>`),
  );
  alEnviar("#f-motivo", async ({ motivo }) => {
    const { pacientes } = await api("POST", `/api/soporte/consultorios/${id}/pacientes`, { motivo });
    const abiertos = [];
    for (const p of pacientes) {
      let nombrePaciente = "Sin nombre sellado";
      if (p.nombre_sellado) {
        try {
          nombrePaciente = await cripto.abrirSello(estado.privada, p.nombre_sellado);
        } catch {
          nombrePaciente = "No se pudo abrir";
        }
      }
      abiertos.push({ ...p, nombre: nombrePaciente });
    }
    abiertos.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
    const filas = (lista) =>
      lista.length
        ? lista.map((p) => h`<tr><td>${p.nombre}</td><td>${fechaHora(p.ultima_consulta_en) || "Sin consultas"}</td><td>${fechaHora(p.ultima_receta_en) || "Sin recetas"}</td></tr>`)
        : h`<tr><td colspan="3" class="tenue">Sin pacientes.</td></tr>`;
    pintar(
      estado.raiz,
      marco(h`<div class="fila-entre"><h1>${nombre}</h1><a class="boton secundario" href="#" data-ir="consultorios">Volver</a></div>
        <p class="tenue">Esto es todo lo que soporte puede ver. Tu acceso quedó registrado en la bitácora del consultorio.</p>
        <label class="campo">Buscar paciente<input id="buscar-en-lista" type="search" autocomplete="off"></label>
        <div class="superficie desborde" style="padding:0"><table>
          <thead><tr><th>Paciente</th><th>Última consulta</th><th>Última receta</th></tr></thead>
          <tbody id="cuerpo-lista">${filas(abiertos)}</tbody>
        </table></div>`),
    );
    estado.raiz.querySelector("#buscar-en-lista").addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      pintar(estado.raiz.querySelector("#cuerpo-lista"), filas(abiertos.filter((p) => p.nombre.toLowerCase().includes(q))));
    });
  });
}

async function vistaMetricas() {
  const [m, lista] = await Promise.all([api("GET", "/api/soporte/metricas"), api("GET", "/api/soporte/fundadores")]);
  pintar(
    estado.raiz,
    marco(h`<h1>Métricas</h1>
      <div class="superficie pila">
        <div class="rejilla">
          <div><div class="tenue chico">Consultorios activos</div><strong style="font-size:24px">${m.activos}</strong></div>
          <div><div class="tenue chico">Ingreso mensual recurrente, con IVA</div><strong style="font-size:24px">${pesos(m.ingreso_mensual_recurrente_centavos)}</strong></div>
          <div><div class="tenue chico">Consultorios en total</div><strong style="font-size:24px">${m.total}</strong></div>
        </div>
      </div>
      <div class="superficie desborde" style="padding:0"><table><thead><tr><th>Mes</th><th>Pagos</th><th>Cobrado, con IVA</th></tr></thead><tbody>
        ${m.pagos.map((p) => h`<tr><td>${p.mes}</td><td>${p.pagos}</td><td>${pesos(Number(p.centavos))}</td></tr>`)}
      </tbody></table></div>
      <h2>Altas por origen</h2>
      <div class="superficie desborde" style="padding:0"><table><thead><tr><th>Origen</th><th>Altas pagadas</th></tr></thead><tbody>
        ${m.altas_por_origen.length ? m.altas_por_origen.map((o) => h`<tr><td>${o.origen === "sin_dato" ? "Sin dato" : o.origen}</td><td>${o.altas}</td></tr>`) : h`<tr><td colspan="2" class="tenue">Todavía no hay altas pagadas.</td></tr>`}
      </tbody></table></div>
      <h2>Lista de fundadores: ${m.fundadores}</h2>
      <div class="superficie desborde" style="padding:0"><table><thead><tr><th>Nombre</th><th>Correo</th><th>Especialidad</th><th>Ciudad</th><th>Origen</th><th>Fecha</th></tr></thead><tbody>
        ${lista.fundadores.length ? lista.fundadores.map((f) => h`<tr><td>${f.nombre}</td><td>${f.email}</td><td>${f.especialidad ?? ""}</td><td>${f.ciudad ?? ""}</td><td>${f.origen ?? ""}</td><td>${new Date(f.creado_en).toLocaleDateString("es-MX")}</td></tr>`) : h`<tr><td colspan="6" class="tenue">Todavía no se apunta nadie.</td></tr>`}
      </tbody></table></div>`),
  );
}

function vistaAgentes() {
  pintar(
    estado.raiz,
    marco(h`<h1>Agregar agente</h1>
      <form id="f-agente" class="superficie pila angosto">
        <label class="campo">Nombre<input name="nombre" required></label>
        <label class="campo">Correo<input name="email" type="email" required></label>
        <p class="error" data-error role="alert"></p>
        <div><button class="boton" type="submit">Crear agente</button></div>
      </form><div id="zona-agente"></div>`),
  );
  alEnviar("#f-agente", async ({ nombre, email }) => {
    const temporal = contrasenaTemporal();
    const sal = cripto.nuevaSal();
    const d = await cripto.derivarDeContrasena(temporal, sal);
    const r = await api("POST", "/api/soporte/usuarios", { nombre, email, kdf_sal: sal, kdf_iter: cripto.ITERACIONES, auth_key: d.authKey, llave_envuelta: await cripto.envolverPrivadaSoporte(estado.privadaBytes, d.llaveEnvoltura) });
    pintar(
      estado.raiz.querySelector("#zona-agente"),
      h`<div class="aviso pila-chica"><strong>Entrégale esto en persona. Solo se muestra una vez.</strong>
        <span>Contraseña temporal: <code>${temporal}</code></span>
        <span>Secreto para su app autenticadora: <code>${r.totp_secreto}</code></span></div>`,
    );
  });
}


// ---------------------------------------------------------------------------
// Pruebas gratis de 3 meses: solo la cuenta maestra (administrador) genera códigos y autoriza.
// ---------------------------------------------------------------------------

const PLANES_PRUEBA = { esencial: "Esencial", profesional: "Profesional", clinica: "Clínica" };
const ESTADOS_PRUEBA = { pendiente: "Por autorizar", aprobada: "Autorizada", rechazada: "Rechazada" };
const AVISOS = { enviado: "WhatsApp enviado", fallido: "WhatsApp falló", sin_configurar: "WhatsApp sin configurar" };

async function vistaInicial() {
  if (estado.usuario.rol === "administrador" && location.hash === "#pruebas") return vistaPruebas();
  return vistaConsultorios();
}

const enlacePrueba = (codigo) => `${location.origin}/prueba.html?codigo=${encodeURIComponent(codigo)}`;

function filaSolicitud(s) {
  const pendiente = s.estado === "pendiente";
  return h`<div class="superficie pila-chica">
    <div class="fila-entre"><strong>${s.nombre_medico} · ${s.nombre_consultorio}</strong>
      <span class="insignia ${s.estado === "aprobada" ? "ok" : pendiente ? "alerta" : ""}">${ESTADOS_PRUEBA[s.estado]}</span></div>
    <span class="tenue chico">${s.email} · ${s.telefono ?? ""}${s.especialidad ? ` · ${s.especialidad}` : ""}${s.ciudad ? ` · ${s.ciudad}` : ""}</span>
    <span class="tenue chico">Código ${s.codigo} · ${fechaHora(s.creado_en)}${s.aviso_whatsapp ? ` · ${AVISOS[s.aviso_whatsapp] ?? s.aviso_whatsapp}` : ""}</span>
    <p style="white-space:pre-wrap;margin:6px 0">${s.necesidades}</p>
    ${
      pendiente
        ? h`<div class="fila">
            <label class="campo" style="min-width:200px">Plan<select data-plan-de="${s.id}">
              ${Object.entries(PLANES_PRUEBA).map(([id, nombre]) => h`<option value="${id}" ${id === s.plan ? "selected" : ""}>${nombre}</option>`)}
            </select></label>
            <button class="boton" data-accion="prueba-aprobar" data-id="${s.id}">Autorizar 3 meses gratis</button>
            <button class="boton secundario" data-accion="prueba-rechazar" data-id="${s.id}">Rechazar</button>
          </div><div data-resultado="${s.id}"></div>`
        : h`<span class="chico">Plan ${PLANES_PRUEBA[s.plan]}${s.estado === "aprobada" && s.pagado_hasta ? `, gratis hasta el ${fecha(s.pagado_hasta)}` : ""}${s.nota_revision ? ` · ${s.nota_revision}` : ""}</span>`
    }
  </div>`;
}

async function vistaPruebas() {
  const [{ solicitudes }, { codigos }] = await Promise.all([
    api("GET", "/api/soporte/pruebas/solicitudes"),
    api("GET", "/api/soporte/pruebas/codigos"),
  ]);
  const pendientes = solicitudes.filter((s) => s.estado === "pendiente").length;
  pintar(
    estado.raiz,
    marco(h`<h1>Pruebas gratis de 3 meses</h1>
      <div class="superficie pila-chica">
        <span>Enlace de inscripción: <code>${location.origin}/prueba.html</code></span>
        <span class="tenue chico">Solo entra quien tenga un código tuyo. Cada solicitud te llega por WhatsApp y nadie recibe acceso hasta que la autorizas aquí.</span>
      </div>
      <h2>Solicitudes${pendientes ? ` (${pendientes} por autorizar)` : ""}</h2>
      ${solicitudes.length ? solicitudes.map(filaSolicitud) : h`<p class="tenue">Todavía no hay solicitudes.</p>`}
      <h2>Generar códigos</h2>
      <form id="f-codigos" class="superficie pila angosto">
        <div class="rejilla">
          <label class="campo">Cuántos códigos<input name="cantidad" type="number" min="1" max="50" value="1" required></label>
          <label class="campo">Usos por código<input name="usos_max" type="number" min="1" max="500" value="1" required></label>
          <label class="campo">Vence en días (opcional)<input name="dias_vigencia" type="number" min="1" max="365"></label>
        </div>
        <label class="campo">Nota (para quién es)<input name="nota" maxlength="160"></label>
        <p class="error" data-error role="alert"></p>
        <div><button class="boton" type="submit">Generar</button></div>
      </form>
      <div id="zona-codigos"></div>
      <h2>Códigos</h2>
      <div class="superficie desborde" style="padding:0"><table>
        <thead><tr><th>Código</th><th>Nota</th><th>Usos</th><th>Vence</th><th>Estado</th><th></th></tr></thead>
        <tbody>${
          codigos.length
            ? codigos.map((c) => {
                const vencido = c.expira_en && new Date(c.expira_en) < new Date();
                const vigente = !c.revocado_en && !vencido && c.usos < c.usos_max;
                return h`<tr>
                  <td><code>${c.codigo}</code></td><td>${c.nota ?? ""}</td><td>${c.usos} de ${c.usos_max}</td><td>${c.expira_en ? fecha(c.expira_en) : "Sin vencimiento"}</td>
                  <td>${c.revocado_en ? "Revocado" : vencido ? "Vencido" : c.usos >= c.usos_max ? "Agotado" : "Vigente"}</td>
                  <td class="fila">${vigente ? h`<button class="boton secundario" data-accion="prueba-copiar" data-codigo="${c.codigo}">Copiar enlace</button><button class="boton discreto" data-accion="prueba-revocar" data-id="${c.id}">Revocar</button>` : ""}</td>
                </tr>`;
              })
            : h`<tr><td colspan="6" class="tenue">Todavía no generas códigos.</td></tr>`
        }</tbody>
      </table></div>`),
  );
  alEnviar("#f-codigos", async ({ cantidad, usos_max, dias_vigencia, nota }) => {
    const r = await api("POST", "/api/soporte/pruebas/codigos", {
      cantidad: Number(cantidad),
      usos_max: Number(usos_max),
      dias_vigencia: dias_vigencia ? Number(dias_vigencia) : null,
      nota,
    });
    await vistaPruebas();
    pintar(
      estado.raiz.querySelector("#zona-codigos"),
      h`<div class="aviso pila-chica"><strong>Códigos nuevos. Compártelos con el enlace:</strong>
        ${r.codigos.map((c) => h`<span><code>${c}</code> · <code>${enlacePrueba(c)}</code></span>`)}</div>`,
    );
  });
}

async function accionPrueba(boton) {
  const id = boton.dataset.id;
  if (boton.dataset.accion === "prueba-copiar") {
    const enlace = enlacePrueba(boton.dataset.codigo);
    await navigator.clipboard?.writeText(enlace).catch(() => {});
    boton.textContent = "Copiado";
    return;
  }
  boton.disabled = true;
  try {
    if (boton.dataset.accion === "prueba-revocar") {
      if (!confirm("¿Revocar este código? Ya no se podrá usar.")) return;
      await api("POST", `/api/soporte/pruebas/codigos/${id}/revocar`, {});
      return vistaPruebas();
    }
    if (boton.dataset.accion === "prueba-rechazar") {
      const nota = prompt("Motivo del rechazo (opcional, solo lo ves tú):");
      if (nota === null) return;
      await api("POST", `/api/soporte/pruebas/solicitudes/${id}/rechazar`, { nota });
      return vistaPruebas();
    }
    if (boton.dataset.accion === "prueba-aprobar") {
      const plan = estado.raiz.querySelector(`[data-plan-de="${id}"]`)?.value;
      const r = await api("POST", `/api/soporte/pruebas/solicitudes/${id}/aprobar`, { plan });
      await vistaPruebas();
      pintar(
        estado.raiz.querySelector("#zona-codigos"),
        h`<div class="aviso pila-chica"><strong>Prueba autorizada hasta el ${fecha(r.pagado_hasta)}.</strong>
          <span>${r.correo_enviado ? "Le enviamos el enlace de activación por correo." : "No se pudo enviar el correo. Mándale tú este enlace de activación (vence en 14 días y solo funciona una vez):"}</span>
          ${r.enlace_activacion ? h`<code style="word-break:break-all">${r.enlace_activacion}</code>` : ""}</div>`,
      );
      estado.raiz.querySelector("#zona-codigos").scrollIntoView({ behavior: "smooth" });
    }
  } catch (error) {
    alert(error.message);
  } finally {
    boton.disabled = false;
  }
}

export async function iniciarSoporte(raiz) {
  estado.raiz = raiz;
  raiz.addEventListener("click", async (e) => {
    const destino = e.target.closest("[data-ir]");
    if (destino) {
      e.preventDefault();
      if (destino.dataset.ir === "consultorios") await vistaConsultorios();
      if (destino.dataset.ir === "metricas") await vistaMetricas();
      if (destino.dataset.ir === "pruebas") await vistaPruebas();
      if (destino.dataset.ir === "agentes") vistaAgentes();
      return;
    }
    const boton = e.target.closest("[data-accion]");
    if (!boton) return;
    if (boton.dataset.accion === "abrir") vistaMotivo(boton.dataset.id, boton.dataset.nombre);
    if (boton.dataset.accion?.startsWith("prueba-")) await accionPrueba(boton);
    if (boton.dataset.accion === "salir") {
      await api("POST", "/api/soporte/salir", {}).catch(() => {});
      estado.usuario = null;
      estado.privada = null;
      if (estado.privadaBytes) estado.privadaBytes.fill(0);
      estado.privadaBytes = null;
      vistaEntrar();
    }
  });
  if (!esDemo() && location.hash === "#instalar") return vistaInstalar();
  return vistaEntrar();
}

/** Solo para la demostración. */
export async function entrarSoporteDemo(raiz, usuario, privada) {
  if (estado.raiz !== raiz) await iniciarSoporte(raiz);
  estado.usuario = usuario;
  estado.privada = privada;
  return vistaConsultorios();
}
