// Empaqueta la demostración en una sola página, con datos ficticios y sin servidor.
// Salidas: dist/demo-artifact.html (fragmento para publicar) y public/demo.html + public/js/demo.js (para el sitio).
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

mkdirSync("dist", { recursive: true });
const { outputFiles } = await build({
  entryPoints: ["demo/entrada.js"],
  bundle: true,
  format: "iife",
  minify: true,
  write: false,
  target: "es2022",
  legalComments: "none",
});
const js = outputFiles[0].text;
const datos = (ruta, tipo) => `data:${tipo};base64,${readFileSync(ruta).toString("base64")}`;
// En la página única no hay carpeta de imágenes ni de tipografías: se incrustan.
const css = readFileSync("public/css/sigilo.css", "utf8").replace(/url\("\/fonts\/([^"]+)"\)/g, (_, f) => `url("${datos("public/fonts/" + f, "font/woff2")}")`);
const indice = readFileSync("public/index.html", "utf8");
const imagenes = (t) => t.replace(/src="\/img\/([^"]+)"/g, (_, f) => `src="${datos("public/img/" + f, "image/png")}"`);
const venta = /<div id="pagina-venta">([\s\S]*)<\/div>\s*<script type="module" src="\/js\/landing\.js">/.exec(indice)[1];

const cuerpo = `<div class="cinta-demo">
  <strong>Demostración con datos ficticios</strong>
  <div class="vistas" role="group" aria-label="Elegir vista">
    <button id="demo-b-venta" data-vista="venta" aria-pressed="false">Página de venta</button>
    <button id="demo-b-expediente" data-vista="expediente" aria-pressed="true">Expediente del médico</button>
    <button id="demo-b-soporte" data-vista="soporte" aria-pressed="false">Panel de soporte</button>
    <button id="demo-b-servidor" data-vista="servidor" aria-pressed="false">Lo que guarda el servidor</button>
  </div>
</div>
<div id="demo-venta" class="pagina" hidden>${venta}</div>
<div id="demo-expediente"><p class="contenido tenue" role="status">Preparando la demostración…</p></div>
<div id="demo-soporte" hidden></div>
<div id="demo-servidor" hidden></div>`;

// Los bloques de script no pueden contener la secuencia de cierre literal.
const jsSeguro = js.replace(/<\/script/gi, "<\\/script");
writeFileSync(
  "dist/demo-artifact.html",
  `<title>NUVORA: demostración</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>${css}</style>
${imagenes(cuerpo)}
<script>${imagenes(jsSeguro)}</script>
`,
);

writeFileSync("public/js/demo.js", js);
writeFileSync(
  "public/demo.html",
  `<!doctype html>
<html lang="es-MX">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NUVORA: demostración</title>
<link rel="stylesheet" href="/css/sigilo.css">
</head>
<body>
${cuerpo}
<script src="/js/demo.js"></script>
</body>
</html>
`,
);
console.log(`demo-artifact.html: ${(readFileSync("dist/demo-artifact.html").length / 1024).toFixed(0)} KB`);
