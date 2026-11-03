import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { crearConekta } from "../src/servidor/pagos/conekta.mts";
import { crearEntorno, instalarSoporte, type Entorno } from "./base.mts";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const LLAVE_PUBLICA = publicKey.export({ type: "spki", format: "pem" }).toString();

function firmar(cuerpo: string) {
  const firmador = createSign("RSA-SHA256");
  firmador.update(cuerpo, "utf8");
  return firmador.sign(privateKey, "base64");
}

/** Conekta falsa: responde con la forma documentada y guarda lo que recibió. */
function conektaFalsa() {
  const llamadas: { url: string; init: RequestInit }[] = [];
  const ordenes = new Map<string, any>();
  const falsa: typeof fetch = async (entrada, init) => {
    const url = String(entrada);
    llamadas.push({ url, init: init ?? {} });
    if (init?.method === "POST" && url.endsWith("/orders")) {
      const cuerpo = JSON.parse(String(init.body));
      const id = `ord_${ordenes.size + 1}`;
      ordenes.set(id, { id, object: "order", amount: cuerpo.line_items[0].unit_price, currency: "MXN", payment_status: "pending_payment", metadata: cuerpo.metadata, customer_info: { customer_id: "cus_1" }, checkout: { url: `https://pay.conekta.io/checkout/${id}` }, charges: { data: [] } });
      return new Response(JSON.stringify(ordenes.get(id)), { status: 200 });
    }
    const coincide = /\/orders\/([^/]+)$/.exec(url);
    if (coincide && ordenes.has(coincide[1])) return new Response(JSON.stringify(ordenes.get(coincide[1])), { status: 200 });
    return new Response(JSON.stringify({ message: "no encontrado" }), { status: 404 });
  };
  return { falsa, llamadas, ordenes };
}

describe("integración con Conekta (con servidor falso)", () => {
  let e: Entorno;
  const conekta = conektaFalsa();

  before(async () => {
    e = await crearEntorno(
      {
        PAGOS_MODO: "conekta",
        VENTAS_ABIERTAS: "si",
        CONEKTA_LLAVE_PRIVADA: "key_prueba",
        CONEKTA_LLAVE_WEBHOOK: LLAVE_PUBLICA,
        CONEKTA_PLAN_PROFESIONAL_MENSUAL: "plan_pro_mensual",
      },
      { fetch: conekta.falsa },
    );
    await instalarSoporte(e);
  });
  after(async () => {
    await e.cerrar();
  });

  test("crea una orden con checkout hospedado y métodos correctos", async () => {
    const r = await e.llamar("POST", "/api/checkout", { plan: "profesional", ciclo: "mensual", email: "conekta@ejemplo.test", nombre_consultorio: "Con", nombre_medico: "Dra. Con", acepto_terminos: true });
    assert.equal(r.estado, 201);
    assert.match(r.datos.url, /^https:\/\/pay\.conekta\.io/);
    const llamada = conekta.llamadas.at(-1)!;
    const cuerpo = JSON.parse(String(llamada.init.body));
    assert.equal((llamada.init.headers as any).authorization, "Bearer key_prueba");
    assert.equal(cuerpo.checkout.type, "HostedPayment");
    assert.equal(cuerpo.line_items[0].unit_price, 54900);
    assert.ok(cuerpo.checkout.success_url.includes("/pago-exitoso.html#"));
    assert.deepEqual(cuerpo.checkout.excluded_payment_methods, ["bnpl"]);
    assert.equal(cuerpo.checkout.plan_ids, undefined);
  });

  test("con renovación automática usa el plan de Conekta y solo tarjeta", async () => {
    const r = await e.llamar("POST", "/api/checkout", { plan: "profesional", ciclo: "mensual", recurrente: true, email: "recurrente@ejemplo.test", nombre_consultorio: "Rec", nombre_medico: "Dra. Rec", acepto_terminos: true });
    assert.equal(r.estado, 201);
    const cuerpo = JSON.parse(String(conekta.llamadas.at(-1)!.init.body));
    assert.deepEqual(cuerpo.checkout.plan_ids, ["plan_pro_mensual"]);
    assert.ok(cuerpo.checkout.excluded_payment_methods.includes("cash"));
    assert.ok(cuerpo.checkout.excluded_payment_methods.includes("bank_transfer"));
  });

  test("rechaza un aviso sin firma o con firma de otra llave", async () => {
    const cuerpo = JSON.stringify({ id: "evt_1", type: "order.paid", data: { object: { id: "ord_1" } } });
    assert.equal((await e.llamar("POST", "/api/webhooks/pago", cuerpo)).estado, 401);
    const otra = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const firmador = createSign("RSA-SHA256");
    firmador.update(cuerpo, "utf8");
    const falsa = firmador.sign(otra.privateKey, "base64");
    assert.equal((await e.llamar("POST", "/api/webhooks/pago", cuerpo, undefined, { digest: falsa })).estado, 401);
  });

  test("un aviso auténtico de orden aún no pagada no activa", async () => {
    const cuerpo = JSON.stringify({ id: "evt_2", type: "order.paid", data: { object: { id: "ord_1" } } });
    const r = await e.llamar("POST", "/api/webhooks/pago", cuerpo, undefined, { digest: firmar(cuerpo) });
    assert.equal(r.estado, 200);
    assert.equal(r.datos.resultado, "ignorado");
    assert.equal((await e.pool.query(`SELECT 1 FROM consultorios WHERE contacto_email = 'conekta@ejemplo.test'`)).rowCount, 0);
  });

  test("un monto distinto al solicitado no activa", async () => {
    const orden = conekta.ordenes.get("ord_1");
    orden.payment_status = "paid";
    orden.amount = 100;
    const cuerpo = JSON.stringify({ id: "evt_3", type: "order.paid", data: { object: { id: "ord_1" } } });
    const r = await e.llamar("POST", "/api/webhooks/pago", cuerpo, undefined, { digest: firmar(cuerpo) });
    assert.equal(r.estado, 500);
    assert.equal((await e.pool.query(`SELECT 1 FROM consultorios WHERE contacto_email = 'conekta@ejemplo.test'`)).rowCount, 0);
    orden.amount = 54900;
  });

  test("un pago confirmado activa la cuenta y envía el enlace", async () => {
    const orden = conekta.ordenes.get("ord_1");
    orden.charges = { data: [{ payment_method: { type: "credit" } }] };
    const cuerpo = JSON.stringify({ id: "evt_4", type: "order.paid", data: { object: { id: "ord_1" } } });
    const r = await e.llamar("POST", "/api/webhooks/pago", cuerpo, undefined, { digest: firmar(cuerpo) });
    assert.equal(r.estado, 200);
    assert.equal(r.datos.resultado, "activada");
    assert.ok(e.correos.some((c) => c.para === "conekta@ejemplo.test" && c.texto.includes("#activar/")));
    const pago = await e.pool.query(`SELECT metodo, monto_centavos FROM pagos WHERE proveedor_orden = 'ord_1'`);
    assert.equal(pago.rows[0].metodo, "credit");
    assert.equal(pago.rows[0].monto_centavos, 54900);
  });

  test("el mismo aviso repetido no duplica nada", async () => {
    const cuerpo = JSON.stringify({ id: "evt_4", type: "order.paid", data: { object: { id: "ord_1" } } });
    const r = await e.llamar("POST", "/api/webhooks/pago", cuerpo, undefined, { digest: firmar(cuerpo) });
    assert.equal(r.datos.resultado, "duplicado");
    assert.equal((await e.pool.query(`SELECT 1 FROM pagos WHERE proveedor_orden = 'ord_1'`)).rowCount, 1);
  });

  test("un cargo automático de suscripción renueva por cliente de Conekta", async () => {
    conekta.ordenes.set("ord_ciclo2", { id: "ord_ciclo2", amount: 54900, currency: "MXN", payment_status: "paid", metadata: {}, customer_info: { customer_id: "cus_1" }, charges: { data: [{ payment_method: { type: "credit" } }] } });
    const antes = (await e.pool.query(`SELECT pagado_hasta FROM consultorios WHERE contacto_email = 'conekta@ejemplo.test'`)).rows[0].pagado_hasta;
    const cuerpo = JSON.stringify({ id: "evt_5", type: "subscription.paid", data: { object: { id: "sub_1", customer_id: "cus_1", last_billing_cycle_order_id: "ord_ciclo2", status: "active" } } });
    const r = await e.llamar("POST", "/api/webhooks/pago", cuerpo, undefined, { digest: firmar(cuerpo) });
    assert.equal(r.datos.resultado, "renovada");
    const despues = (await e.pool.query(`SELECT pagado_hasta FROM consultorios WHERE contacto_email = 'conekta@ejemplo.test'`)).rows[0].pagado_hasta;
    assert.ok(new Date(despues).getTime() > new Date(antes).getTime() + 25 * 86400000);
  });

  test("al cancelarse la suscripción la cuenta pasa a renovación manual", async () => {
    const cuerpo = JSON.stringify({ id: "evt_6", type: "subscription.canceled", data: { object: { id: "sub_1", customer_id: "cus_1", status: "canceled" } } });
    assert.equal((await e.llamar("POST", "/api/webhooks/pago", cuerpo, undefined, { digest: firmar(cuerpo) })).estado, 200);
    const fila = (await e.pool.query(`SELECT renovacion FROM consultorios WHERE contacto_email = 'conekta@ejemplo.test'`)).rows[0];
    assert.equal(fila.renovacion, "manual");
  });

  test("el proveedor exige plan configurado para cobro recurrente", async () => {
    const proveedor = crearConekta({ llavePrivada: "x", llaveWebhook: LLAVE_PUBLICA, planes: () => undefined, fetch: conekta.falsa });
    await assert.rejects(
      proveedor.crearCobro({ solicitudId: "s", concepto: "c", montoCentavos: 1, plan: "esencial", ciclo: "mensual", recurrente: true, cliente: { nombre: "n", email: "e@e.test" }, urlExito: "u", urlFallo: "u" }),
      /Falta el plan/,
    );
  });
});
