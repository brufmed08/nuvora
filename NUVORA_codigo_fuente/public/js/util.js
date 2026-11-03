// Utilidades de presentación. Todo lo que se escribe en pantalla pasa por h``, que escapa por defecto:
// un nombre o una nota jamás pueden inyectar código en la página.
export class Crudo {
  constructor(valor) {
    this.valor = valor;
  }
}
export const crudo = (valor) => new Crudo(valor);

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (valor) => String(valor ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

function aHtml(valor) {
  if (valor === null || valor === undefined || valor === false || valor === true) return "";
  if (valor instanceof Crudo) return valor.valor;
  if (Array.isArray(valor)) return valor.map(aHtml).join("");
  return esc(valor);
}

export function h(partes, ...valores) {
  let salida = "";
  partes.forEach((parte, i) => {
    salida += parte;
    if (i < valores.length) salida += aHtml(valores[i]);
  });
  return new Crudo(salida);
}

export function pintar(elemento, vista) {
  elemento.innerHTML = aHtml(vista);
}

const fmtFecha = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "numeric" });
const fmtFechaHora = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export const fecha = (v) => (v ? fmtFecha.format(new Date(v)) : "");
export const fechaHora = (v) => (v ? fmtFechaHora.format(new Date(v)) : "");

/** Fecha de nacimiento en texto AAAA-MM-DD, sin que la zona horaria la mueva un día. */
export function fechaLocal(texto) {
  if (!texto) return null;
  const [a, m, d] = String(texto).split("-").map(Number);
  return new Date(a, (m || 1) - 1, d || 1);
}

export function edadTexto(nacimiento, referencia = new Date()) {
  const inicio = fechaLocal(nacimiento);
  if (!inicio) return "";
  let meses = (referencia.getFullYear() - inicio.getFullYear()) * 12 + referencia.getMonth() - inicio.getMonth();
  if (referencia.getDate() < inicio.getDate()) meses -= 1;
  if (meses < 0) return "";
  if (meses === 0) {
    const dias = Math.floor((referencia - inicio) / 86400000);
    return `${dias} ${dias === 1 ? "día" : "días"}`;
  }
  if (meses < 24) return `${meses} ${meses === 1 ? "mes" : "meses"}`;
  const anos = Math.floor(meses / 12);
  const resto = meses % 12;
  return resto ? `${anos} años ${resto} ${resto === 1 ? "mes" : "meses"}` : `${anos} años`;
}

export const pesos = (centavos) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: centavos % 100 ? 2 : 0 }).format(centavos / 100);

export function datosDeFormulario(formulario) {
  const salida = {};
  for (const [clave, valor] of new FormData(formulario).entries()) {
    salida[clave] = typeof valor === "string" ? valor.trim() : valor;
  }
  return salida;
}

function luminancia(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  if (!m) return 0;
  const canal = (c) => {
    const v = parseInt(c, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * canal(m[1]) + 0.7152 * canal(m[2]) + 0.0722 * canal(m[3]);
}

function contraste(a, b) {
  const [x, y] = [luminancia(a), luminancia(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

function mezclar(hex, destino, t) {
  const canal = (h, i) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const texto = [0, 1, 2]
    .map((i) => Math.round(canal(hex, i) + (canal(destino, i) - canal(hex, i)) * t).toString(16).padStart(2, "0"))
    .join("");
  return `#${texto}`;
}

/** Adapta el color que eligió cada consultorio para que botones y enlaces sigan siendo legibles. */
export function coloresLegibles(hex, oscuro) {
  const fondo = oscuro ? "#16222f" : "#ffffff";
  const destino = oscuro ? "#ffffff" : "#000000";
  let fuerte = hex;
  for (let t = 0.05; t <= 1 && contraste(fuerte, fondo) < 4.5; t += 0.05) fuerte = mezclar(hex, destino, t);
  return { fuerte, sobre: oscuro ? "#0b1b2b" : "#ffffff" };
}

/** Reduce el logo en el navegador para que quepa en el límite del servidor. */
export function reducirImagen(archivo, ladoMax = 480) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(archivo);
    const imagen = new Image();
    imagen.onload = () => {
      const escala = Math.min(1, ladoMax / Math.max(imagen.width, imagen.height));
      const lienzo = document.createElement("canvas");
      lienzo.width = Math.max(1, Math.round(imagen.width * escala));
      lienzo.height = Math.max(1, Math.round(imagen.height * escala));
      lienzo.getContext("2d").drawImage(imagen, 0, 0, lienzo.width, lienzo.height);
      URL.revokeObjectURL(url);
      resolve(lienzo.toDataURL("image/png"));
    };
    imagen.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("No pudimos leer esa imagen. Usa un archivo PNG o JPG."));
    };
    imagen.src = url;
  });
}

export function descargar(nombre, contenido, tipo = "application/json") {
  const url = URL.createObjectURL(new Blob([contenido], { type: tipo }));
  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = nombre;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function contrasenaTemporal() {
  const letras = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => letras[b % letras.length]).join("");
}

export const LONGITUD_MINIMA = 12;

export function validarContrasena(contrasena, confirmacion) {
  if (contrasena.length < LONGITUD_MINIMA) return `Usa al menos ${LONGITUD_MINIMA} caracteres. Una frase es más fácil de recordar.`;
  if (confirmacion !== undefined && contrasena !== confirmacion) return "Las dos contraseñas no coinciden.";
  if (/^(.)\1+$/.test(contrasena)) return "Esa contraseña es demasiado fácil de adivinar.";
  return null;
}
