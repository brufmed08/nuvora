import type { Config, Context } from "@netlify/functions";
import { getDatabase } from "@netlify/database";
import { crearManejador } from "../../src/servidor/app.mts";

const db = getDatabase();

const manejar = crearManejador({
  pool: db.pool,
  env: (clave) => Netlify.env.get(clave),
  entorno: process.env.CONTEXT ?? "production",
  ahora: () => new Date(),
  fetch: globalThis.fetch,
  cookiesSeguras: true,
});

export default async (req: Request, context: Context) => manejar(req, { ip: context.ip });

export const config: Config = {
  path: "/api/*",
  rateLimit: {
    action: "rate_limit",
    aggregateBy: ["ip", "domain"],
    windowSize: 60,
    windowLimit: 600,
  },
};
