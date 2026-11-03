// Curvas de crecimiento OMS 0 a 5 años. Se calculan aquí, en el navegador: las medidas no salen del equipo.
import { h, crudo, esc, fecha } from "./util.js";

const INDICADORES = {
  wfa: { nombre: "Peso para la edad", unidad: "kg", campo: "peso" },
  lhfa: { nombre: "Longitud o talla para la edad", unidad: "cm", campo: "talla" },
  hcfa: { nombre: "Perímetro cefálico para la edad", unidad: "cm", campo: "pc" },
  bfa: { nombre: "IMC para la edad", unidad: "kg/m²", campo: "imc" },
};

const PERCENTILES = [3, 15, 50, 85, 97];
const DIAS_MES = 30.4375;

let modulo = null;
async function cargar() {
  if (modulo) return modulo;
  modulo = await import("./vendor/who-growth.js");
  return modulo;
}

export function medidasDesdeRegistros(somatometrias) {
  return somatometrias
    .filter((s) => !s.anulado_en)
    .map((s) => {
      const peso = parseFloat(s.datos.peso);
      const talla = parseFloat(s.datos.talla);
      const pc = parseFloat(s.datos.pc);
      const imc = peso > 0 && talla > 0 ? peso / (talla / 100) ** 2 : NaN;
      return { fecha: s.datos.fecha || s.creado_en, peso, talla, pc, imc };
    })
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
}

function edadDias(nacimiento, cuando) {
  const [a, m, d] = String(nacimiento).split("-").map(Number);
  const inicio = Date.UTC(a, m - 1, d);
  const f = new Date(cuando);
  return Math.floor((Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), f.getUTCDate()) - inicio) / 86400000);
}

export async function dibujarCurva({ indicador, sexo, nacimiento, semanas, corregir, medidas }) {
  const oms = await cargar();
  const sx = sexo === "F" ? "female" : "male";
  const info = INDICADORES[indicador];
  const puntos = medidas
    .map((m) => {
      const dias = edadDias(nacimiento, m.fecha);
      const diasUsados = corregir && semanas ? oms.correctedAgeInDays(dias, semanas) : dias;
      return { ...m, dias, diasUsados, valor: m[info.campo] };
    })
    .filter((p) => Number.isFinite(p.valor) && p.valor > 0 && p.diasUsados >= 0 && p.diasUsados <= 1856);

  const edadMaxima = Math.max(...puntos.map((p) => p.diasUsados), 0);
  const mesesFin = edadMaxima > 24 * DIAS_MES ? 60 : edadMaxima > 12 * DIAS_MES ? 24 : 12;
  const diasFin = Math.min(1856, Math.round(mesesFin * DIAS_MES));

  const pasos = 48;
  const curvas = PERCENTILES.map((p) => ({
    p,
    valores: Array.from({ length: pasos + 1 }, (_, i) => {
      const x = Math.round((diasFin * i) / pasos);
      return { x, y: oms.valueAtPercentile(indicador, sx, p, x, { clamp: true }) };
    }),
  }));

  const todos = curvas.flatMap((c) => c.valores.map((v) => v.y)).concat(puntos.map((p) => p.valor));
  const yMin = Math.floor(Math.min(...todos));
  const yMax = Math.ceil(Math.max(...todos));
  const izq = 48;
  const der = 44;
  const arriba = 16;
  const abajo = 40;
  const W = 760;
  const H = 400;
  const X = (d) => izq + (d / diasFin) * (W - izq - der);
  const Y = (v) => H - abajo - ((v - yMin) / (yMax - yMin || 1)) * (H - arriba - abajo);

  const pasoMes = mesesFin === 12 ? 1 : mesesFin === 24 ? 3 : 6;
  const marcasX = [];
  for (let m = 0; m <= mesesFin; m += pasoMes) marcasX.push(m);
  const rangoY = yMax - yMin;
  const pasoY = rangoY > 60 ? 10 : rangoY > 25 ? 5 : rangoY > 12 ? 2 : 1;
  const marcasY = [];
  for (let v = yMin; v <= yMax; v += pasoY) marcasY.push(v);

  const trazo = (valores) => valores.map((v, i) => `${i ? "L" : "M"}${X(v.x).toFixed(1)} ${Y(v.y).toFixed(1)}`).join(" ");

  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(info.nombre)}">
    ${marcasY.map((v) => `<line x1="${izq}" x2="${W - der}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--linea)" stroke-width="1"/><text x="${izq - 8}" y="${Y(v) + 4}" text-anchor="end" font-size="12" fill="var(--tinta-suave)">${v}</text>`).join("")}
    ${marcasX.map((m) => `<line x1="${X(m * DIAS_MES)}" x2="${X(m * DIAS_MES)}" y1="${arriba}" y2="${H - abajo}" stroke="var(--linea)" stroke-width="1"/><text x="${X(m * DIAS_MES)}" y="${H - abajo + 18}" text-anchor="middle" font-size="12" fill="var(--tinta-suave)">${m}</text>`).join("")}
    <text x="${(izq + W - der) / 2}" y="${H - 6}" text-anchor="middle" font-size="12" fill="var(--tinta-suave)">Edad en meses${corregir ? " (corregida)" : ""}</text>
    <text x="14" y="${(H - abajo) / 2}" text-anchor="middle" font-size="12" fill="var(--tinta-suave)" transform="rotate(-90 14 ${(H - abajo) / 2})">${esc(info.unidad)}</text>
    ${curvas.map((c) => `<path d="${trazo(c.valores)}" fill="none" stroke="${c.p === 50 ? "var(--marca)" : "var(--cielo)"}" stroke-width="${c.p === 50 ? 2 : 1.25}"/><text x="${W - der + 6}" y="${Y(c.valores.at(-1).y) + 4}" font-size="11" fill="var(--tinta-suave)">P${c.p}</text>`).join("")}
    ${puntos.length > 1 ? `<path d="${trazo(puntos.map((p) => ({ x: p.diasUsados, y: p.valor })))}" fill="none" stroke="var(--punto)" stroke-width="1.75"/>` : ""}
    ${puntos.map((p) => `<circle cx="${X(p.diasUsados)}" cy="${Y(p.valor)}" r="5" fill="var(--punto)" stroke="var(--papel)" stroke-width="1.5"><title>${esc(fecha(p.fecha))}: ${p.valor.toFixed(1)} ${esc(info.unidad)}</title></circle>`).join("")}
  </svg>`;

  const filas = puntos
    .map((p) => {
      const r = oms.evaluate(indicador, sx, p.valor, p.diasUsados, { clamp: true });
      return { fecha: p.fecha, valor: p.valor, z: r.zScore, percentil: r.percentile };
    })
    .reverse();

  return h`
    <div class="curva">${crudo(svg)}</div>
    <div class="leyenda-curva"><span><i></i>Medidas registradas</span><span>Líneas: percentiles 3, 15, 50, 85 y 97 de la OMS para ${sx === "female" ? "niñas" : "niños"}</span></div>
    ${filas.length
      ? h`<div class="desborde"><table>
          <thead><tr><th>Fecha</th><th>Valor (${info.unidad})</th><th>Puntaje z</th><th>Percentil</th></tr></thead>
          <tbody>${filas.map((f) => h`<tr><td>${fecha(f.fecha)}</td><td>${f.valor.toFixed(1)}</td><td>${f.z.toFixed(2)}</td><td>${f.percentil.toFixed(1)}</td></tr>`)}</tbody>
        </table></div>`
      : h`<p class="tenue">Registra una medida en una nota para verla en la curva.</p>`}
    <p class="tenue chico">Patrones de crecimiento infantil de la OMS, 0 a 5 años. Es una referencia para interpretar medidas: el criterio clínico es tuyo.</p>`;
}

export const OPCIONES_INDICADOR = Object.entries(INDICADORES).map(([id, i]) => ({ id, nombre: i.nombre }));
