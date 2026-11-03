// La llave está después del # del enlace: el navegador no la envía al servidor.
import { api } from "./api.js";
import { descifrarDeEnlace } from "./cripto.js";
import { hojaReceta } from "./receta.js";
import { fecha, h, pintar } from "./util.js";

const zona = document.getElementById("familia");
const [id, llave] = location.hash.slice(1).split(".");

async function abrir() {
  if (!id || !llave) {
    return pintar(zona, h`<div class="superficie pila"><h1>Enlace incompleto</h1><p>Pídele a tu médico que te lo envíe otra vez.</p></div>`);
  }
  try {
    const r = await api("GET", `/api/familia/${encodeURIComponent(id)}`);
    const contenido = await descifrarDeEnlace(r.cifrado, llave);
    pintar(
      zona,
      h`<div class="fila-entre"><p class="tenue">Disponible hasta el ${fecha(r.expira_en)}</p><button class="boton" id="b-imprimir">Imprimir o guardar en PDF</button></div>
      ${hojaReceta({ marca: contenido.marca, consultorio: contenido.consultorio, paciente: contenido.paciente, receta: contenido.receta, creado: contenido.creado })}
      <p class="tenue chico">Esta receta es para el paciente indicado. Si tienes dudas sobre el tratamiento, consulta a tu médico.</p>`,
    );
    document.getElementById("b-imprimir").addEventListener("click", () => window.print());
  } catch (error) {
    pintar(zona, h`<div class="superficie pila"><h1>No se pudo abrir</h1><p>${error.message}</p></div>`);
  }
}

abrir();
