// Empaqueta los datos de la OMS para servirlos desde nuestro propio dominio, sin terceros.
import { copyFileSync } from "node:fs";
import { build } from "esbuild";

await build({
  entryPoints: ["node_modules/who-growth-standards/dist/index.js"],
  outfile: "public/js/vendor/who-growth.js",
  bundle: true,
  format: "esm",
  minify: true,
  legalComments: "none",
  banner: { js: "/* who-growth-standards 1.0.1, (c) 2026 Roman Koropets, licencia MIT: ver who-growth.LICENSE.txt. Tablas LMS de la OMS: ver who-growth.NOTICE.txt. */" },
});

// La licencia MIT pide conservar el aviso; los datos siguen siendo obra de la OMS.
copyFileSync("node_modules/who-growth-standards/LICENSE", "public/js/vendor/who-growth.LICENSE.txt");
copyFileSync("node_modules/who-growth-standards/NOTICE", "public/js/vendor/who-growth.NOTICE.txt");
