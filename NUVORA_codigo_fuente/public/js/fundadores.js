// Lista de fundadores: registra a quien quiere que le avisemos de la apertura.
import { api } from "./api.js";

const formulario = document.querySelector("#f-fundadores");
const zonaError = formulario.querySelector("[data-error]");
const boton = formulario.querySelector('button[type="submit"]');
const origen = new URLSearchParams(location.search).get("o") ?? "";

formulario.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  zonaError.textContent = "";
  boton.disabled = true;
  const e = formulario.elements;
  const correo = e.email.value.trim();
  try {
    await api("POST", "/api/fundadores", {
      nombre: e.nombre.value,
      email: correo,
      especialidad: e.especialidad.value,
      ciudad: e.ciudad.value,
      origen,
      sitio_web: e.sitio_web.value,
      acepto_aviso: e.acepto.checked,
    });
    const hecho = document.createElement("div");
    hecho.className = "superficie pila";
    hecho.setAttribute("role", "status");
    const titulo = document.createElement("h2");
    titulo.textContent = "Tu lugar quedó apartado";
    const texto = document.createElement("p");
    texto.textContent = `Te escribiremos a ${correo} cuando abramos. Mientras tanto, puedes ver cómo funciona con datos ficticios.`;
    const enlace = document.createElement("a");
    enlace.className = "boton secundario";
    enlace.href = "/demo.html";
    enlace.textContent = "Probar la demostración";
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
