import { iniciarApp } from "./app.js";

iniciarApp(document.getElementById("app")).catch((error) => {
  document.getElementById("app").textContent = `No se pudo iniciar: ${error.message}`;
});
