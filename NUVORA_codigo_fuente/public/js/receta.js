// Hoja de receta con la marca de cada consultorio. La usan el expediente y el enlace para la familia.
import { crudo, fecha, h } from "./util.js";

const colorSeguro = (valor) => (/^#[0-9a-f]{6}$/i.test(valor ?? "") ? valor : "#447DC0");

export function hojaReceta({ marca, consultorio, paciente, receta, creado }) {
  const m = marca ?? {};
  const d = paciente ?? {};
  const color = colorSeguro(m.color_primario);
  return h`<article class="hoja" style="--color-receta:${crudo(color)}">
    <header class="hoja-encabezado">
      ${m.logo ? h`<img src="${m.logo}" alt="">` : ""}
      <div class="pila-chica">
        <h3>${m.medico_nombre || receta.autor_nombre || consultorio}</h3>
        ${m.especialidad ? h`<span>${m.especialidad}</span>` : ""}
        ${m.cedulas || receta.autor_cedula ? h`<span class="chico">Cédula: ${m.cedulas || receta.autor_cedula}</span>` : ""}
        ${m.institucion ? h`<span class="chico">${m.institucion}</span>` : ""}
      </div>
    </header>
    <div class="hoja-datos">
      <span><strong>Paciente:</strong> ${d.nombre}</span>
      ${d.edad ? h`<span><strong>Edad:</strong> ${d.edad}</span>` : ""}
      ${receta.peso ? h`<span><strong>Peso:</strong> ${receta.peso} kg</span>` : ""}
      <span><strong>Fecha:</strong> ${fecha(creado)}</span>
    </div>
    ${d.alergias ? h`<div class="chico"><strong>Alergias:</strong> ${d.alergias}</div>` : ""}
    ${receta.diagnostico ? h`<div class="chico"><strong>Diagnóstico:</strong> ${receta.diagnostico}</div>` : ""}
    <div class="hoja-rp">Rx</div>
    <ol>
      ${(receta.medicamentos ?? []).map(
        (x) => h`<li><strong>${x.nombre}</strong>${x.presentacion ? h` ${x.presentacion}` : ""}<br>
          ${[x.dosis, x.via, x.frecuencia, x.duracion].filter(Boolean).join(", ")}
          ${x.indicaciones ? h`<br><span class="chico">${x.indicaciones}</span>` : ""}</li>`,
      )}
    </ol>
    ${receta.indicaciones ? h`<div class="chico"><strong>Indicaciones generales:</strong> ${receta.indicaciones}</div>` : ""}
    <div class="hoja-firma"><div>${m.medico_nombre || receta.autor_nombre || ""}<br>Firma</div></div>
    <footer class="hoja-pie">${[m.domicilio, m.telefono, m.pie_receta].filter(Boolean).join(" · ")}</footer>
  </article>`;
}
