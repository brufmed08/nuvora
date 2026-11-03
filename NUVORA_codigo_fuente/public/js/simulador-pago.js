import { api } from "./api.js";
import { pesos } from "./util.js";

const orden = new URLSearchParams(location.search).get("orden");
const zonaError = document.querySelector("[data-error]");
let datos = null;
try {
  datos = await api("GET", `/api/simulador/orden?orden=${encodeURIComponent(orden)}`);
  document.getElementById("simulador-monto").textContent = `Total: ${pesos(datos.monto)}`;
} catch (error) {
  zonaError.textContent = error.message;
}
document.getElementById("b-simular-tarjeta").addEventListener("click", async () => {
  try {
    const r = await api("POST", "/api/simulador/pagar", { orden });
    location.href = r.exito;
  } catch (error) {
    zonaError.textContent = error.message;
  }
});
document.getElementById("b-simular-rechazo").addEventListener("click", () => {
  if (datos) location.href = datos.fallo;
});
