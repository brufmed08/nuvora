// Página de venta: pestañas del ejemplo, precios y formulario de contratación.
import { api, esDemo } from "./api.js";
import { pesos } from "./util.js";

const PRECIOS_INICIALES = {
  esencial: { nombre: "Esencial", precios: { mensual: 34900, anual: 349000 } },
  profesional: { nombre: "Profesional", precios: { mensual: 54900, anual: 549000 } },
  clinica: { nombre: "Clínica", precios: { mensual: 149000, anual: 1490000 } },
};

// El enlace de un QR o de un anuncio lleva ?o=origen, y se conserva hasta el registro o la compra.
const origenEnlace = () => new URLSearchParams(location.search).get("o") ?? "";

/** Antes de abrir, los botones de compra llevan a la lista de fundadores. */
function cerrarVentas(raiz) {
  const origen = origenEnlace();
  const destino = `/fundadores.html${origen ? `?o=${encodeURIComponent(origen)}` : ""}`;
  raiz.querySelectorAll("[data-comprar]").forEach((boton) => {
    const enlace = document.createElement("a");
    enlace.className = "boton";
    enlace.href = destino;
    enlace.textContent = "Apuntarme";
    boton.replaceWith(enlace);
  });
  const aviso = document.createElement("p");
  aviso.className = "aviso";
  aviso.append("Todavía no abrimos. ");
  const lista = document.createElement("a");
  lista.href = destino;
  lista.textContent = "Apúntate en la lista de fundadores";
  aviso.append(lista, " y te avisamos.");
  raiz.querySelector(".heroe")?.before(aviso);
}

export async function iniciarLanding(raiz = document) {
  let planes = PRECIOS_INICIALES;
  let ciclo = "mensual";

  // Pestañas del ejemplo
  const pestanas = [...raiz.querySelectorAll('.miradas [role="tab"]')];
  const elegir = (pestana) => {
    pestanas.forEach((p) => {
      const activa = p === pestana;
      p.setAttribute("aria-selected", String(activa));
      p.tabIndex = activa ? 0 : -1;
      raiz.querySelector(`#${p.getAttribute("aria-controls")}`).hidden = !activa;
    });
  };
  pestanas.forEach((p, i) => {
    p.addEventListener("click", () => elegir(p));
    p.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const siguiente = pestanas.at((i + (e.key === "ArrowRight" ? 1 : -1)) % pestanas.length);
      elegir(siguiente);
      siguiente.focus();
    });
  });

  // Precios
  const pintarPrecios = () => {
    raiz.querySelectorAll("[data-precio]").forEach((el) => {
      el.textContent = pesos(planes[el.dataset.precio].precios[ciclo]);
    });
    raiz.querySelectorAll("[data-periodo]").forEach((el) => {
      el.textContent = ciclo === "anual" ? "al año" : "al mes";
    });
    raiz.querySelectorAll("[data-ciclo]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.ciclo === ciclo)));
  };
  raiz.querySelectorAll("[data-ciclo]").forEach((b) =>
    b.addEventListener("click", () => {
      ciclo = b.dataset.ciclo;
      pintarPrecios();
    }),
  );
  try {
    const config = await api("GET", "/api/config");
    if (config?.planes) planes = config.planes;
    pintarPrecios();
    if (config?.ventas_abiertas === false) cerrarVentas(raiz);
  } catch {
    // Los precios iniciales del HTML siguen visibles.
  }

  // Contratación
  const dialogo = raiz.querySelector("#dialogo-compra");
  const formulario = raiz.querySelector("#f-compra");
  const total = raiz.querySelector("#compra-total");
  const resumen = () => {
    const plan = formulario.elements.plan.value;
    const periodo = formulario.elements.ciclo.value;
    total.textContent = `Total a pagar: ${pesos(planes[plan].precios[periodo])} con IVA, por ${periodo === "anual" ? "un año" : "un mes"}.`;
  };
  formulario.elements.plan.addEventListener("change", resumen);
  formulario.elements.ciclo.addEventListener("change", resumen);
  raiz.querySelectorAll("[data-comprar]").forEach((b) =>
    b.addEventListener("click", () => {
      formulario.elements.plan.value = b.dataset.comprar;
      formulario.elements.ciclo.value = ciclo;
      resumen();
      dialogo.showModal();
    }),
  );
  raiz.querySelector("#b-cancelar-compra").addEventListener("click", () => dialogo.close());
  formulario.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const zona = formulario.querySelector("[data-error]");
    const boton = formulario.querySelector('button[type="submit"]');
    zona.textContent = "";
    boton.disabled = true;
    try {
      const e = formulario.elements;
      if (esDemo()) throw new Error("En esta demostración no se realizan cobros.");
      const { url } = await api("POST", "/api/checkout", {
        plan: e.plan.value,
        ciclo: e.ciclo.value,
        nombre_consultorio: e.nombre_consultorio.value,
        nombre_medico: e.nombre_medico.value,
        email: e.email.value,
        telefono: e.telefono.value,
        origen: e.origen.value || origenEnlace(),
        recurrente: e.recurrente.checked,
        acepto_terminos: e.acepto.checked,
      });
      location.href = url;
    } catch (error) {
      zona.textContent = error.message;
      boton.disabled = false;
    }
  });
}

if (typeof document !== "undefined" && document.getElementById("pagina-venta") && !esDemo()) {
  iniciarLanding();
  if (location.hash === "#pago-no-completado") {
    const aviso = document.createElement("p");
    aviso.className = "aviso";
    aviso.textContent = "El pago no se completó y no se hizo ningún cargo. Puedes intentarlo otra vez con otra tarjeta, por SPEI o en efectivo.";
    document.querySelector(".heroe")?.before(aviso);
  }
}
