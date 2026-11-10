# NUVORA

Expediente clínico electrónico por consultorio, de NUVORA Health Technologies. El contenido clínico se cifra en el navegador: ni soporte ni el servidor pueden leerlo. Soporte solo ve el nombre del paciente, su última consulta y su última receta.

**Estado:** probado en un entorno local. No se ha desplegado, no se ha probado con Conekta real y no ha pasado revisión legal ni prueba de seguridad externa. No guardes pacientes reales hasta terminar la lista de abajo.

## Antes de recibir pacientes reales

1. Constituir NUVORA Health Technologies y completar los marcadores. Para encontrarlos: `grep -rn "por definir\|por completar" public/`.
2. Pedir a un abogado que revise `public/legal/`, y quitar el aviso de borrador de cada página.
3. Pedir a la OMS permiso de uso comercial de las tablas de crecimiento.
4. Hacer una prueba de seguridad externa y corregir lo que encuentre.
5. Activar el segundo factor obligatorio en el equipo de Netlify.
6. Probar Conekta en modo de prueba y luego con tarjetas reales, incluidas Toka y Broxel.
7. Hasta entonces, deja sin definir `VENTAS_ABIERTAS`. La página solo ofrecerá la lista de fundadores.

## Cómo está organizado

| Carpeta | Contenido |
|---|---|
| `netlify/functions/api.mts` | Función que atiende `/api/*` |
| `../netlify/database/migrations/` (raíz del repositorio) | Esquema, roles limitados y Row Level Security, una carpeta por versión. Es la copia que aplica Netlify |
| `src/servidor/` | Rutas, seguridad, planes y pagos |
| `public/` | Sitio estático, sin dependencias externas: venta, expediente, soporte y documentos legales |
| `public/js/cripto.js` | Cifrado en el navegador |
| `demo/` y `scripts/construir-demo.mjs` | Demostración con datos ficticios, sin servidor |
| `tests/` | Pruebas contra Postgres real y flujo completo en navegador |

## Correr en local

Requiere Node 20.12 o más reciente y Postgres. El dueño de la base debe poder crear roles.

```bash
npm ci
createdb sigilo_dev
for m in ../netlify/database/migrations/*/migration.sql; do psql sigilo_dev -f "$m"; done
SIGILO_DB_URL=postgres://usuario:clave@127.0.0.1:5432/sigilo_dev PUERTO=8899 npx tsx scripts/servidor-local.mts
```

Abre `http://localhost:8899`. Este servidor usa la pasarela simulada, así que no hace cobros. Para instalar el panel de soporte, abre `/soporte.html#instalar` con el token `token-local`.

## Pruebas

```bash
# Crea una base temporal por suite. Cambia la conexión con PRUEBAS_DB_ADMIN.
npm test

# Con el servidor local en marcha y una base recién creada:
CAPTURAS=capturas node tests/e2e/flujo-completo.mjs
```

La prueba en navegador usa Playwright, que no está en `package.json`: instálalo aparte si no lo tienes. Instala el panel de soporte en cada corrida, por eso necesita una base nueva.

## Desplegar en Netlify

1. Crea un proyecto nuevo. No uses el sitio de tu consultorio.
2. Activa Netlify Database. Las migraciones de `netlify/database/migrations/` en la raíz del repositorio se aplican al desplegar.
3. Define las variables de abajo.
4. Despliega primero una versión de prueba. Las versiones de prueba pueden tener acceso a datos, así que no las compartas una vez que haya información real.
5. Abre `/soporte.html#instalar`, escribe `SOPORTE_TOKEN_INSTALACION`, y guarda la contraseña y el segundo factor. Si se pierde esa contraseña, soporte ya no puede abrir los nombres.
6. Borra `SOPORTE_TOKEN_INSTALACION` al terminar.
7. En Conekta, registra el webhook `https://TU-DOMINIO/api/webhooks/pago` con los eventos `order.paid`, `subscription.paid`, `subscription.payment_failed` y `subscription.canceled`. Copia su llave pública a `CONEKTA_LLAVE_WEBHOOK`.
8. Crea en Conekta los planes para cobro automático: uno por plan y periodo.
9. Compra con tarjetas de prueba, activa una cuenta y revisa los correos.
10. Cuando todo lo anterior esté listo, define `VENTAS_ABIERTAS=si`.

### Variables

| Variable | Para qué | Valor |
|---|---|---|
| `SERVIDOR_CLAVE` | Cifra los secretos del segundo factor | Al menos 32 caracteres: `openssl rand -base64 48`. Márcala como secreta y no la cambies |
| `SOPORTE_TOKEN_INSTALACION` | Permite instalar el panel una vez | `openssl rand -hex 32`. Se borra después |
| `PAGOS_MODO` | Elige la pasarela | `conekta`. `simulado` se niega a correr en producción |
| `VENTAS_ABIERTAS` | Abre las ventas | `si`. Sin ella, solo funciona la lista de fundadores |
| `CONEKTA_LLAVE_PRIVADA` | Crea órdenes | Llave privada de Conekta |
| `CONEKTA_LLAVE_WEBHOOK` | Verifica los avisos | Llave pública de firma; los saltos de línea pueden ir como `\n` |
| `CONEKTA_PLAN_<PLAN>_<PERIODO>` | Cobro automático | Por ejemplo `CONEKTA_PLAN_PROFESIONAL_MENSUAL`. `<PLAN>`: `ESENCIAL`, `PROFESIONAL` o `CLINICA`. `<PERIODO>`: `MENSUAL` o `ANUAL` |
| `RESEND_API_KEY` | Envía correos | Llave de Resend |
| `CORREO_REMITENTE` | Remitente de los correos | `NUVORA <acceso@tu-dominio>`, con el dominio verificado |
| `URL_BASE` | Enlaces y origen permitido | `https://tu-dominio`, sin diagonal final |

## Lista de fundadores y origen de las ventas

La página es `/fundadores.html`. Un enlace de QR o de anuncio puede llevar su origen, por ejemplo `/fundadores.html?o=congreso-mazatlan-2026`. Solo se aceptan minúsculas, números y guiones. El administrador de soporte ve la lista y las altas por origen en **Métricas**.

## Prueba gratis de 3 meses

- Enlace de inscripción: `/prueba.html` (o `/prueba-gratis`). Con código incluido: `/prueba.html?codigo=NUV-XXXX-XXXX`.
- Solo entra quien tenga un código. Los códigos los genera la cuenta maestra (administrador de soporte) en **Pruebas gratis**, en `/soporte.html` o `/maestro`.
- Cada solicitud incluye las necesidades del consultorio y avisa por WhatsApp a la cuenta maestra. Nadie recibe acceso hasta que la cuenta maestra la autoriza; al autorizar se crea el consultorio con el plan elegido, gratis por 3 meses, y se envía el enlace de activación.
- Al terminar la prueba aplica el flujo normal: días de gracia, solo lectura y renovación con pago.
- El expediente de cada consultorio se abre en `/app.html` (o `/expediente`).

| Variable | Para qué |
|---|---|
| `WHATSAPP_TOKEN` | Token de acceso de la API de WhatsApp Cloud de Meta |
| `WHATSAPP_NUMERO_ID` | Identificador del número emisor (Phone number ID) |
| `WHATSAPP_DESTINO` | Tu número con lada de país, por ejemplo `5216691234567` |
| `WHATSAPP_PLANTILLA` | Opcional. Plantilla aprobada con un parámetro de cuerpo; sin ella, Meta solo entrega el aviso si le escribiste al número en las últimas 24 horas |
| `WHATSAPP_PLANTILLA_IDIOMA` | Opcional. Idioma de la plantilla; por omisión `es_MX` |

## Marca

El logotipo está en `public/img/` (completo e ícono) y las tipografías, Montserrat e Inter, en `public/fonts/` con sus licencias OFL. Los colores están en las variables de `public/css/sigilo.css`. El logotipo no lleva el símbolo ®: la marca aún no está registrada. Agrégalo solo cuando el IMPI conceda el registro; mientras tanto puedes usar ™.

## Si cambias algo

- Reconstruye la demostración con `npm run construir:demo`, porque `public/demo.html` y `public/js/demo.js` se generan.
- Mantén a `sigilo_soporte` sin acceso al contenido clínico. Las pruebas de `tests/privacidad.test.mts` deben seguir pasando.
- No agregues verificación de dosis sin opinión regulatoria: podría volver al sistema un dispositivo médico.

## Licencias de terceros

Las dependencias usan licencias MIT, ISC o Apache 2.0. Los avisos de `who-growth-standards` están en `public/js/vendor/`. Sus datos son de la OMS, que no avala este producto.
