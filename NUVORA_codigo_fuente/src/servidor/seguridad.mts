// Primitivas de seguridad del servidor. El servidor nunca recibe contraseñas ni llaves de consultorio:
// recibe una llave de autenticación derivada en el navegador, y la vuelve a proteger aquí.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";

const N = 2 ** 15;
const R = 8;
const P = 1;
const LARGO = 32;
const MEMORIA = 64 * 1024 * 1024;

function scrypt(valor: string, sal: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(valor, sal, LARGO, { N, r: R, p: P, maxmem: MEMORIA }, (error, clave) => {
      if (error) reject(error);
      else resolve(clave);
    });
  });
}

export async function protegerLlaveAuth(authKey: string): Promise<string> {
  const sal = randomBytes(16);
  const hash = await scrypt(authKey, sal);
  return `scrypt$${N}$${sal.toString("base64")}$${hash.toString("base64")}`;
}

export async function verificarLlaveAuth(authKey: string, guardado: string | null | undefined): Promise<boolean> {
  // Sin credencial se calcula de todos modos, para no revelar por tiempo de respuesta si la cuenta existe.
  const partes = (guardado ?? "").split("$");
  const sal = partes.length === 4 ? Buffer.from(partes[2], "base64") : Buffer.alloc(16);
  const esperado = partes.length === 4 ? Buffer.from(partes[3], "base64") : Buffer.alloc(LARGO, 1);
  const calculado = await scrypt(authKey, sal);
  return partes.length === 4 && calculado.length === esperado.length && timingSafeEqual(calculado, esperado);
}

export function sha256(valor: string): string {
  return createHash("sha256").update(valor, "utf8").digest("hex");
}

export function igualesSeguro(a: string, b: string): boolean {
  const ba = Buffer.from(sha256(a), "hex");
  const bb = Buffer.from(sha256(b), "hex");
  return timingSafeEqual(ba, bb);
}

export function nuevoToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Sal ficticia y estable para correos que no existen: evita descubrir qué cuentas hay. */
export function salFicticia(secreto: string, email: string): string {
  return createHmac("sha256", secreto).update(`kdf|${email}`).digest().subarray(0, 16).toString("base64");
}

function llaveServidor(secreto: string): Buffer {
  return createHash("sha256").update(`sigilo/servidor/v1|${secreto}`).digest();
}

export function cifrarServidor(secreto: string, texto: string): string {
  const iv = randomBytes(12);
  const cifrador = createCipheriv("aes-256-gcm", llaveServidor(secreto), iv);
  const datos = Buffer.concat([cifrador.update(texto, "utf8"), cifrador.final()]);
  return [iv, cifrador.getAuthTag(), datos].map((b) => b.toString("base64")).join(".");
}

export function descifrarServidor(secreto: string, sobre: string): string {
  const [iv, etiqueta, datos] = sobre.split(".").map((p) => Buffer.from(p, "base64"));
  const descifrador = createDecipheriv("aes-256-gcm", llaveServidor(secreto), iv);
  descifrador.setAuthTag(etiqueta);
  return Buffer.concat([descifrador.update(datos), descifrador.final()]).toString("utf8");
}

// TOTP (RFC 6238) para el segundo factor del equipo de soporte.
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function nuevoSecretoTotp(): string {
  const bytes = randomBytes(20);
  let bits = 0;
  let valor = 0;
  let salida = "";
  for (const byte of bytes) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      salida += BASE32[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) salida += BASE32[(valor << (5 - bits)) & 31];
  return salida;
}

function decodificarBase32(texto: string): Buffer {
  let bits = 0;
  let valor = 0;
  const salida: number[] = [];
  for (const c of texto.replace(/=+$/, "").toUpperCase()) {
    const i = BASE32.indexOf(c);
    if (i < 0) throw new Error("base32_invalido");
    valor = (valor << 5) | i;
    bits += 5;
    if (bits >= 8) {
      salida.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(salida);
}

export function codigoTotp(secreto: string, instante: number): string {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(Math.floor(instante / 1000 / 30)));
  const mac = createHmac("sha1", decodificarBase32(secreto)).update(contador).digest();
  const desplazamiento = mac[mac.length - 1] & 15;
  const numero = (mac.readUInt32BE(desplazamiento) & 0x7fffffff) % 1000000;
  return String(numero).padStart(6, "0");
}

export function verificarTotp(secreto: string, codigo: string, instante: number): boolean {
  if (!/^\d{6}$/.test(codigo)) return false;
  return [-30000, 0, 30000].some((d) => igualesSeguro(codigoTotp(secreto, instante + d), codigo));
}
