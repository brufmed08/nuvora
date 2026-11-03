// Página a la que regresa quien pagó. El identificador viaja tras el #, así que no queda en registros del servidor.
import { api } from "./api.js";
import { h, pintar } from "./util.js";

const zona = document.getElementById("resultado");
const [solicitud, token] = location.hash.slice(1).split(".");
const INTENTOS = 40;

async function revisar(intento = 0) {
  try {
    const r = await api("GET", `/api/checkout/estado?s=${encodeURIComponent(solicitud)}&t=${encodeURIComponent(token)}`);
    if (r.estado === "pagada") {
      pintar(
        zona,
        r.activar
          ? h`<h1>Pago confirmado</h1>
              <p>Ya puedes crear tu contraseña y entrar. También enviamos el enlace a ${r.email}.</p>
              <a class="boton" id="b-activar" href="/app.html${r.activar}">Crear mi contraseña</a>`
          : h`<h1>Tu cuenta ya está activa</h1><a class="boton" href="/app.html">Entrar</a>`,
      );
      history.replaceState(null, "", location.pathname);
      return;
    }
    if (intento >= INTENTOS) {
      pintar(
        zona,
        h`<h1>Tu pago sigue en proceso</h1>
          <p>Si pagaste con tarjeta, se confirmará en unos minutos. Si elegiste SPEI o efectivo, se confirmará cuando recibamos el pago.</p>
          <p>Te enviaremos el enlace de activación a tu correo. Ya puedes cerrar esta página.</p>`,
      );
      return;
    }
    setTimeout(() => revisar(intento + 1), 3000);
  } catch (error) {
    pintar(zona, h`<h1>No pudimos revisar tu pago</h1><p class="error">${error.message}</p><p>Si ya pagaste, recibirás el enlace de activación en tu correo.</p>`);
  }
}

if (!solicitud || !token) {
  pintar(zona, h`<h1>Enlace incompleto</h1><p>Revisa tu correo: ahí recibirás el enlace de activación cuando se confirme el pago.</p>`);
} else {
  revisar();
}
