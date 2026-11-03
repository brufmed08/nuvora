import "./preparar.js";
import { entrarDemo, iniciarApp, refrescarDemo } from "../public/js/app.js";
import { iniciarLanding } from "../public/js/landing.js";
import { entrarSoporteDemo } from "../public/js/soporte.js";
import { fechaHora, h, pintar } from "../public/js/util.js";
import { crearServidorDemo } from "./servidor-demo.js";

const zonas = {
  venta: document.getElementById("demo-venta"),
  expediente: document.getElementById("demo-expediente"),
  soporte: document.getElementById("demo-soporte"),
  servidor: document.getElementById("demo-servidor"),
};

const recorte = (texto, n = 88) => (texto && texto.length > n ? `${texto.slice(0, n)}…` : texto ?? "");

async function iniciar() {
  const servidor = await crearServidorDemo();
  globalThis.__SIGILO_API__ = servidor.atender;
  document.documentElement.classList.add("modo-demo");

  let appLista = false;
  let ventaLista = false;

  function pintarServidor() {
    const { pacientes, registros } = servidor.tablas();
    pintar(
      zonas.servidor,
      h`<main class="contenido">
        <div class="pila-chica">
          <h1>Lo que guarda el servidor</h1>
          <p class="tenue">Esta es la información real que tiene el servidor de esta demostración. Agrega un paciente en el expediente y aparecerá aquí, ilegible.</p>
        </div>
        <section class="superficie pila" style="padding:16px">
          <h2>Pacientes</h2>
          <div class="desborde"><table>
            <thead><tr><th>Ficha cifrada</th><th>Nombre sellado para soporte</th><th>Última consulta</th><th>Última receta</th></tr></thead>
            <tbody>${pacientes.map((p) => h`<tr><td class="celda-cifrada">${recorte(p.cifrado)}</td><td class="celda-cifrada">${recorte(p.nombre_sellado)}</td><td>${fechaHora(p.ultima_consulta_en)}</td><td>${fechaHora(p.ultima_receta_en)}</td></tr>`)}</tbody>
          </table></div>
        </section>
        <section class="superficie pila" style="padding:16px">
          <h2>Notas, recetas y medidas</h2>
          <div class="desborde"><table>
            <thead><tr><th>Tipo</th><th>Contenido cifrado</th><th>Fecha</th></tr></thead>
            <tbody>${registros.slice(-12).reverse().map((r) => h`<tr><td>${r.tipo}</td><td class="celda-cifrada">${recorte(r.cifrado, 120)}</td><td>${fechaHora(r.creado_en)}</td></tr>`)}</tbody>
          </table></div>
        </section>
      </main>`,
    );
  }

  async function mostrar(vista) {
    Object.entries(zonas).forEach(([nombre, zona]) => {
      zona.hidden = nombre !== vista;
    });
    document.querySelectorAll("[data-vista]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.vista === vista)));
    window.scrollTo(0, 0);
    if (vista === "venta" && !ventaLista) {
      ventaLista = true;
      await iniciarLanding(zonas.venta);
    }
    if (vista === "expediente") {
      if (!appLista) {
        appLista = true;
        await entrarDemo(servidor.sesion(), servidor.tk, "pacientes");
        await iniciarApp(zonas.expediente);
      } else {
        await refrescarDemo();
      }
    }
    if (vista === "soporte") await entrarSoporteDemo(zonas.soporte, servidor.usuarioSoporte, servidor.privadaSoporte);
    if (vista === "servidor") pintarServidor();
  }

  document.querySelectorAll("[data-vista]").forEach((b) => b.addEventListener("click", () => mostrar(b.dataset.vista)));

  // En la página de venta, los enlaces internos llevan a las vistas de la demostración.
  zonas.venta.addEventListener("click", (e) => {
    const enlace = e.target.closest("a[href]");
    if (!enlace) return;
    const destino = enlace.getAttribute("href");
    if (destino.startsWith("#")) {
      e.preventDefault();
      zonas.venta.querySelector(destino)?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    if (destino.startsWith("/legal/")) {
      e.preventDefault();
      enlace.title = "Los documentos legales están en borrador";
      return;
    }
    if (destino.startsWith("/")) {
      e.preventDefault();
      mostrar("expediente");
    }
  });

  await mostrar("expediente");
}

iniciar().catch((error) => {
  document.getElementById("demo-expediente").textContent = `No se pudo iniciar la demostración: ${error.message}`;
});
