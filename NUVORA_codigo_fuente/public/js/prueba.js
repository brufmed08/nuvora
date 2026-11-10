// Solicitud de prueba gratis de 3 meses. Requiere un código que solo genera la cuenta maestra.
import { api } from "./api.js";

const formulario = document.querySelector("#f-prueba");
const zonaError = formulario.querySelector("[data-error]");
const boton = formulario.querySelector('button[type="submit"]');
const e = formulario.elements;
const codigoEnlace = new URLSearchParams(location.search).get("codigo");
if (codigoEnlace) e.codigo.value = codigoEnlace.toUpperCase();
const planEnlace = new URLSearchParams(location.search).get("plan");
if (["esencial", "profesional", "clinica"].includes(planEnlace)) e.plan.value = planEnlace;

formulario.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  zonaError.textContent = "";
  boton.disabled = true;
  const correo = e.email.value.trim();
  try {
    await api("POST", "/api/prueba/solicitar", {
      codigo: e.codigo.value,
      nombre_medico: e.nombre_medico.value,
      nombre_consultorio: e.nombre_consultorio.value,
      email: correo,
      telefono: e.telefono.value,
      especialidad: e.especialidad.value,
      ciudad: e.ciudad.value,
      plan: e.plan.value,
      necesidades: e.necesidades.value,
      sitio_web: e.sitio_web.value,
      acepto_terminos: e.acepto.checked,
    });
    const hecho = document.createElement("div");
    hecho.className = "superficie pila";
    hecho.setAttribute("role", "status");
    const titulo = document.createElement("h2");
    titulo.textContent = "Recibimos tu solicitud";
    const texto = document.createElement("p");
    texto.textContent = `La revisamos personalmente. Cuando la autoricemos te llegará a ${correo} el enlace para activar tus 3 meses gratis.`;
    const enlace = document.createElement("a");
    enlace.className = "boton secundario";
    enlace.href = "/demo.html";
    enlace.textContent = "Mientras tanto, ver la demostración";
    const fila = document.createElement("div");
    fila.append(enlace);
    hecho.append(titulo, texto, fila);
    formulario.replaceWith(hecho);
    titulo.tabIndex = -1;
    titulo.focus();
  } catch (error) {
    zonaError.textContent = error.message;
    boton.disabled = false;
  }
});
