// Cifrado en el navegador. Aquí se decide que el servidor nunca pueda leer un expediente:
// la contraseña no sale de este archivo y la llave del consultorio solo existe en memoria.
//
// contraseña ──PBKDF2──► maestra ──HKDF──► llave de autenticación (se envía al servidor)
//                                  └─HKDF─► llave de envoltura (nunca sale del navegador)
// llave de envoltura ──► abre la copia de la llave del consultorio guardada en el servidor
// llave del consultorio ──AES-256-GCM──► pacientes y notas

export const ITERACIONES = 600000;
export const VERSION_SOBRE = "v1";

const codificador = new TextEncoder();
const decodificador = new TextDecoder();

export function aB64(bytes) {
  const datos = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let binario = "";
  for (let i = 0; i < datos.length; i += 0x8000) {
    binario += String.fromCharCode.apply(null, datos.subarray(i, i + 0x8000));
  }
  return btoa(binario);
}

export function deB64(texto) {
  const binario = atob(texto);
  const salida = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) salida[i] = binario.charCodeAt(i);
  return salida;
}

export function aB64Url(bytes) {
  return aB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function deB64Url(texto) {
  const relleno = texto.length % 4 === 0 ? "" : "=".repeat(4 - (texto.length % 4));
  return deB64(texto.replace(/-/g, "+").replace(/_/g, "/") + relleno);
}

const aleatorio = (n) => crypto.getRandomValues(new Uint8Array(n));

export const nuevaSal = () => aB64(aleatorio(16));
export const nuevoId = () => crypto.randomUUID();

async function hkdf(base, info, longitudBits = 256) {
  return crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: codificador.encode(info) },
    base,
    longitudBits,
  );
}

async function llaveAes(bytes, usos = ["encrypt", "decrypt"]) {
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, usos);
}

/** Deriva, a partir de la contraseña, lo que se envía al servidor y lo que nunca sale de aquí. */
export async function derivarDeContrasena(contrasena, salB64, iteraciones = ITERACIONES) {
  const base = await crypto.subtle.importKey("raw", codificador.encode(contrasena.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const maestra = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: deB64(salB64), iterations: iteraciones }, base, 256);
  const baseHkdf = await crypto.subtle.importKey("raw", maestra, "HKDF", false, ["deriveBits"]);
  const auth = await hkdf(baseHkdf, "sigilo/auth/v1");
  const envoltura = await hkdf(baseHkdf, "sigilo/envoltura/v1");
  return { authKey: aB64(auth), llaveEnvoltura: await llaveAes(envoltura) };
}

async function cifrarBytes(llave, bytes, aad) {
  const iv = aleatorio(12);
  const parametros = { name: "AES-GCM", iv };
  if (aad) parametros.additionalData = codificador.encode(aad);
  const datos = await crypto.subtle.encrypt(parametros, llave, bytes);
  return `${VERSION_SOBRE}.${aB64(iv)}.${aB64(datos)}`;
}

async function descifrarBytes(llave, sobre, aad) {
  const [version, iv, datos] = String(sobre).split(".");
  if (version !== VERSION_SOBRE || !iv || !datos) throw new Error("Formato de información cifrada no reconocido.");
  const parametros = { name: "AES-GCM", iv: deB64(iv) };
  if (aad) parametros.additionalData = codificador.encode(aad);
  return new Uint8Array(await crypto.subtle.decrypt(parametros, llave, deB64(datos)));
}

// Llave del consultorio ------------------------------------------------------

export const nuevaLlaveConsultorio = () => aleatorio(32);
export const envolverLlave = (bytesLlave, llaveEnvoltura) => cifrarBytes(llaveEnvoltura, bytesLlave, "sigilo/tk");
export const abrirLlave = (sobre, llaveEnvoltura) => descifrarBytes(llaveEnvoltura, sobre, "sigilo/tk");
export const importarLlaveConsultorio = (bytesLlave) => llaveAes(bytesLlave);

// Contenido: el contexto (consultorio, tipo, id) queda atado al cifrado.
// Si alguien mueve un texto cifrado a otro paciente, ya no se puede abrir.
export function contexto(consultorioId, tipo, id) {
  return `sigilo/v1|${consultorioId}|${tipo}|${id}`;
}

export async function cifrarJson(llave, valor, aad) {
  return cifrarBytes(llave, codificador.encode(JSON.stringify(valor)), aad);
}

export async function descifrarJson(llave, sobre, aad) {
  return JSON.parse(decodificador.decode(await descifrarBytes(llave, sobre, aad)));
}

// Código de recuperación -----------------------------------------------------

const ALFABETO = "ABCDEFGHJKMNPQRSTVWXYZ0123456789";

export function nuevoCodigoRecuperacion() {
  const bytes = aleatorio(32);
  let bits = 0;
  let valor = 0;
  let salida = "";
  for (const byte of bytes) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      salida += ALFABETO[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
    valor &= (1 << bits) - 1;
  }
  if (bits > 0) salida += ALFABETO[(valor << (5 - bits)) & 31];
  return salida.match(/.{1,4}/g).join("-");
}

export const normalizarCodigo = (codigo) => String(codigo).toUpperCase().replace(/[^A-Z0-9]/g, "");

export async function derivarDeCodigo(codigo) {
  const base = await crypto.subtle.importKey("raw", codificador.encode(normalizarCodigo(codigo)), "HKDF", false, ["deriveBits"]);
  const auth = await hkdf(base, "sigilo/recuperacion/auth/v1");
  const envoltura = await hkdf(base, "sigilo/recuperacion/envoltura/v1");
  return { recAuth: aB64(auth), llaveEnvoltura: await llaveAes(envoltura) };
}

// Nombre para soporte --------------------------------------------------------
// Se sella con la llave pública de soporte. Solo el navegador de un agente puede abrirlo,
// así que ni una copia de la base de datos ni el propio servidor revelan los nombres.

const RSA = { name: "RSA-OAEP", hash: "SHA-256" };
const MAX_BYTES_SELLO = 180;

export async function sellarNombre(llavePublicaB64, nombre) {
  const llave = await crypto.subtle.importKey("spki", deB64(llavePublicaB64), RSA, false, ["encrypt"]);
  let bytes = codificador.encode(nombre);
  if (bytes.length > MAX_BYTES_SELLO) bytes = bytes.subarray(0, MAX_BYTES_SELLO);
  return aB64(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, llave, bytes));
}

export async function nuevoParSoporte() {
  const par = await crypto.subtle.generateKey(
    { ...RSA, modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["encrypt", "decrypt"],
  );
  return {
    publica: aB64(await crypto.subtle.exportKey("spki", par.publicKey)),
    privadaBytes: new Uint8Array(await crypto.subtle.exportKey("pkcs8", par.privateKey)),
  };
}

export const envolverPrivadaSoporte = (bytes, llaveEnvoltura) => cifrarBytes(llaveEnvoltura, bytes, "sigilo/soporte");
export const abrirPrivadaSoporte = (sobre, llaveEnvoltura) => descifrarBytes(llaveEnvoltura, sobre, "sigilo/soporte");
export const importarPrivadaSoporte = (bytes) => crypto.subtle.importKey("pkcs8", bytes, RSA, false, ["decrypt"]);

export async function abrirSello(llavePrivada, selloB64) {
  return decodificador.decode(await crypto.subtle.decrypt({ name: "RSA-OAEP" }, llavePrivada, deB64(selloB64)));
}

// Enlace para la familia -----------------------------------------------------
// La llave va después del # del enlace: el navegador nunca la envía al servidor.

export async function cifrarParaEnlace(valor) {
  const bytesLlave = aleatorio(32);
  const llave = await llaveAes(bytesLlave);
  return { cifrado: await cifrarJson(llave, valor, "sigilo/familia"), llaveEnlace: aB64Url(bytesLlave) };
}

export async function descifrarDeEnlace(cifrado, llaveEnlace) {
  return descifrarJson(await llaveAes(deB64Url(llaveEnlace)), cifrado, "sigilo/familia");
}
