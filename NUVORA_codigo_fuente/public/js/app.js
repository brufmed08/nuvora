// Expediente del consultorio. Todo lo clínico se cifra y descifra aquí, en el navegador.
import { api, ErrorApi, esDemo } from "./api.js";
import * as cripto from "./cripto.js";
import { OPCIONES_INDICADOR, dibujarCurva, medidasDesdeRegistros } from "./crecimiento.js";
import { hojaReceta } from "./receta.js";
import {
  coloresLegibles,
  contrasenaTemporal,
  crudo,
  datosDeFormulario,
  descargar,
  edadTexto,
  fecha,
  fechaHora,
  h,
  pesos,
  pintar,
  reducirImagen,
  validarContrasena,
} from "./util.js";

const MINUTOS_BLOQUEO = 15;
const ROLES = { titular: "Titular", medico: "Médico", asistente: "Asistente" };
const SEXOS = { F: "Femenino", M: "Masculino" };
const ESTADOS = { activo: "Activo", gracia: "Vencido, en periodo de gracia", solo_lectura: "Solo lectura", cancelado: "Cancelado", pendiente_activacion: "Por activar" };
const ACCIONES = {
  acceso: "Entró al sistema",
  cuenta_pagada: "Pago de alta confirmado",
  pago_renovacion: "Pago de renovación confirmado",
  contrasena_cambiada: "Cambió su contraseña",
  contrasena_recuperada: "Recuperó el acceso con el código",
  contrasena_restablecida: "Restableció la contraseña de un usuario",
  marca_actualizada: "Actualizó la marca del consultorio",
  usuario_creado: "Creó un usuario",
  usuario_desactivado: "Desactivó un usuario",
  usuario_reactivado: "Reactivó un usuario",
  codigo_recuperacion_renovado: "Renovó el código de recuperación",
  paciente_creado: "Registró un paciente",
  paciente_actualizado: "Actualizó una ficha",
  expediente_abierto: "Abrió un expediente",
  consulta_creada: "Registró una nota",
  receta_creada: "Emitió una receta",
  somatometria_creada: "Registró medidas",
  registro_anulado: "Anuló un registro",
  enlace_familia_creado: "Creó un enlace para la familia",
  enlace_familia_revocado: "Revocó un enlace para la familia",
};

const estado = {
  ruta: "",
  raiz: null,
  publica: null,
  sesion: null,
  tk: null,
  llave: null,
  pacientes: null,
  temporizador: null,
  actividad: Date.now(),
};

// ---------------------------------------------------------------------------
// Navegación
// ---------------------------------------------------------------------------

export function navegar(ruta) {
  if (esDemo()) {
    estado.ruta = ruta;
    renderizar();
    return;
  }
  if (location.hash.slice(1) === ruta) renderizar();
  else location.hash = ruta;
}

function rutaActual() {
  return esDemo() ? estado.ruta : location.hash.slice(1);
}

const llaveLista = () => !!estado.llave;

async function renderizar() {
  const ruta = rutaActual();
  const [nombre, ...resto] = ruta.split("/");
  const argumento = resto.join("/");
  window.scrollTo(0, 0);
  try {
    if (nombre === "activar") return await vistaActivar(argumento);
    if (nombre === "recuperar") return vistaRecuperar();
    if (nombre === "entrar") return vistaEntrar();
    if (!estado.sesion) {
      const hay = await cargarSesion();
      if (!hay) return vistaEntrar();
    }
    if (!llaveLista()) return vistaDesbloquear();
    if (estado.sesion.usuario.debe_cambiar) return vistaCambiarContrasena(true);
    aplicarMarca();
    switch (nombre) {
      case "paciente":
        return await vistaPaciente(argumento);
      case "nueva-nota":
        return await vistaNuevaNota(argumento);
      case "ficha":
        return await vistaFicha(argumento);
      case "cuenta-contrasena":
        return vistaCambiarContrasena(false);
      case "ajustes-marca":
        return vistaMarca();
      case "ajustes-usuarios":
        return await vistaUsuarios();
      case "ajustes-cuenta":
        return await vistaCuenta();
      case "ajustes-bitacora":
        return await vistaBitacora();
      case "ajustes-respaldo":
        return vistaRespaldo();
      default:
        return await vistaPacientes();
    }
  } catch (error) {
    if (error instanceof ErrorApi && error.estado === 401) {
      limpiarLlave();
      estado.sesion = null;
      return vistaEntrar("Tu sesión terminó. Vuelve a entrar.");
    }
    pintar(estado.raiz, marco(h`<div class="superficie pila"><h1>No se pudo completar</h1><p class="error">${error.message}</p><p><a href="#pacientes">Volver a pacientes</a></p></div>`));
  }
}

async function cargarSesion() {
  try {
    estado.sesion = await api("GET", "/api/sesion");
    return true;
  } catch (error) {
    if (error instanceof ErrorApi && error.estado === 401) return false;
    throw error;
  }
}

function limpiarLlave() {
  if (estado.tk) estado.tk.fill(0);
  estado.tk = null;
  estado.llave = null;
  estado.pacientes = null;
}

function vigilarInactividad() {
  if (estado.temporizador) return;
  const marcar = () => {
    estado.actividad = Date.now();
  };
  ["click", "keydown", "pointermove", "touchstart"].forEach((e) => window.addEventListener(e, marcar, { passive: true }));
  estado.temporizador = setInterval(() => {
    if (llaveLista() && Date.now() - estado.actividad > MINUTOS_BLOQUEO * 60000) {
      limpiarLlave();
      renderizar();
    }
  }, 30000);
}

async function adoptarLlave(bytes) {
  estado.tk = bytes;
  estado.llave = await cripto.importarLlaveConsultorio(bytes);
  estado.actividad = Date.now();
  vigilarInactividad();
}

const contextoDe = (tipo, id) => cripto.contexto(estado.sesion.consultorio.id, tipo, id);
const esMedico = () => ["titular", "medico"].includes(estado.sesion.usuario.rol);
const esTitular = () => estado.sesion.usuario.rol === "titular";
const tieneModulo = (m) => estado.sesion.consultorio.modulos.includes(m);
const puedeEscribir = () => estado.sesion.consultorio.puede_escribir;

function aplicarMarca() {
  const marca = estado.sesion?.consultorio?.marca ?? {};
  const raiz = document.documentElement;
  if (/^#[0-9a-f]{6}$/i.test(marca.color_primario ?? "")) {
    const tema = raiz.dataset.theme;
    const oscuro = tema ? tema === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    const { fuerte, sobre } = coloresLegibles(marca.color_primario, oscuro);
    raiz.style.setProperty("--marca", oscuro ? fuerte : marca.color_primario);
    raiz.style.setProperty("--marca-fuerte", fuerte);
    raiz.style.setProperty("--sobre-marca", sobre);
  }
}

// ---------------------------------------------------------------------------
// Marco común
// ---------------------------------------------------------------------------

function marco(contenido) {
  const { usuario, consultorio } = estado.sesion;
  const ruta = rutaActual().split("/")[0];
  const enlace = (destino, texto, activo) => h`<a href="#${destino}" ${activo ? crudo('aria-current="page"') : ""}>${texto}</a>`;
  return h`
    <header class="barra">
      <div class="marca-consultorio">
        ${consultorio.marca?.logo ? h`<img src="${consultorio.marca.logo}" alt="Logo de ${consultorio.nombre}">` : h`<img class="logo-icono" src="/img/nuvora-icono.png" alt="NUVORA">`}
        <span>${consultorio.nombre}</span>
      </div>
      <nav aria-label="Principal">
        ${enlace("pacientes", "Pacientes", ["", "pacientes", "paciente", "nueva-nota", "ficha"].includes(ruta))}
        ${esTitular() ? enlace("ajustes-marca", "Ajustes", ruta.startsWith("ajustes")) : ""}
        <a href="#cuenta-contrasena" ${ruta === "cuenta-contrasena" ? crudo('aria-current="page"') : ""}>${usuario.nombre}</a>
        <button class="boton discreto" data-accion="bloquear">Bloquear</button>
        <button class="boton discreto" data-accion="salir">Salir</button>
      </nav>
    </header>
    ${avisoCuenta()}
    <main class="contenido">${contenido}</main>`;
}

function avisoCuenta() {
  const { consultorio } = estado.sesion;
  if (consultorio.estado === "gracia") {
    return h`<div class="contenido" style="padding-block:12px 0"><p class="aviso">Tu plan venció el ${fecha(consultorio.pagado_hasta)}. Sigues operando unos días más. ${esTitular() ? h`<a href="#ajustes-cuenta">Renovar ahora</a>` : "Avísale al titular de la cuenta."}</p></div>`;
  }
  if (!consultorio.puede_escribir) {
    return h`<div class="contenido" style="padding-block:12px 0"><p class="aviso">Tu plan venció. Puedes consultar y exportar tus expedientes, pero no registrar información nueva. ${esTitular() ? h`<a href="#ajustes-cuenta">Renovar ahora</a>` : "Avísale al titular de la cuenta."}</p></div>`;
  }
  return "";
}

function pantallaAcceso(titulo, contenido) {
  return h`<div class="centro-pantalla"><div class="angosto pila" style="width:100%">
    <div class="fila"><img class="logo" src="/img/nuvora-logo.png" alt="NUVORA Health" height="54"></div>
    <div class="superficie pila"><h1>${titulo}</h1>${contenido}</div>
  </div></div>`;
}

/** Conecta un formulario con su envío: desactiva el botón, muestra errores, conserva lo escrito. */
function alEnviar(selector, trabajo) {
  const formulario = estado.raiz.querySelector(selector);
  if (!formulario) return;
  formulario.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const boton = formulario.querySelector('button[type="submit"]');
    const zona = formulario.querySelector("[data-error]");
    if (zona) zona.textContent = "";
    if (boton) boton.disabled = true;
    try {
      await trabajo(datosDeFormulario(formulario), formulario);
    } catch (error) {
      if (zona) zona.textContent = error.message;
      else throw error;
    } finally {
      if (boton) boton.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Acceso
// ---------------------------------------------------------------------------

function vistaEntrar(aviso) {
  pintar(
    estado.raiz,
    pantallaAcceso(
      "Entrar a tu consultorio",
      h`${aviso ? h`<p class="aviso">${aviso}</p>` : ""}
      <form id="f-entrar" class="pila">
        <label class="campo">Correo<input id="entrar-correo" name="email" type="email" autocomplete="username" required></label>
        <label class="campo">Contraseña<input id="entrar-contrasena" name="contrasena" type="password" autocomplete="current-password" required></label>
        <p class="error" data-error role="alert"></p>
        <button class="boton" type="submit">Entrar</button>
      </form>
      <p class="chico"><a href="#recuperar">Olvidé mi contraseña</a></p>`,
    ),
  );
  alEnviar("#f-entrar", async ({ email, contrasena }) => {
    const parametros = await api("POST", "/api/auth/parametros", { email });
    const derivadas = await cripto.derivarDeContrasena(contrasena, parametros.kdf_sal, parametros.kdf_iter);
    const sesion = await api("POST", "/api/auth/entrar", { email, auth_key: derivadas.authKey });
    estado.sesion = sesion;
    await adoptarLlave(await cripto.abrirLlave(sesion.tk_envuelta, derivadas.llaveEnvoltura));
    navegar("pacientes");
  });
}

function vistaDesbloquear() {
  const { usuario, kdf_sal, kdf_iter, tk_envuelta } = estado.sesion;
  pintar(
    estado.raiz,
    pantallaAcceso(
      "Sesión bloqueada",
      h`<p class="tenue">Por privacidad, la llave de tus expedientes solo vive en la memoria de esta pestaña. Escribe tu contraseña, ${usuario.nombre}.</p>
      <form id="f-desbloquear" class="pila">
        <label class="campo">Contraseña<input id="desbloquear-contrasena" name="contrasena" type="password" autocomplete="current-password" required autofocus></label>
        <p class="error" data-error role="alert"></p>
        <button class="boton" type="submit">Desbloquear</button>
      </form>
      <p class="chico"><button class="boton discreto" data-accion="salir">Entrar con otra cuenta</button></p>`,
    ),
  );
  alEnviar("#f-desbloquear", async ({ contrasena }) => {
    const derivadas = await cripto.derivarDeContrasena(contrasena, kdf_sal, kdf_iter);
    let bytes;
    try {
      bytes = await cripto.abrirLlave(tk_envuelta, derivadas.llaveEnvoltura);
    } catch {
      throw new Error("Esa contraseña no coincide.");
    }
    await adoptarLlave(bytes);
    renderizar();
  });
}

async function vistaActivar(token) {
  let info;
  try {
    info = await api("GET", `/api/activacion/${encodeURIComponent(token)}`);
  } catch (error) {
    pintar(
      estado.raiz,
      pantallaAcceso(
        "Este enlace ya no sirve",
        h`<p>${error.message}</p>
        <form id="f-reenviar" class="pila">
          <label class="campo">Tu correo<input id="reenviar-correo" name="email" type="email" required></label>
          <p class="error" data-error role="alert"></p>
          <button class="boton" type="submit">Enviarme un enlace nuevo</button>
        </form>`,
      ),
    );
    alEnviar("#f-reenviar", async ({ email }, formulario) => {
      await api("POST", "/api/activacion/reenviar", { email });
      formulario.innerHTML = "";
      formulario.append("Si esa cuenta está pendiente de activar, te enviamos un enlace nuevo.");
    });
    return;
  }

  pintar(
    estado.raiz,
    pantallaAcceso(
      "Crea tu contraseña",
      h`<p class="tenue">Pago confirmado para <strong>${info.consultorio}</strong>. Tu usuario es ${info.email}.</p>
      <p class="aviso">Tu contraseña protege tus expedientes. Ni nuestro equipo la conoce ni puede restablecerla.</p>
      <form id="f-activar" class="pila">
        <label class="campo">Contraseña de al menos 12 caracteres<input id="activar-contrasena" name="contrasena" type="password" autocomplete="new-password" required minlength="12"></label>
        <label class="campo">Repite la contraseña<input id="activar-confirmacion" name="confirmacion" type="password" autocomplete="new-password" required></label>
        <p class="error" data-error role="alert"></p>
        <button class="boton" type="submit">Continuar</button>
      </form>`,
    ),
  );
  alEnviar("#f-activar", async ({ contrasena, confirmacion }) => {
    const problema = validarContrasena(contrasena, confirmacion);
    if (problema) throw new Error(problema);
    const sal = cripto.nuevaSal();
    const derivadas = await cripto.derivarDeContrasena(contrasena, sal, info.iteraciones ?? cripto.ITERACIONES);
    const tk = cripto.nuevaLlaveConsultorio();
    const codigo = cripto.nuevoCodigoRecuperacion();
    const recuperacion = await cripto.derivarDeCodigo(codigo);
    const envio = {
      kdf_sal: sal,
      kdf_iter: info.iteraciones ?? cripto.ITERACIONES,
      auth_key: derivadas.authKey,
      tk_envuelta: await cripto.envolverLlave(tk, derivadas.llaveEnvoltura),
      rec_auth: recuperacion.recAuth,
      tk_envuelta_rec: await cripto.envolverLlave(tk, recuperacion.llaveEnvoltura),
    };
    pasoCodigo(token, envio, tk, codigo, info);
  });
}

function pasoCodigo(token, envio, tk, codigo, info) {
  const ultimo = codigo.split("-").at(-1);
  pintar(
    estado.raiz,
    pantallaAcceso(
      "Guarda tu código de recuperación",
      h`<p>Si olvidas tu contraseña, este código es la única forma de recuperar tus expedientes. <strong>Nosotros no podemos recuperarlos por ti.</strong></p>
      <div class="codigo-recuperacion" id="codigo-recuperacion">${codigo}</div>
      ${esDemo() ? "" : h`<button class="boton secundario" type="button" id="b-descargar-codigo">Descargar el código</button>`}
      <p class="tenue chico">Imprímelo o guárdalo fuera de esta computadora, en un lugar seguro.</p>
      <form id="f-confirmar-codigo" class="pila">
        <label class="campo">Para confirmar, escribe los últimos ${ultimo.length} caracteres<input id="confirmar-codigo" name="final" autocomplete="off" required></label>
        <p class="error" data-error role="alert"></p>
        <button class="boton" type="submit">Ya lo guardé, entrar</button>
      </form>`,
    ),
  );
  estado.raiz.querySelector("#b-descargar-codigo")?.addEventListener("click", () => {
    descargar("codigo-recuperacion-nuvora.txt", `NUVORA: código de recuperación\nCuenta: ${info.email}\nConsultorio: ${info.consultorio}\n\n${codigo}\n\nGuárdalo en un lugar seguro. Sin este código y sin tu contraseña, nadie puede recuperar tus expedientes.\n`, "text/plain");
  });
  alEnviar("#f-confirmar-codigo", async ({ final }) => {
    if (cripto.normalizarCodigo(final) !== cripto.normalizarCodigo(ultimo)) {
      throw new Error("Esos caracteres no coinciden con el final del código.");
    }
    estado.sesion = await api("POST", `/api/activacion/${encodeURIComponent(token)}`, envio);
    await adoptarLlave(tk);
    navegar("pacientes");
  });
}

function vistaRecuperar() {
  pintar(
    estado.raiz,
    pantallaAcceso(
      "Recuperar acceso",
      h`<p class="tenue">Si eres titular de la cuenta, usa tu código de recuperación. Si eres médico o asistente, pide al titular que restablezca tu contraseña.</p>
      <form id="f-recuperar" class="pila">
        <label class="campo">Correo del titular<input id="recuperar-correo" name="email" type="email" autocomplete="username" required></label>
        <label class="campo">Código de recuperación<input id="recuperar-codigo" name="codigo" autocomplete="off" required></label>
        <label class="campo">Contraseña nueva<input id="recuperar-contrasena" name="contrasena" type="password" autocomplete="new-password" required minlength="12"></label>
        <p class="error" data-error role="alert"></p>
        <button class="boton" type="submit">Recuperar acceso</button>
      </form>
      <p class="chico"><a href="#entrar">Volver a entrar</a></p>`,
    ),
  );
  alEnviar("#f-recuperar", async ({ email, codigo, contrasena }) => {
    const problema = validarContrasena(contrasena);
    if (problema) throw new Error(problema);
    const rec = await cripto.derivarDeCodigo(codigo);
    const paso1 = await api("POST", "/api/auth/recuperar/paso1", { email, rec_auth: rec.recAuth });
    const tk = await cripto.abrirLlave(paso1.tk_envuelta_rec, rec.llaveEnvoltura);
    const sal = cripto.nuevaSal();
    const derivadas = await cripto.derivarDeContrasena(contrasena, sal);
    await api("POST", "/api/auth/recuperar/paso2", {
      ticket: paso1.ticket,
      kdf_sal: sal,
      kdf_iter: cripto.ITERACIONES,
      auth_key: derivadas.authKey,
      tk_envuelta: await cripto.envolverLlave(tk, derivadas.llaveEnvoltura),
    });
    vistaEntrar("Listo. Ya puedes entrar con tu contraseña nueva.");
  });
}

function vistaCambiarContrasena(obligatorio) {
  const contenido = h`
    ${obligatorio ? h`<p class="aviso">Te dieron una contraseña temporal. Crea una propia para continuar.</p>` : ""}
    <form id="f-cambiar" class="pila">
      <label class="campo">Contraseña actual<input id="cambiar-actual" name="actual" type="password" autocomplete="current-password" required></label>
      <label class="campo">Contraseña nueva, al menos 12 caracteres<input id="cambiar-nueva" name="nueva" type="password" autocomplete="new-password" required minlength="12"></label>
      <label class="campo">Repite la contraseña nueva<input id="cambiar-confirmacion" name="confirmacion" type="password" autocomplete="new-password" required></label>
      <p class="error" data-error role="alert"></p>
      <button class="boton" type="submit">Guardar contraseña</button>
    </form>`;
  pintar(estado.raiz, obligatorio ? pantallaAcceso("Crea tu contraseña", contenido) : marco(h`<div class="superficie pila angosto"><h1>Cambiar contraseña</h1>${contenido}</div>`));
  alEnviar("#f-cambiar", async ({ actual, nueva, confirmacion }) => {
    const problema = validarContrasena(nueva, confirmacion);
    if (problema) throw new Error(problema);
    const anterior = await cripto.derivarDeContrasena(actual, estado.sesion.kdf_sal, estado.sesion.kdf_iter);
    const sal = cripto.nuevaSal();
    const derivadas = await cripto.derivarDeContrasena(nueva, sal);
    const envuelta = await cripto.envolverLlave(estado.tk, derivadas.llaveEnvoltura);
    await api("POST", "/api/auth/cambiar", { auth_key_actual: anterior.authKey, kdf_sal: sal, kdf_iter: cripto.ITERACIONES, auth_key: derivadas.authKey, tk_envuelta: envuelta });
    estado.sesion.kdf_sal = sal;
    estado.sesion.kdf_iter = cripto.ITERACIONES;
    estado.sesion.tk_envuelta = envuelta;
    estado.sesion.usuario.debe_cambiar = false;
    navegar("pacientes");
  });
}

// ---------------------------------------------------------------------------
// Pacientes
// ---------------------------------------------------------------------------

function nombreCompleto(d) {
  return [d.nombres, d.apellido1, d.apellido2].filter(Boolean).join(" ") || d.nombre || "Sin nombre";
}

async function abrirPaciente(fila) {
  const datos = await cripto.descifrarJson(estado.llave, fila.cifrado, contextoDe("paciente", fila.id));
  return { ...fila, datos, nombre: nombreCompleto(datos) };
}

async function cargarPacientes(forzar = false) {
  if (estado.pacientes && !forzar) return estado.pacientes;
  const lista = [];
  let siguiente = null;
  do {
    const pagina = await api("GET", `/api/pacientes${siguiente ? `?despues=${siguiente}` : ""}`);
    for (const fila of pagina.pacientes) lista.push(await abrirPaciente(fila));
    siguiente = pagina.siguiente;
  } while (siguiente);
  lista.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  estado.pacientes = lista;
  return lista;
}

const buscarLocal = (lista, q) => {
  const norma = (t) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const consulta = norma(q.trim());
  if (!consulta) return lista;
  return lista.filter((p) => norma(`${p.nombre} ${p.datos.curp ?? ""} ${p.datos.tutor ?? ""}`).includes(consulta));
};

function filasPacientes(lista) {
  if (!lista.length) return h`<tr><td colspan="4" class="tenue">Ningún paciente coincide con tu búsqueda.</td></tr>`;
  return lista.map(
    (p) => h`<tr data-ir="paciente/${p.id}">
      <td><a href="#paciente/${p.id}"><strong>${p.nombre}</strong></a></td>
      <td>${edadTexto(p.datos.nacimiento)}</td>
      <td>${fechaHora(p.ultima_consulta_en) || h`<span class="tenue">Sin consultas</span>`}</td>
      <td class="sin-telefono">${fechaHora(p.ultima_receta_en) || h`<span class="tenue">Sin recetas</span>`}</td>
    </tr>`,
  );
}

async function vistaPacientes() {
  const lista = await cargarPacientes();
  const vacio = lista.length === 0;
  pintar(
    estado.raiz,
    marco(h`
      <div class="fila-entre">
        <h1>Pacientes</h1>
        ${puedeEscribir() ? h`<a class="boton" href="#ficha/nueva">Registrar paciente</a>` : ""}
      </div>
      ${vacio
        ? h`<div class="superficie pila"><p>Todavía no tienes pacientes. Registra el primero para abrir su expediente.</p></div>`
        : h`<label class="campo">Buscar por nombre, CURP o tutor<input id="buscar-paciente" type="search" autocomplete="off"></label>
          <div class="superficie desborde" style="padding:0">
            <table class="tabla-pacientes">
              <thead><tr><th>Paciente</th><th>Edad</th><th>Última consulta</th><th class="sin-telefono">Última receta</th></tr></thead>
              <tbody id="cuerpo-pacientes">${filasPacientes(lista)}</tbody>
            </table>
          </div>`}
    `),
  );
  const cuerpo = estado.raiz.querySelector("#cuerpo-pacientes");
  estado.raiz.querySelector("#buscar-paciente")?.addEventListener("input", (e) => pintar(cuerpo, filasPacientes(buscarLocal(lista, e.target.value))));
}

async function pacientePorId(id) {
  const lista = await cargarPacientes();
  const paciente = lista.find((p) => p.id === id);
  if (!paciente) throw new Error("No encontramos este paciente.");
  return paciente;
}

async function vistaFicha(id) {
  const nuevo = id === "nueva";
  const p = nuevo ? { datos: {} } : await pacientePorId(id);
  const d = p.datos;
  pintar(
    estado.raiz,
    marco(h`
      <h1>${nuevo ? "Registrar paciente" : `Ficha de ${p.nombre}`}</h1>
      <form id="f-ficha" class="superficie pila">
        <fieldset><legend>Identificación</legend><div class="rejilla">
          <label class="campo">Nombre(s)<input id="ficha-nombres" name="nombres" required value="${d.nombres ?? ""}"></label>
          <label class="campo">Primer apellido<input id="ficha-apellido1" name="apellido1" required value="${d.apellido1 ?? ""}"></label>
          <label class="campo">Segundo apellido<input id="ficha-apellido2" name="apellido2" value="${d.apellido2 ?? ""}"></label>
          <label class="campo">CURP<input id="ficha-curp" name="curp" maxlength="18" pattern="[A-Za-z]{4}[0-9]{6}[A-Za-z]{6}[A-Za-z0-9][0-9]" value="${d.curp ?? ""}" title="18 caracteres. Déjala vacía si aún no la tiene; el sistema nunca la genera."></label>
          <label class="campo">Fecha de nacimiento<input id="ficha-nacimiento" name="nacimiento" type="date" required value="${d.nacimiento ?? ""}"></label>
          <label class="campo">Sexo<select id="ficha-sexo" name="sexo" required>
            <option value="" ${!d.sexo ? crudo("selected") : ""}>Elegir</option>
            <option value="F" ${d.sexo === "F" ? crudo("selected") : ""}>Femenino</option>
            <option value="M" ${d.sexo === "M" ? crudo("selected") : ""}>Masculino</option>
          </select></label>
          ${tieneModulo("crecimiento") ? h`<label class="campo">Semanas de gestación al nacer<input id="ficha-semanas" name="semanas" type="number" min="22" max="44" step="1" value="${d.semanas ?? ""}"></label>` : ""}
        </div></fieldset>
        <fieldset><legend>Contacto</legend><div class="rejilla">
          <label class="campo">Madre, padre o responsable<input id="ficha-tutor" name="tutor" value="${d.tutor ?? ""}"></label>
          <label class="campo">Teléfono<input id="ficha-telefono" name="telefono" type="tel" value="${d.telefono ?? ""}"></label>
          <label class="campo">Correo<input id="ficha-correo" name="correo" type="email" value="${d.correo ?? ""}"></label>
        </div></fieldset>
        <fieldset><legend>Antecedentes</legend><div class="pila">
          <label class="campo">Alergias<textarea id="ficha-alergias" name="alergias">${d.alergias ?? ""}</textarea></label>
          <label class="campo">Antecedentes de importancia<textarea id="ficha-antecedentes" name="antecedentes">${d.antecedentes ?? ""}</textarea></label>
        </div></fieldset>
        <p class="error" data-error role="alert"></p>
        <div class="fila"><button class="boton" type="submit">Guardar ficha</button><a class="boton secundario" href="#${nuevo ? "pacientes" : `paciente/${p.id}`}">Cancelar</a></div>
      </form>`),
  );
  alEnviar("#f-ficha", async (valores) => {
    if (!estado.publica) throw new Error("La plataforma aún no termina de configurarse. Avísale a soporte.");
    const datos = { ...d, ...valores, curp: valores.curp?.toUpperCase() || "" };
    const idPaciente = nuevo ? cripto.nuevoId() : p.id;
    const cuerpo = {
      cifrado: await cripto.cifrarJson(estado.llave, datos, contextoDe("paciente", idPaciente)),
      nombre_sellado: await cripto.sellarNombre(estado.publica, nombreCompleto(datos)),
    };
    const r = nuevo
      ? await api("POST", "/api/pacientes", { id: idPaciente, ...cuerpo })
      : await api("PUT", `/api/pacientes/${idPaciente}`, cuerpo);
    const abierto = await abrirPaciente(r.paciente);
    if (nuevo) estado.pacientes.push(abierto);
    else estado.pacientes[estado.pacientes.findIndex((x) => x.id === idPaciente)] = abierto;
    navegar(`paciente/${idPaciente}`);
  });
}

// ---------------------------------------------------------------------------
// Expediente
// ---------------------------------------------------------------------------

async function cargarRegistros(pacienteId) {
  const { registros } = await api("GET", `/api/pacientes/${pacienteId}/registros`);
  const abiertos = [];
  for (const r of registros) {
    try {
      abiertos.push({ ...r, datos: await cripto.descifrarJson(estado.llave, r.cifrado, contextoDe(r.tipo, r.id)) });
    } catch {
      abiertos.push({ ...r, datos: null, ilegible: true });
    }
  }
  return abiertos;
}

function bloqueDatos(pares) {
  const visibles = pares.filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!visibles.length) return "";
  return h`<dl>${visibles.map(([k, v]) => h`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
}

function textoSignos(s) {
  if (!s) return "";
  const partes = [
    s.peso && `Peso ${s.peso} kg`,
    s.talla && `Talla ${s.talla} cm`,
    s.pc && `PC ${s.pc} cm`,
    s.temperatura && `Temp ${s.temperatura} °C`,
    s.fc && `FC ${s.fc} lpm`,
    s.fr && `FR ${s.fr} rpm`,
    s.sat && `SatO₂ ${s.sat}%`,
    s.ta && `TA ${s.ta} mmHg`,
  ].filter(Boolean);
  return partes.join(" · ");
}

function tarjetaNota(nota, recetas, paciente) {
  if (nota.ilegible) return h`<article class="nota"><p class="error">Este registro no se pudo abrir: su contenido no corresponde a este expediente.</p></article>`;
  const d = nota.datos;
  const receta = recetas.find((r) => r.datos?.consulta_id === nota.id);
  return h`<article class="nota ${nota.anulado_en ? "anulada" : ""}">
    <div class="fila-entre">
      <h3>${fechaHora(nota.creado_en)} ${nota.anulado_en ? h`<span class="insignia alerta">Anulada</span>` : ""}</h3>
      <div class="fila">
        ${receta ? h`<button class="boton secundario" data-accion="ver-receta" data-id="${receta.id}">Ver receta</button>` : ""}
        ${receta && tieneModulo("familia") && esMedico() && puedeEscribir() ? h`<button class="boton secundario" data-accion="enlace-familia" data-id="${receta.id}">Enviar a la familia</button>` : ""}
        ${!nota.anulado_en && esMedico() && puedeEscribir() ? h`<button class="boton discreto" data-accion="anular" data-id="${nota.id}">Anular</button>` : ""}
      </div>
    </div>
    ${bloqueDatos([
      ["Motivo de consulta", d.motivo],
      ["Evolución", d.evolucion],
      ["Signos y medidas", textoSignos(d.signos)],
      ["Exploración física", d.exploracion],
      ["Diagnósticos", d.diagnosticos],
      ["Plan e indicaciones", d.plan],
      ["Próxima cita", d.proxima_cita ? fecha(`${d.proxima_cita}T12:00:00`) : ""],
    ])}
    <p class="tenue chico">${d.autor_nombre ?? ""}${d.autor_cedula ? `, cédula ${d.autor_cedula}` : ""}</p>
  </article>`;
}

async function vistaPaciente(argumento) {
  const [id, pestana = "notas"] = argumento.split("/");
  const paciente = await pacientePorId(id);
  const registros = await cargarRegistros(id);
  const d = paciente.datos;
  const notas = registros.filter((r) => r.tipo === "consulta");
  const recetas = registros.filter((r) => r.tipo === "receta");
  const somatometrias = registros.filter((r) => r.tipo === "somatometria" && r.datos);
  const pestanas = [
    ["notas", "Notas"],
    ...(esMedico() ? [["recetas", "Recetas"]] : []),
    ...(tieneModulo("crecimiento") ? [["crecimiento", "Crecimiento"]] : []),
    ["ficha", "Ficha"],
  ];

  let cuerpo = "";
  if (pestana === "notas") {
    cuerpo = esMedico()
      ? notas.length
        ? h`<div class="pila">${notas.map((n) => tarjetaNota(n, recetas, paciente))}</div>`
        : h`<p class="tenue">Aún no hay notas. Registra la primera consulta.</p>`
      : h`<p class="tenue">Las notas clínicas solo las consultan médicos. Puedes registrar medidas y actualizar la ficha.</p>`;
  } else if (pestana === "recetas") {
    cuerpo = recetas.length
      ? h`<div class="desborde"><table><thead><tr><th>Fecha</th><th>Medicamentos</th><th></th></tr></thead><tbody>
          ${recetas.map((r) => h`<tr><td>${fechaHora(r.creado_en)}</td><td>${(r.datos?.medicamentos ?? []).map((m) => m.nombre).join(", ")}</td><td><button class="boton secundario" data-accion="ver-receta" data-id="${r.id}">Ver receta</button></td></tr>`)}
        </tbody></table></div>`
      : h`<p class="tenue">Aún no hay recetas.</p>`;
  } else if (pestana === "crecimiento") {
    cuerpo = h`<div class="pila" id="zona-curva">
      <div class="rejilla">
        <label class="campo">Indicador<select id="curva-indicador">${OPCIONES_INDICADOR.map((o) => h`<option value="${o.id}">${o.nombre}</option>`)}</select></label>
        ${d.semanas && Number(d.semanas) < 37 ? h`<label class="campo">Edad<select id="curva-edad"><option value="corregida">Corregida (${d.semanas} semanas al nacer)</option><option value="cronologica">Cronológica</option></select></label>` : ""}
      </div>
      <div id="curva-resultado" class="pila"><p class="tenue">Calculando…</p></div>
    </div>`;
  } else {
    cuerpo = h`<div class="pila">${bloqueDatos([
      ["Nombre", paciente.nombre],
      ["CURP", d.curp || "Sin registrar"],
      ["Fecha de nacimiento", d.nacimiento ? fecha(`${d.nacimiento}T12:00:00`) : ""],
      ["Sexo", SEXOS[d.sexo]],
      ["Semanas de gestación", d.semanas],
      ["Responsable", d.tutor],
      ["Teléfono", d.telefono],
      ["Correo", d.correo],
      ["Antecedentes", d.antecedentes],
    ])}${puedeEscribir() ? h`<div><a class="boton secundario" href="#ficha/${id}">Editar ficha</a></div>` : ""}</div>`;
  }

  pintar(
    estado.raiz,
    marco(h`
      <div class="fila-entre">
        <div class="pila-chica">
          <h1>${paciente.nombre}</h1>
          <p class="tenue">${edadTexto(d.nacimiento)}${d.sexo ? ` · ${SEXOS[d.sexo]}` : ""}${d.curp ? ` · ${d.curp}` : ""}</p>
        </div>
        <div class="fila">
          ${puedeEscribir() ? h`<a class="boton" href="#nueva-nota/${id}">${esMedico() ? "Nueva nota" : "Registrar medidas"}</a>` : ""}
          ${esMedico() && !esDemo() ? h`<button class="boton secundario" data-accion="exportar-paciente" data-id="${id}">Exportar expediente</button>` : ""}
        </div>
      </div>
      ${d.alergias ? h`<p class="aviso"><strong>Alergias:</strong> ${d.alergias}</p>` : ""}
      <nav class="pestanas" aria-label="Expediente">${pestanas.map(([clave, texto]) => h`<a href="#paciente/${id}/${clave}" ${clave === pestana ? crudo('aria-current="page"') : ""}>${texto}</a>`)}</nav>
      <section class="superficie pila" id="zona-paciente">${cuerpo}</section>
      <div id="zona-hoja"></div>
      <dialog id="dialogo-familia"></dialog>
    `),
  );

  estado.expediente = { paciente, registros, recetas };

  if (pestana === "crecimiento") {
    const medidas = medidasDesdeRegistros(somatometrias);
    const redibujar = async () => {
      const zona = estado.raiz.querySelector("#curva-resultado");
      if (!d.nacimiento || !d.sexo) return pintar(zona, h`<p class="aviso">Completa la fecha de nacimiento y el sexo en la ficha para ver la curva.</p>`);
      pintar(
        zona,
        await dibujarCurva({
          indicador: estado.raiz.querySelector("#curva-indicador").value,
          sexo: d.sexo,
          nacimiento: d.nacimiento,
          semanas: d.semanas ? Number(d.semanas) : null,
          corregir: estado.raiz.querySelector("#curva-edad")?.value === "corregida",
          medidas,
        }),
      );
    };
    estado.raiz.querySelector("#curva-indicador").addEventListener("change", redibujar);
    estado.raiz.querySelector("#curva-edad")?.addEventListener("change", redibujar);
    await redibujar();
  }
}

// ---------------------------------------------------------------------------
// Receta
// ---------------------------------------------------------------------------

function mostrarReceta(id) {
  const { paciente, recetas } = estado.expediente;
  const receta = recetas.find((r) => r.id === id);
  if (!receta?.datos) return;
  const zona = estado.raiz.querySelector("#zona-hoja");
  pintar(
    zona,
    h`<div class="pila">
      <div class="fila-entre"><h2>Receta</h2>
        <div class="fila">${esDemo() ? "" : h`<button class="boton" data-accion="imprimir">Imprimir o guardar en PDF</button>`}
        <button class="boton discreto" data-accion="cerrar-hoja">Cerrar</button></div>
      </div>
      ${hojaReceta({
        marca: estado.sesion.consultorio.marca,
        consultorio: estado.sesion.consultorio.nombre,
        paciente: { nombre: paciente.nombre, edad: edadTexto(paciente.datos.nacimiento, new Date(receta.creado_en)), alergias: paciente.datos.alergias },
        receta: receta.datos,
        creado: receta.creado_en,
      })}
    </div>`,
  );
  zona.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function dialogoFamilia(idReceta) {
  const { paciente, recetas } = estado.expediente;
  const receta = recetas.find((r) => r.id === idReceta);
  const dialogo = estado.raiz.querySelector("#dialogo-familia");
  pintar(
    dialogo,
    h`<form id="f-familia" class="pila" method="dialog">
      <h2>Enviar a la familia</h2>
      <p class="tenue">Creamos un enlace con esta receta. Se abre con una llave que solo viaja en el propio enlace.</p>
      <label class="campo">Disponible durante<select id="familia-dias" name="dias"><option value="7">7 días</option><option value="15">15 días</option><option value="30">30 días</option></select></label>
      <p class="error" data-error role="alert"></p>
      <div class="fila"><button class="boton" type="submit">Crear enlace</button><button class="boton secundario" type="button" data-accion="cerrar-dialogo">Cancelar</button></div>
    </form>`,
  );
  if (dialogo.showModal) dialogo.showModal();
  dialogo.querySelector("#f-familia").addEventListener("submit", async (e) => {
    e.preventDefault();
    const zona = dialogo.querySelector("[data-error]");
    try {
      const dias = Number(new FormData(e.target).get("dias"));
      const contenido = {
        tipo: "receta",
        consultorio: estado.sesion.consultorio.nombre,
        marca: estado.sesion.consultorio.marca,
        paciente: { nombre: paciente.nombre, edad: edadTexto(paciente.datos.nacimiento, new Date(receta.creado_en)), alergias: paciente.datos.alergias },
        receta: receta.datos,
        creado: receta.creado_en,
      };
      const { cifrado, llaveEnlace } = await cripto.cifrarParaEnlace(contenido);
      const id = cripto.nuevoId();
      await api("POST", "/api/familia", { id, paciente_id: paciente.id, cifrado, dias });
      if (esDemo()) {
        pintar(
          dialogo,
          h`<div class="pila">
            <h2>Enlace cifrado creado</h2>
            <p>La receta ya se cifró con una llave que solo viaja en el enlace, y vencería en ${dias} días. En esta demostración el enlace no se envía.</p>
            <div><button class="boton" type="button" data-accion="cerrar-dialogo">Cerrar</button></div>
          </div>`,
        );
        return;
      }
      const url = `${location.origin}/familia.html#${id}.${llaveEnlace}`;
      const mensaje = `Hola. Aquí está la receta de ${paciente.datos.nombres ?? paciente.nombre}: ${url}`;
      pintar(
        dialogo,
        h`<div class="pila">
          <h2>Enlace listo</h2>
          <label class="campo">Enlace, vence en ${dias} días<input id="familia-enlace" readonly value="${url}"></label>
          <div class="fila">
            <a class="boton" href="https://wa.me/?text=${encodeURIComponent(mensaje)}" target="_blank" rel="noopener noreferrer">Abrir en WhatsApp</a>
            <button class="boton secundario" type="button" data-accion="copiar-enlace">Copiar</button>
            <button class="boton discreto" type="button" data-accion="cerrar-dialogo">Cerrar</button>
          </div>
        </div>`,
      );
    } catch (error) {
      zona.textContent = error.message;
    }
  });
}

// ---------------------------------------------------------------------------
// Nueva nota
// ---------------------------------------------------------------------------

function filaMedicamento(i) {
  return h`<div class="medicamento" data-medicamento>
    <label class="campo">Medicamento<input id="med-nombre-${i}" name="med_nombre" list="catalogo-vacio"></label>
    <label class="campo">Presentación<input id="med-presentacion-${i}" name="med_presentacion"></label>
    <label class="campo">Dosis<input id="med-dosis-${i}" name="med_dosis"></label>
    <label class="campo">Vía<input id="med-via-${i}" name="med_via"></label>
    <label class="campo">Frecuencia<input id="med-frecuencia-${i}" name="med_frecuencia"></label>
    <label class="campo">Duración<input id="med-duracion-${i}" name="med_duracion"></label>
    <label class="campo" style="grid-column:1/-1">Indicaciones de este medicamento<input id="med-indicaciones-${i}" name="med_indicaciones"></label>
  </div>`;
}

async function vistaNuevaNota(id) {
  const paciente = await pacientePorId(id);
  const medico = esMedico();
  let contador = 1;
  pintar(
    estado.raiz,
    marco(h`
      <div class="pila-chica"><h1>${medico ? "Nota de evolución" : "Registrar medidas"}</h1><p class="tenue">${paciente.nombre} · ${edadTexto(paciente.datos.nacimiento)}</p></div>
      ${paciente.datos.alergias ? h`<p class="aviso"><strong>Alergias:</strong> ${paciente.datos.alergias}</p>` : ""}
      <form id="f-nota" class="superficie pila">
        ${medico ? h`<label class="campo">Motivo de consulta<input id="nota-motivo" name="motivo" required></label>
        <label class="campo">Evolución y actualización del cuadro clínico<textarea id="nota-evolucion" name="evolucion"></textarea></label>` : ""}
        <fieldset><legend>Signos vitales y medidas</legend><div class="rejilla">
          <label class="campo">Peso (kg)<input id="nota-peso" name="peso" type="number" step="0.001" min="0" inputmode="decimal"></label>
          <label class="campo">Longitud o talla (cm)<input id="nota-talla" name="talla" type="number" step="0.1" min="0" inputmode="decimal"></label>
          <label class="campo">Perímetro cefálico (cm)<input id="nota-pc" name="pc" type="number" step="0.1" min="0" inputmode="decimal"></label>
          <label class="campo">Temperatura (°C)<input id="nota-temperatura" name="temperatura" type="number" step="0.1" inputmode="decimal"></label>
          <label class="campo">Frecuencia cardiaca<input id="nota-fc" name="fc" type="number" inputmode="numeric"></label>
          <label class="campo">Frecuencia respiratoria<input id="nota-fr" name="fr" type="number" inputmode="numeric"></label>
          <label class="campo">Saturación de O₂ (%)<input id="nota-sat" name="sat" type="number" inputmode="numeric"></label>
          <label class="campo">Tensión arterial<input id="nota-ta" name="ta" placeholder="100/60"></label>
        </div></fieldset>
        ${medico ? h`
        <label class="campo">Exploración física<textarea id="nota-exploracion" name="exploracion"></textarea></label>
        <label class="campo">Diagnósticos<textarea id="nota-diagnosticos" name="diagnosticos"></textarea></label>
        <label class="campo">Plan e indicaciones<textarea id="nota-plan" name="plan"></textarea></label>
        <label class="campo">Próxima cita<input id="nota-proxima" name="proxima_cita" type="date"></label>
        <fieldset><legend>Receta</legend>
          <p class="tenue chico">Se imprime aparte con tu diseño. Déjala vacía si esta consulta no lleva receta.</p>
          <div id="lista-medicamentos">${filaMedicamento(0)}</div>
          <button class="boton secundario" type="button" id="b-agregar-medicamento" style="margin-top:12px">Agregar otro medicamento</button>
        </fieldset>` : ""}
        <p class="tenue chico">Una vez guardada, la nota no se puede modificar: solo anular y registrar otra. Así el expediente conserva su historia.</p>
        <p class="error" data-error role="alert"></p>
        <div class="fila"><button class="boton" type="submit">Guardar ${medico ? "nota" : "medidas"}</button><a class="boton secundario" href="#paciente/${id}">Cancelar</a></div>
      </form>`),
  );
  estado.raiz.querySelector("#b-agregar-medicamento")?.addEventListener("click", () => {
    const zona = estado.raiz.querySelector("#lista-medicamentos");
    const contenedor = document.createElement("div");
    pintar(contenedor, filaMedicamento(contador++));
    zona.appendChild(contenedor.firstElementChild);
  });

  alEnviar("#f-nota", async (valores, formulario) => {
    const signos = {};
    for (const clave of ["peso", "talla", "pc", "temperatura", "fc", "fr", "sat", "ta"]) {
      if (valores[clave]) signos[clave] = valores[clave];
    }
    const hayMedidas = !!(signos.peso || signos.talla || signos.pc);
    const { usuario } = estado.sesion;
    const autor = { autor_nombre: usuario.nombre, autor_cedula: usuario.cedula ?? estado.sesion.consultorio.marca?.cedulas ?? null };
    const envio = [];

    if (medico) {
      const idNota = cripto.nuevoId();
      const nota = { ...autor, motivo: valores.motivo, evolucion: valores.evolucion, exploracion: valores.exploracion, diagnosticos: valores.diagnosticos, plan: valores.plan, proxima_cita: valores.proxima_cita, signos };
      envio.push({ id: idNota, tipo: "consulta", cifrado: await cripto.cifrarJson(estado.llave, nota, contextoDe("consulta", idNota)) });

      const medicamentos = [...formulario.querySelectorAll("[data-medicamento]")]
        .map((fila) => {
          const leer = (n) => fila.querySelector(`[name="med_${n}"]`).value.trim();
          return { nombre: leer("nombre"), presentacion: leer("presentacion"), dosis: leer("dosis"), via: leer("via"), frecuencia: leer("frecuencia"), duracion: leer("duracion"), indicaciones: leer("indicaciones") };
        })
        .filter((m) => m.nombre);
      if (medicamentos.length) {
        const idReceta = cripto.nuevoId();
        const receta = { ...autor, consulta_id: idNota, medicamentos, diagnostico: valores.diagnosticos, indicaciones: valores.plan, peso: signos.peso };
        envio.push({ id: idReceta, tipo: "receta", cifrado: await cripto.cifrarJson(estado.llave, receta, contextoDe("receta", idReceta)) });
      }
    }
    if (hayMedidas) {
      const idMedidas = cripto.nuevoId();
      const medidas = { peso: signos.peso, talla: signos.talla, pc: signos.pc, fecha: new Date().toISOString() };
      envio.push({ id: idMedidas, tipo: "somatometria", cifrado: await cripto.cifrarJson(estado.llave, medidas, contextoDe("somatometria", idMedidas)) });
    }
    if (!envio.length) throw new Error("Escribe al menos una medida para guardar.");
    await api("POST", `/api/pacientes/${id}/registros`, { registros: envio });
    await cargarPacientes(true);
    navegar(`paciente/${id}`);
  });
}

// ---------------------------------------------------------------------------
// Ajustes
// ---------------------------------------------------------------------------

function pestanasAjustes(activa) {
  const lista = [
    ["ajustes-marca", "Marca y receta"],
    ["ajustes-usuarios", "Usuarios"],
    ["ajustes-cuenta", "Plan y pagos"],
    ["ajustes-bitacora", "Bitácora"],
    ["ajustes-respaldo", "Respaldo y recuperación"],
  ];
  return h`<h1>Ajustes</h1><nav class="pestanas" aria-label="Ajustes">${lista.map(([r, t]) => h`<a href="#${r}" ${r === activa ? crudo('aria-current="page"') : ""}>${t}</a>`)}</nav>`;
}

function vistaMarca() {
  const { consultorio } = estado.sesion;
  const m = { ...consultorio.marca };
  const receta = { medicamentos: [{ nombre: "Medicamento de muestra", presentacion: "suspensión 100 mg/5 ml", dosis: "5 ml", via: "oral", frecuencia: "cada 8 horas", duracion: "5 días" }], diagnostico: "Diagnóstico de muestra" };
  const vistaPrevia = () =>
    hojaReceta({ marca: m, consultorio: consultorio.nombre, paciente: { nombre: "Paciente de muestra", edad: "2 años" }, receta, creado: new Date().toISOString() });

  pintar(
    estado.raiz,
    marco(h`${pestanasAjustes("ajustes-marca")}
      <form id="f-marca" class="superficie pila">
        <div class="rejilla">
          <label class="campo">Nombre del consultorio<input id="marca-nombre" name="nombre" required value="${consultorio.nombre}"></label>
          <label class="campo">Logo (PNG o JPG)<input id="marca-logo" type="file" accept="image/png,image/jpeg,image/webp"></label>
          <label class="campo">Color principal<input id="marca-color" name="color_primario" type="color" value="${m.color_primario || "#447DC0"}"></label>
        </div>
        <div class="fila"><button class="boton discreto" type="button" id="b-quitar-logo" ${m.logo ? "" : crudo("hidden")}>Quitar logo</button></div>
        <fieldset><legend>Datos que aparecen en tu receta</legend><div class="rejilla">
          <label class="campo">Nombre del médico<input id="marca-medico" name="medico_nombre" value="${m.medico_nombre ?? ""}"></label>
          <label class="campo">Especialidad<input id="marca-especialidad" name="especialidad" value="${m.especialidad ?? ""}"></label>
          <label class="campo">Cédulas profesionales<input id="marca-cedulas" name="cedulas" value="${m.cedulas ?? ""}"></label>
          <label class="campo">Institución o universidad<input id="marca-institucion" name="institucion" value="${m.institucion ?? ""}"></label>
          <label class="campo">Domicilio del consultorio<input id="marca-domicilio" name="domicilio" value="${m.domicilio ?? ""}"></label>
          <label class="campo">Teléfono<input id="marca-telefono" name="telefono" value="${m.telefono ?? ""}"></label>
          <label class="campo" style="grid-column:1/-1">Pie de receta<input id="marca-pie" name="pie_receta" value="${m.pie_receta ?? ""}"></label>
        </div></fieldset>
        <p class="error" data-error role="alert"></p>
        <p class="exito" data-exito role="status"></p>
        <div class="fila"><button class="boton" type="submit">Guardar cambios</button></div>
      </form>
      <section class="pila"><h2>Así se verá tu receta</h2><div id="vista-previa">${vistaPrevia()}</div></section>`),
  );

  const zona = estado.raiz.querySelector("#vista-previa");
  const formulario = estado.raiz.querySelector("#f-marca");
  const refrescar = () => {
    Object.assign(m, datosDeFormulario(formulario));
    pintar(zona, vistaPrevia());
  };
  formulario.addEventListener("input", refrescar);
  estado.raiz.querySelector("#marca-logo").addEventListener("change", async (e) => {
    const archivo = e.target.files[0];
    if (!archivo) return;
    const errorZona = formulario.querySelector("[data-error]");
    try {
      m.logo = await reducirImagen(archivo);
      errorZona.textContent = "";
      estado.raiz.querySelector("#b-quitar-logo").hidden = false;
      pintar(zona, vistaPrevia());
    } catch (error) {
      errorZona.textContent = error.message;
    }
  });
  estado.raiz.querySelector("#b-quitar-logo").addEventListener("click", (e) => {
    m.logo = null;
    e.target.hidden = true;
    pintar(zona, vistaPrevia());
  });
  alEnviar("#f-marca", async (valores) => {
    const { nombre, ...resto } = valores;
    const { consultorio: actualizado } = await api("PUT", "/api/consultorio", { nombre, marca: { ...m, ...resto, logo: m.logo ?? null } });
    estado.sesion.consultorio = actualizado;
    aplicarMarca();
    renderizar();
  });
}

async function vistaUsuarios() {
  const { usuarios } = await api("GET", "/api/usuarios");
  const { limites } = estado.sesion.consultorio;
  const activos = usuarios.filter((u) => !u.desactivado_en);
  const medicos = activos.filter((u) => u.rol !== "asistente").length;
  const asistentes = activos.filter((u) => u.rol === "asistente").length;
  const hayCupo = medicos < limites.medicos || asistentes < limites.asistentes;
  pintar(
    estado.raiz,
    marco(h`${pestanasAjustes("ajustes-usuarios")}
      <p class="tenue">Tu plan incluye ${limites.medicos} ${limites.medicos === 1 ? "médico" : "médicos"} y ${limites.asistentes} ${limites.asistentes === 1 ? "asistente" : "asistentes"}. Usas ${medicos} y ${asistentes}.</p>
      <div class="superficie desborde" style="padding:0"><table>
        <thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Último acceso</th><th></th></tr></thead>
        <tbody>${usuarios.map(
          (u) => h`<tr>
            <td>${u.nombre}${u.desactivado_en ? h` <span class="insignia alerta">Desactivado</span>` : ""}</td>
            <td>${u.email}</td><td>${ROLES[u.rol]}</td><td>${fechaHora(u.ultimo_acceso) || "Nunca"}</td>
            <td>${u.rol === "titular" ? "" : h`<div class="fila">
              ${u.desactivado_en ? "" : h`<button class="boton discreto" data-accion="restablecer" data-id="${u.id}" data-nombre="${u.nombre}">Restablecer contraseña</button>`}
              <button class="boton discreto" data-accion="${u.desactivado_en ? "reactivar" : "desactivar"}" data-id="${u.id}">${u.desactivado_en ? "Reactivar" : "Desactivar"}</button>
            </div>`}</td>
          </tr>`,
        )}</tbody>
      </table></div>
      <div id="zona-temporal"></div>
      ${hayCupo && puedeEscribir()
        ? h`<form id="f-usuario" class="superficie pila">
            <h2>Agregar usuario</h2>
            <div class="rejilla">
              <label class="campo">Nombre<input id="usuario-nombre" name="nombre" required></label>
              <label class="campo">Correo<input id="usuario-correo" name="email" type="email" required></label>
              <label class="campo">Rol<select id="usuario-rol" name="rol">
                ${medicos < limites.medicos ? h`<option value="medico">Médico</option>` : ""}
                ${asistentes < limites.asistentes ? h`<option value="asistente">Asistente</option>` : ""}
              </select></label>
              <label class="campo">Cédula profesional<input id="usuario-cedula" name="cedula"></label>
            </div>
            <p class="error" data-error role="alert"></p>
            <div><button class="boton" type="submit">Crear usuario</button></div>
          </form>`
        : h`<p class="tenue">Para agregar más usuarios, cambia de plan en <a href="#ajustes-cuenta">Plan y pagos</a>.</p>`}`),
  );
  alEnviar("#f-usuario", async (valores) => {
    const temporal = contrasenaTemporal();
    const material = await materialUsuario(temporal);
    await api("POST", "/api/usuarios", { ...valores, ...material });
    await vistaUsuarios();
    mostrarTemporal(valores.nombre, temporal);
  });
}

async function materialUsuario(contrasena) {
  const sal = cripto.nuevaSal();
  const derivadas = await cripto.derivarDeContrasena(contrasena, sal);
  return { kdf_sal: sal, kdf_iter: cripto.ITERACIONES, auth_key: derivadas.authKey, tk_envuelta: await cripto.envolverLlave(estado.tk, derivadas.llaveEnvoltura) };
}

function mostrarTemporal(nombre, temporal) {
  pintar(
    estado.raiz.querySelector("#zona-temporal"),
    h`<div class="aviso pila-chica"><strong>Contraseña temporal de ${nombre}:</strong><span class="codigo-recuperacion" id="contrasena-temporal">${temporal}</span><span>Entrégasela en persona. Solo se muestra esta vez y pedirá cambiarla al entrar.</span></div>`,
  );
}

const ETIQUETAS_METODO = { card: "Tarjeta", credit: "Tarjeta de crédito", debit: "Tarjeta de débito", cash: "Efectivo", cash_payment: "Efectivo", bank_transfer: "SPEI", spei: "SPEI" };

async function vistaCuenta() {
  const { consultorio, pagos } = await api("GET", "/api/cuenta");
  estado.sesion.consultorio = consultorio;
  const { planes } = await api("GET", "/api/config");
  pintar(
    estado.raiz,
    marco(h`${pestanasAjustes("ajustes-cuenta")}
      <div class="superficie pila">
        <div class="fila-entre"><h2>Plan ${consultorio.plan_nombre}, ${consultorio.ciclo}</h2><span class="insignia ${consultorio.puede_escribir ? "ok" : "alerta"}">${ESTADOS[consultorio.estado]}</span></div>
        <p>Pagado hasta el <strong>${fecha(consultorio.pagado_hasta)}</strong>. Renovación ${consultorio.renovacion === "automatica" ? "automática con tarjeta" : "manual"}.</p>
      </div>
      <form id="f-renovar" class="superficie pila">
        <h2>Renovar o cambiar de plan</h2>
        <div class="rejilla">
          <label class="campo">Plan<select id="renovar-plan" name="plan">${Object.entries(planes).map(([id, p]) => h`<option value="${id}" ${id === consultorio.plan ? crudo("selected") : ""}>${p.nombre}, ${p.medicos} ${p.medicos === 1 ? "médico" : "médicos"}</option>`)}</select></label>
          <label class="campo">Periodo<select id="renovar-ciclo" name="ciclo">
            <option value="mensual" ${consultorio.ciclo === "mensual" ? crudo("selected") : ""}>Mensual</option>
            <option value="anual" ${consultorio.ciclo === "anual" ? crudo("selected") : ""}>Anual, dos meses gratis</option>
          </select></label>
        </div>
        <label class="fila chico"><input id="renovar-recurrente" name="recurrente" type="checkbox"> Cobrar automáticamente con mi tarjeta cada periodo</label>
        <p class="error" data-error role="alert"></p>
        <div><button class="boton" type="submit">Ir a pagar</button></div>
      </form>
      <div class="superficie pila"><h2>Pagos</h2>
        ${pagos.length
          ? h`<div class="desborde"><table><thead><tr><th>Fecha</th><th>Monto</th><th>Método</th><th>Cubre hasta</th><th>Factura</th></tr></thead><tbody>
              ${pagos.map((p) => h`<tr><td>${fecha(p.pagado_en)}</td><td>${pesos(p.monto_centavos)}</td><td>${ETIQUETAS_METODO[p.metodo] ?? p.metodo ?? ""}</td><td>${fecha(p.periodo_hasta)}</td><td>${p.cfdi_estado === "emitido" ? "Emitida" : "En proceso"}</td></tr>`)}
            </tbody></table></div>`
          : h`<p class="tenue">Aún no hay pagos registrados.</p>`}
      </div>`),
  );
  alEnviar("#f-renovar", async (valores) => {
    const { url } = await api("POST", "/api/cuenta/renovar", { plan: valores.plan, ciclo: valores.ciclo, recurrente: valores.recurrente === "on" });
    if (esDemo()) throw new Error("En esta demostración no se realizan cobros.");
    location.href = url;
  });
}

async function vistaBitacora() {
  const { internos, soporte } = await api("GET", "/api/bitacora");
  pintar(
    estado.raiz,
    marco(h`${pestanasAjustes("ajustes-bitacora")}
      <section class="superficie pila">
        <h2>Accesos del equipo de soporte</h2>
        <p class="tenue">Soporte solo puede ver el nombre del paciente, la fecha y hora de su última consulta y de su última receta. Cada vez que lo hace queda aquí, con su motivo.</p>
        ${soporte.length
          ? h`<div class="desborde"><table><thead><tr><th>Fecha y hora</th><th>Agente</th><th>Motivo</th></tr></thead><tbody>
              ${soporte.map((s) => h`<tr><td>${fechaHora(s.en)}</td><td>${s.soporte_nombre}</td><td>${s.motivo}</td></tr>`)}
            </tbody></table></div>`
          : h`<p>Soporte no ha consultado tu consultorio.</p>`}
      </section>
      <section class="superficie pila">
        <h2>Actividad del consultorio</h2>
        <div class="desborde"><table><thead><tr><th>Fecha y hora</th><th>Usuario</th><th>Acción</th></tr></thead><tbody>
          ${internos.map((b) => h`<tr><td>${fechaHora(b.en)}</td><td>${b.usuario ?? "Sistema"}</td><td>${ACCIONES[b.accion] ?? b.accion}</td></tr>`)}
        </tbody></table></div>
      </section>`),
  );
}

function vistaRespaldo() {
  pintar(
    estado.raiz,
    marco(h`${pestanasAjustes("ajustes-respaldo")}
      <section class="superficie pila">
        <h2>Exportar todos los expedientes</h2>
        <p>Descarga un archivo con todos tus pacientes y notas, ya descifrados. Guárdalo en un lugar seguro: quien lo tenga puede leerlo.</p>
        <p class="tenue chico">Te recomendamos hacerlo cada mes. Debes conservar tus expedientes al menos cinco años desde el último acto médico.</p>
        ${esDemo() ? h`<p class="aviso">La descarga no está disponible en esta demostración.</p>` : h`<div><button class="boton" data-accion="exportar-todo">Descargar respaldo</button></div>`}
        <p class="exito" id="estado-respaldo" role="status"></p>
      </section>
      <section class="superficie pila">
        <h2>Código de recuperación</h2>
        <p>Si perdiste tu código o crees que alguien más lo vio, genera uno nuevo. El anterior dejará de servir.</p>
        <div><button class="boton secundario" data-accion="renovar-codigo">Generar código nuevo</button></div>
        <div id="zona-codigo"></div>
      </section>`),
  );
}

async function exportar(pacientes) {
  const salida = { generado: new Date().toISOString(), consultorio: estado.sesion.consultorio.nombre, pacientes: [] };
  for (const p of pacientes) {
    const registros = await cargarRegistros(p.id);
    salida.pacientes.push({
      id: p.id,
      datos: p.datos,
      registros: registros.map((r) => ({ id: r.id, tipo: r.tipo, fecha: r.creado_en, anulado: r.anulado_en, sello: r.sello, contenido: r.datos })),
    });
  }
  return JSON.stringify(salida, null, 2);
}

// ---------------------------------------------------------------------------
// Acciones
// ---------------------------------------------------------------------------

const acciones = {
  async salir() {
    await api("POST", "/api/auth/salir", {}).catch(() => {});
    limpiarLlave();
    estado.sesion = null;
    navegar("entrar");
  },
  bloquear() {
    limpiarLlave();
    renderizar();
  },
  "ver-receta": (b) => mostrarReceta(b.dataset.id),
  "cerrar-hoja": () => pintar(estado.raiz.querySelector("#zona-hoja"), ""),
  imprimir: () => window.print(),
  "enlace-familia": (b) => dialogoFamilia(b.dataset.id),
  "cerrar-dialogo": () => estado.raiz.querySelector("#dialogo-familia")?.close(),
  async "copiar-enlace"(boton) {
    const campo = estado.raiz.querySelector("#familia-enlace");
    try {
      await navigator.clipboard.writeText(campo.value);
      boton.textContent = "Copiado";
    } catch {
      campo.select();
    }
  },
  async anular(boton) {
    if (boton.dataset.confirmar !== "1") {
      boton.dataset.confirmar = "1";
      boton.textContent = "Confirmar: seguirá visible, marcada como anulada";
      return;
    }
    await api("POST", `/api/registros/${boton.dataset.id}/anular`, {});
    renderizar();
  },
  async "exportar-paciente"(boton) {
    const paciente = await pacientePorId(boton.dataset.id);
    if (esDemo()) return;
    descargar(`expediente-${paciente.id}.json`, await exportar([paciente]));
  },
  async "exportar-todo"() {
    const zona = estado.raiz.querySelector("#estado-respaldo");
    zona.textContent = "Preparando tu respaldo…";
    const pacientes = await cargarPacientes(true);
    descargar(`respaldo-sigilo-${new Date().toISOString().slice(0, 10)}.json`, await exportar(pacientes));
    zona.textContent = `Listo: ${pacientes.length} expedientes.`;
  },
  async "renovar-codigo"() {
    const codigo = cripto.nuevoCodigoRecuperacion();
    const rec = await cripto.derivarDeCodigo(codigo);
    await api("PUT", "/api/recuperacion", { rec_auth: rec.recAuth, tk_envuelta_rec: await cripto.envolverLlave(estado.tk, rec.llaveEnvoltura) });
    pintar(estado.raiz.querySelector("#zona-codigo"), h`<div class="pila-chica"><div class="codigo-recuperacion">${codigo}</div><p class="chico">Guárdalo ahora. No volverá a mostrarse.</p></div>`);
  },
  async restablecer(boton) {
    const temporal = contrasenaTemporal();
    await api("PATCH", `/api/usuarios/${boton.dataset.id}`, await materialUsuario(temporal));
    mostrarTemporal(boton.dataset.nombre, temporal);
  },
  async desactivar(boton) {
    await api("PATCH", `/api/usuarios/${boton.dataset.id}`, { desactivar: true });
    renderizar();
  },
  async reactivar(boton) {
    await api("PATCH", `/api/usuarios/${boton.dataset.id}`, { activar: true });
    renderizar();
  },
};

function mostrarError(mensaje) {
  const contenedor = estado.raiz.querySelector(".contenido") ?? estado.raiz;
  contenedor.querySelector("[data-aviso-error]")?.remove();
  const aviso = document.createElement("p");
  aviso.className = "aviso";
  aviso.setAttribute("role", "alert");
  aviso.dataset.avisoError = "1";
  aviso.textContent = mensaje;
  contenedor.prepend(aviso);
  aviso.scrollIntoView({ block: "center" });
}

export async function iniciarApp(raiz) {
  estado.raiz = raiz;
  raiz.addEventListener("click", async (evento) => {
    const fila = evento.target.closest("tr[data-ir]");
    if (fila && !evento.target.closest("a,button")) navegar(fila.dataset.ir);

    if (esDemo()) {
      const enlace = evento.target.closest('a[href^="#"]');
      if (enlace) {
        evento.preventDefault();
        navegar(enlace.getAttribute("href").slice(1));
        return;
      }
    }
    const boton = evento.target.closest("[data-accion]");
    if (!boton) return;
    const accion = acciones[boton.dataset.accion];
    if (!accion) return;
    const anterior = boton.disabled;
    boton.disabled = true;
    try {
      await accion(boton);
    } catch (error) {
      mostrarError(error.message);
    } finally {
      if (boton.isConnected) boton.disabled = anterior;
    }
  });
  if (!esDemo()) window.addEventListener("hashchange", renderizar);
  const { soporte_llave_publica } = await api("GET", "/api/config");
  estado.publica = soporte_llave_publica;
  await renderizar();
}

/** Solo para la demostración: entra sin pantalla de acceso, con datos ficticios. */
export async function entrarDemo(sesion, tk, ruta = "pacientes") {
  estado.sesion = sesion;
  await adoptarLlave(tk);
  estado.ruta = ruta;
}

export const refrescarDemo = (ruta) => navegar(ruta ?? estado.ruta);
