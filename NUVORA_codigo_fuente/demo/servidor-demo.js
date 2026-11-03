// Servidor en memoria para la demostración. Replica las reglas del servidor real con datos ficticios:
// recibe y guarda texto cifrado de verdad, y el panel de soporte recibe solo lo que recibe en producción.
import { ErrorApi } from "../public/js/api.js";
import * as cripto from "../public/js/cripto.js";

const PLANES = {
  esencial: { nombre: "Esencial", precios: { mensual: 34900, anual: 349000 }, medicos: 1, asistentes: 1, modulos: ["notas", "recetas", "marca", "exportar", "bitacora"] },
  profesional: { nombre: "Profesional", precios: { mensual: 54900, anual: 549000 }, medicos: 1, asistentes: 2, modulos: ["notas", "recetas", "marca", "exportar", "bitacora", "crecimiento", "familia"] },
  clinica: { nombre: "Clínica", precios: { mensual: 149000, anual: 1490000 }, medicos: 5, asistentes: 5, modulos: ["notas", "recetas", "marca", "exportar", "bitacora", "crecimiento", "familia"] },
};

const dias = (n) => new Date(Date.now() - n * 86400000).toISOString();
const fechaIso = (n) => dias(n).slice(0, 10);

export async function crearServidorDemo() {
  const par = await cripto.nuevoParSoporte();
  const tk = cripto.nuevaLlaveConsultorio();
  const llave = await cripto.importarLlaveConsultorio(tk);
  const ID_CONSULTORIO = "11111111-1111-4111-8111-111111111111";
  const ID_TITULAR = "22222222-2222-4222-8222-222222222222";
  const privadaSoporte = await cripto.importarPrivadaSoporte(par.privadaBytes);

  const consultorio = {
    id: ID_CONSULTORIO,
    nombre: "Consultorio de demostración",
    plan: "profesional",
    plan_nombre: "Profesional",
    ciclo: "mensual",
    estado: "activo",
    puede_escribir: true,
    renovacion: "automatica",
    pagado_hasta: new Date(Date.now() + 22 * 86400000).toISOString(),
    marca: { color_primario: "#447DC0", medico_nombre: "Dra. Elena Ejemplo", especialidad: "Pediatría", cedulas: "0000000 / 0000001", institucion: "Datos ficticios", domicilio: "Calle Ejemplo 123, Ciudad de muestra", telefono: "000 000 0000" },
    modulos: PLANES.profesional.modulos,
    limites: { medicos: 1, asistentes: 2 },
  };
  const otroConsultorio = { id: "33333333-3333-4333-8333-333333333333", nombre: "Clínica Ficticia del Norte", plan: "clinica", plan_nombre: "Clínica", ciclo: "anual", estado: "activo", pagado_hasta: new Date(Date.now() + 200 * 86400000).toISOString(), contacto_email: "contacto@clinica-ficticia.test", n_pacientes: 0 };

  const usuario = { id: ID_TITULAR, email: "elena@consultorio-ejemplo.test", nombre: "Dra. Elena Ejemplo", rol: "titular", cedula: "0000000", debe_cambiar: false };
  const usuarios = [{ ...usuario, ultimo_acceso: dias(0), creado_en: dias(120), desactivado_en: null }];
  const pacientes = [];
  const registros = [];
  const bitacora = [];
  const bitacoraSoporte = [];
  const pagos = [
    { monto_centavos: 54900, moneda: "MXN", metodo: "credit", periodo_hasta: new Date(Date.now() + 22 * 86400000).toISOString(), pagado_en: dias(8), cfdi_estado: "emitido" },
    { monto_centavos: 54900, moneda: "MXN", metodo: "bank_transfer", periodo_hasta: dias(8), pagado_en: dias(38), cfdi_estado: "emitido" },
  ];

  const registrarBitacora = (accion, en = new Date().toISOString(), nombre = usuario.nombre) => bitacora.unshift({ accion, en, usuario: nombre });

  async function sembrarPaciente(datos) {
    const id = cripto.nuevoId();
    const nombre = [datos.nombres, datos.apellido1, datos.apellido2].filter(Boolean).join(" ");
    pacientes.push({
      id,
      cifrado: await cripto.cifrarJson(llave, datos, cripto.contexto(ID_CONSULTORIO, "paciente", id)),
      nombre_sellado: await cripto.sellarNombre(par.publica, nombre),
      ultima_consulta_en: null,
      ultima_receta_en: null,
      creado_en: dias(100),
      actualizado_en: dias(100),
    });
    return id;
  }

  async function sembrarRegistro(pacienteId, tipo, contenido, hace, idFijo) {
    const id = idFijo ?? cripto.nuevoId();
    const creado = dias(hace);
    registros.push({
      id,
      paciente_id: pacienteId,
      tipo,
      cifrado: await cripto.cifrarJson(llave, contenido, cripto.contexto(ID_CONSULTORIO, tipo, id)),
      autor_id: ID_TITULAR,
      sello: Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join(""),
      anulado_en: null,
      creado_en: creado,
    });
    const p = pacientes.find((x) => x.id === pacienteId);
    if (tipo === "consulta" && (!p.ultima_consulta_en || creado > p.ultima_consulta_en)) p.ultima_consulta_en = creado;
    if (tipo === "receta" && (!p.ultima_receta_en || creado > p.ultima_receta_en)) p.ultima_receta_en = creado;
    return id;
  }

  const autor = { autor_nombre: "Dra. Elena Ejemplo", autor_cedula: "0000000" };

  async function visita(pacienteId, hace, nota, medidas, medicamentos) {
    const signos = { ...medidas };
    const idNota = await sembrarRegistro(pacienteId, "consulta", { ...autor, ...nota, signos }, hace);
    if (medicamentos) {
      await sembrarRegistro(pacienteId, "receta", { ...autor, consulta_id: idNota, medicamentos, diagnostico: nota.diagnosticos, indicaciones: nota.plan, peso: medidas.peso }, hace);
    }
    if (medidas.peso || medidas.talla || medidas.pc) {
      await sembrarRegistro(pacienteId, "somatometria", { peso: medidas.peso, talla: medidas.talla, pc: medidas.pc, fecha: dias(hace) }, hace);
    }
  }

  // Paciente con antecedente de prematurez, para ver la edad corregida en la curva.
  const mateo = await sembrarPaciente({ nombres: "Mateo", apellido1: "Castro", apellido2: "Núñez", nacimiento: fechaIso(300), sexo: "M", semanas: "33", tutor: "Lucía Núñez", telefono: "000 111 2222", alergias: "", antecedentes: "Prematuro de 33 semanas, sin ventilación mecánica." });
  await visita(mateo, 270, { motivo: "Primera consulta tras el alta", evolucion: "Alimentación con leche materna y fórmula de transición.", exploracion: "Activo, reactivo, sin datos de dificultad respiratoria.", diagnosticos: "Recién nacido prematuro en seguimiento", plan: "Vigilar ganancia de peso." }, { peso: "2.45", talla: "45.5", pc: "32.5" });
  await visita(mateo, 210, { motivo: "Control de crecimiento", evolucion: "Buen apetito, sin vómito.", exploracion: "Sin alteraciones.", diagnosticos: "Crecimiento adecuado para edad corregida", plan: "Continuar lactancia." }, { peso: "4.30", talla: "53.0", pc: "37.0" });
  await visita(mateo, 150, { motivo: "Control de crecimiento", evolucion: "Sostiene la cabeza.", exploracion: "Sin alteraciones.", diagnosticos: "Crecimiento adecuado para edad corregida", plan: "Vitamina D, seguimiento en dos meses." }, { peso: "5.80", talla: "59.5", pc: "40.0" }, [{ nombre: "Colecalciferol", presentacion: "gotas 400 UI/ml", dosis: "1 ml", via: "oral", frecuencia: "cada 24 horas", duracion: "60 días" }]);
  await visita(mateo, 90, { motivo: "Control de crecimiento", evolucion: "Inicia alimentación complementaria.", exploracion: "Sin alteraciones.", diagnosticos: "Crecimiento adecuado para edad corregida", plan: "Orientación alimentaria." }, { peso: "7.10", talla: "65.0", pc: "42.5" });
  await visita(mateo, 12, { motivo: "Control de crecimiento", evolucion: "Se sienta sin apoyo.", exploracion: "Sin alteraciones.", diagnosticos: "Crecimiento adecuado para edad corregida", plan: "Continuar seguimiento." }, { peso: "8.25", talla: "70.5", pc: "44.5" });

  const valeria = await sembrarPaciente({ nombres: "Valeria", apellido1: "Mendoza", apellido2: "Ruiz", nacimiento: fechaIso(830), sexo: "F", tutor: "Andrea Ruiz", telefono: "000 333 4444", alergias: "Penicilina", antecedentes: "Sin hospitalizaciones." });
  await visita(valeria, 5, { motivo: "Tos y fiebre de dos días", evolucion: "Fiebre de hasta 38.5 °C, buena tolerancia a líquidos.", exploracion: "Faringe hiperémica, sin dificultad respiratoria.", diagnosticos: "Faringoamigdalitis aguda", plan: "Líquidos abundantes y vigilar signos de alarma." }, { peso: "12.4", talla: "88.0", pc: "47.5", temperatura: "38.1", sat: "97" }, [{ nombre: "Paracetamol", presentacion: "suspensión 160 mg/5 ml", dosis: "5.5 ml", via: "oral", frecuencia: "cada 6 horas si hay fiebre", duracion: "3 días" }]);

  for (const [nombres, apellido1, apellido2, nacDias, sexo, hace] of [
    ["Regina", "Soto", "Ibarra", 1500, "F", 21],
    ["Emiliano", "Torres", "Vega", 95, "M", 3],
    ["Camila", "Rojas", "León", 640, "F", 44],
    ["Diego", "Salas", "Ortega", 1100, "M", 67],
  ]) {
    const id = await sembrarPaciente({ nombres, apellido1, apellido2, nacimiento: fechaIso(nacDias), sexo, tutor: "Responsable de ejemplo" });
    await visita(id, hace, { motivo: "Control del niño sano", evolucion: "Sin síntomas.", exploracion: "Sin alteraciones.", diagnosticos: "Niño sano", plan: "Cita de seguimiento." }, {});
  }

  registrarBitacora("cuenta_pagada", dias(120));
  registrarBitacora("marca_actualizada", dias(119));
  registrarBitacora("consulta_creada", dias(5));
  registrarBitacora("receta_creada", dias(5));
  bitacoraSoporte.unshift({ accion: "consulto_lista_de_pacientes", motivo: "Ticket 118: la doctora pidió confirmar que su última consulta se guardó", soporte_nombre: "Agente de ejemplo", en: dias(2) });

  const resumen = () => ({ ...consultorio });
  const sesion = () => ({ usuario, consultorio: resumen(), kdf_sal: "", kdf_iter: 0, tk_envuelta: "" });
  const contactoDemo = "elena@consultorio-ejemplo.test";

  const rutas = [
    ["GET", /^\/api\/config$/, () => ({ soporte_llave_publica: par.publica, pagos_modo: "demo", planes: PLANES })],
    ["GET", /^\/api\/sesion$/, () => sesion()],
    ["POST", /^\/api\/auth\/salir$/, () => ({ ok: true })],
    ["GET", /^\/api\/consultorio$/, () => ({ consultorio: resumen() })],
    [
      "PUT",
      /^\/api\/consultorio$/,
      (_, c) => {
        consultorio.nombre = c.nombre;
        consultorio.marca = c.marca;
        registrarBitacora("marca_actualizada");
        return { consultorio: resumen() };
      },
    ],
    ["PUT", /^\/api\/recuperacion$/, () => ({ ok: true })],
    ["GET", /^\/api\/usuarios$/, () => ({ usuarios })],
    [
      "POST",
      /^\/api\/usuarios$/,
      (_, c) => {
        const limite = c.rol === "medico" ? consultorio.limites.medicos : consultorio.limites.asistentes;
        const actuales = usuarios.filter((u) => !u.desactivado_en && (c.rol === "medico" ? u.rol !== "asistente" : u.rol === "asistente")).length;
        if (actuales >= limite) throw new ErrorApi(403, "limite_plan", "Tu plan no incluye más usuarios de ese rol.");
        const u = { id: cripto.nuevoId(), email: c.email, nombre: c.nombre, rol: c.rol, cedula: c.cedula, debe_cambiar: true, desactivado_en: null, ultimo_acceso: null, creado_en: new Date().toISOString() };
        usuarios.push(u);
        registrarBitacora("usuario_creado");
        return { usuario: u };
      },
    ],
    [
      "PATCH",
      /^\/api\/usuarios\/([^/]+)$/,
      ([id], c) => {
        const u = usuarios.find((x) => x.id === id);
        if (c.desactivar) u.desactivado_en = new Date().toISOString();
        else if (c.activar) u.desactivado_en = null;
        registrarBitacora(c.desactivar ? "usuario_desactivado" : c.activar ? "usuario_reactivado" : "contrasena_restablecida");
        return { ok: true };
      },
    ],
    ["GET", /^\/api\/pacientes(\?.*)?$/, () => ({ pacientes: pacientes.map(({ nombre_sellado, ...p }) => p), siguiente: null })],
    [
      "POST",
      /^\/api\/pacientes$/,
      (_, c) => {
        const ahora = new Date().toISOString();
        const fila = { id: c.id, cifrado: c.cifrado, nombre_sellado: c.nombre_sellado, ultima_consulta_en: null, ultima_receta_en: null, creado_en: ahora, actualizado_en: ahora };
        pacientes.push(fila);
        registrarBitacora("paciente_creado");
        const { nombre_sellado, ...publico } = fila;
        return { paciente: publico };
      },
    ],
    [
      "PUT",
      /^\/api\/pacientes\/([^/]+)$/,
      ([id], c) => {
        const p = pacientes.find((x) => x.id === id);
        p.cifrado = c.cifrado;
        p.nombre_sellado = c.nombre_sellado;
        p.actualizado_en = new Date().toISOString();
        registrarBitacora("paciente_actualizado");
        const { nombre_sellado, ...publico } = p;
        return { paciente: publico };
      },
    ],
    [
      "GET",
      /^\/api\/pacientes\/([^/]+)\/registros$/,
      ([id]) => {
        registrarBitacora("expediente_abierto");
        return { registros: registros.filter((r) => r.paciente_id === id).sort((a, b) => (a.creado_en < b.creado_en ? 1 : -1)) };
      },
    ],
    [
      "POST",
      /^\/api\/pacientes\/([^/]+)\/registros$/,
      ([id], c) => {
        const ahora = new Date().toISOString();
        const creados = c.registros.map((r) => {
          const fila = { ...r, paciente_id: id, autor_id: ID_TITULAR, sello: cripto.nuevoId().replace(/-/g, ""), anulado_en: null, creado_en: ahora };
          registros.push(fila);
          const p = pacientes.find((x) => x.id === id);
          if (r.tipo === "consulta") p.ultima_consulta_en = ahora;
          if (r.tipo === "receta") p.ultima_receta_en = ahora;
          registrarBitacora(`${r.tipo}_creada`);
          return fila;
        });
        return { registros: creados };
      },
    ],
    [
      "POST",
      /^\/api\/registros\/([^/]+)\/anular$/,
      ([id]) => {
        registros.find((r) => r.id === id).anulado_en = new Date().toISOString();
        registrarBitacora("registro_anulado");
        return { ok: true };
      },
    ],
    ["POST", /^\/api\/familia$/, () => (registrarBitacora("enlace_familia_creado"), { ok: true })],
    ["GET", /^\/api\/bitacora$/, () => ({ internos: bitacora.slice(0, 200), soporte: bitacoraSoporte })],
    ["GET", /^\/api\/cuenta$/, () => ({ consultorio: resumen(), pagos, datos_fiscales: null })],
    [
      "POST",
      /^\/api\/cuenta\/renovar$/,
      () => {
        throw new ErrorApi(400, "demo", "En esta demostración no se realizan cobros.");
      },
    ],
    [
      "GET",
      /^\/api\/soporte\/consultorios(\?.*)?$/,
      (_, __, ruta) => {
        const q = decodeURIComponent(new URLSearchParams(ruta.split("?")[1] ?? "").get("q") ?? "").toLowerCase();
        const propio = { id: ID_CONSULTORIO, nombre: consultorio.nombre, plan: consultorio.plan, plan_nombre: consultorio.plan_nombre, ciclo: consultorio.ciclo, estado: consultorio.estado, pagado_hasta: consultorio.pagado_hasta, contacto_email: contactoDemo, n_pacientes: pacientes.length };
        return { consultorios: [propio, otroConsultorio].filter((c) => `${c.nombre} ${c.contacto_email}`.toLowerCase().includes(q)) };
      },
    ],
    [
      "POST",
      /^\/api\/soporte\/consultorios\/([^/]+)\/pacientes$/,
      ([id], c) => {
        if (!c.motivo || c.motivo.trim().length < 5) throw new ErrorApi(400, "dato_invalido", "Motivo: escribe al menos 5 caracteres.");
        if (id !== ID_CONSULTORIO) {
          return { pacientes: [] };
        }
        bitacoraSoporte.unshift({ accion: "consulto_lista_de_pacientes", motivo: c.motivo, soporte_nombre: "Agente de ejemplo", en: new Date().toISOString() });
        return { pacientes: pacientes.map((p) => ({ id: p.id, nombre_sellado: p.nombre_sellado, ultima_consulta_en: p.ultima_consulta_en, ultima_receta_en: p.ultima_receta_en })) };
      },
    ],
    ["GET", /^\/api\/soporte\/metricas$/, () => ({ activos: 2, total: 2, ingreso_mensual_recurrente_centavos: 54900 + Math.round(1490000 / 12), pagos: [{ mes: dias(8).slice(0, 7), pagos: 1, centavos: 54900 }, { mes: dias(38).slice(0, 7), pagos: 2, centavos: 54900 + 1490000 }], altas_por_origen: [{ origen: "colega", altas: 1 }, { origen: "congreso-ejemplo", altas: 1 }], fundadores: 1 })],
    ["GET", /^\/api\/soporte\/fundadores$/, () => ({ fundadores: [{ nombre: "Dra. Ejemplo Ficticia", email: "dra.ejemplo@ejemplo.test", especialidad: "Pediatría", ciudad: "Ciudad de ejemplo", origen: "congreso-ejemplo", creado_en: dias(12) }] })],
    ["POST", /^\/api\/soporte\/salir$/, () => ({ ok: true })],
  ];

  async function atender(metodo, ruta, cuerpo) {
    for (const [m, patron, trabajo] of rutas) {
      if (m !== metodo) continue;
      const coincidencia = patron.exec(ruta);
      if (coincidencia) {
        const copia = cuerpo === undefined ? undefined : JSON.parse(JSON.stringify(cuerpo));
        return JSON.parse(JSON.stringify(trabajo(coincidencia.slice(1), copia, ruta)));
      }
    }
    throw new ErrorApi(404, "no_encontrado", "Esta función no está disponible en la demostración.");
  }

  return {
    atender,
    sesion,
    tk,
    privadaSoporte,
    usuarioSoporte: { id: "agente", email: "agente@ejemplo.test", nombre: "Agente de ejemplo", rol: "administrador", debe_cambiar: false },
    tablas: () => ({ pacientes, registros }),
  };
}
