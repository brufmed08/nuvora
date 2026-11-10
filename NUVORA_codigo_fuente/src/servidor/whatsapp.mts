// Avisos por WhatsApp a la cuenta maestra con la API de WhatsApp Cloud de Meta.
// Variables: WHATSAPP_TOKEN, WHATSAPP_NUMERO_ID (identificador del número emisor) y WHATSAPP_DESTINO
// (tu número con lada de país, sin "+", por ejemplo 5216691234567).
// Meta solo entrega texto libre si escribiste a ese número en las últimas 24 horas. Para avisar siempre,
// aprueba una plantilla con un parámetro de cuerpo y ponla en WHATSAPP_PLANTILLA (y su idioma en
// WHATSAPP_PLANTILLA_IDIOMA, por omisión es_MX).
import type { Dependencias } from "./contexto.mts";

export type ResultadoWhatsApp = "enviado" | "sin_configurar" | "fallido";

export async function avisarWhatsApp(deps: Dependencias, texto: string): Promise<ResultadoWhatsApp> {
  const token = deps.env("WHATSAPP_TOKEN");
  const numeroId = deps.env("WHATSAPP_NUMERO_ID");
  const destino = deps.env("WHATSAPP_DESTINO")?.replace(/\D/g, "");
  if (!token || !numeroId || !destino) return "sin_configurar";
  const plantilla = deps.env("WHATSAPP_PLANTILLA");
  const mensaje = plantilla
    ? {
        type: "template",
        template: {
          name: plantilla,
          language: { code: deps.env("WHATSAPP_PLANTILLA_IDIOMA") ?? "es_MX" },
          // Las plantillas no aceptan saltos de línea en los parámetros.
          components: [{ type: "body", parameters: [{ type: "text", text: texto.replace(/\s*\n+\s*/g, " · ").slice(0, 1000) }] }],
        },
      }
    : { type: "text", text: { preview_url: true, body: texto.slice(0, 4000) } };
  try {
    const respuesta = await deps.fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(numeroId)}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: destino, ...mensaje }),
    });
    if (!respuesta.ok) {
      console.error("WhatsApp respondió", respuesta.status, (await respuesta.text().catch(() => "")).slice(0, 300));
      return "fallido";
    }
    return "enviado";
  } catch (error) {
    console.error("No se pudo enviar el WhatsApp:", (error as Error).message);
    return "fallido";
  }
}
