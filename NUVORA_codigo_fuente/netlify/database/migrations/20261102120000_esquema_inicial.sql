-- NUVORA: esquema inicial.
--
-- Tres muros independientes protegen los expedientes:
--   1. El contenido clínico llega cifrado desde el navegador; el servidor nunca tiene la llave.
--   2. Roles de base de datos separados: cuentas, clinico y soporte. Ninguno puede saltarse RLS.
--   3. Row Level Security (forzada) aísla cada consultorio, incluso si hay un error en el código.
--
-- El servidor ejecuta cada transacción con SET LOCAL ROLE a uno de estos roles.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sigilo_cuentas') THEN
    CREATE ROLE sigilo_cuentas NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sigilo_clinico') THEN
    CREATE ROLE sigilo_clinico NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sigilo_soporte') THEN
    CREATE ROLE sigilo_soporte NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT sigilo_cuentas, sigilo_clinico, sigilo_soporte TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO sigilo_cuentas, sigilo_clinico, sigilo_soporte;

-- Contexto de cada transacción
CREATE FUNCTION sigilo_consultorio_actual() RETURNS uuid
  LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('sigilo.consultorio', true), '')::uuid $$;

CREATE FUNCTION sigilo_consultorio_soporte() RETURNS uuid
  LANGUAGE sql STABLE AS
  $$ SELECT NULLIF(current_setting('sigilo.consultorio_soporte', true), '')::uuid $$;

-- ---------------------------------------------------------------------------
-- Cuentas
-- ---------------------------------------------------------------------------

CREATE TABLE consultorios (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre              text NOT NULL CHECK (char_length(nombre) BETWEEN 1 AND 160),
  plan                text NOT NULL CHECK (plan IN ('esencial', 'profesional', 'clinica')),
  ciclo               text NOT NULL CHECK (ciclo IN ('mensual', 'anual')),
  estado              text NOT NULL DEFAULT 'pendiente_activacion'
                        CHECK (estado IN ('pendiente_activacion', 'activo', 'gracia', 'solo_lectura', 'cancelado')),
  renovacion          text NOT NULL DEFAULT 'manual' CHECK (renovacion IN ('manual', 'automatica')),
  pagado_hasta        timestamptz,
  contacto_email      text NOT NULL,
  marca               jsonb NOT NULL DEFAULT '{}'::jsonb,
  datos_fiscales      jsonb,
  proveedor_cliente   text,
  n_pacientes         integer NOT NULL DEFAULT 0,
  ultima_actividad_en timestamptz,
  creado_en           timestamptz NOT NULL DEFAULT now(),
  actualizado_en      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consultorios_nombre_idx ON consultorios (lower(nombre));
CREATE INDEX consultorios_email_idx ON consultorios (lower(contacto_email));
CREATE INDEX consultorios_proveedor_idx ON consultorios (proveedor_cliente);

CREATE TABLE usuarios (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultorio_id uuid NOT NULL REFERENCES consultorios (id),
  email          text NOT NULL UNIQUE CHECK (email = lower(email)),
  nombre         text NOT NULL CHECK (char_length(nombre) BETWEEN 1 AND 160),
  rol            text NOT NULL CHECK (rol IN ('titular', 'medico', 'asistente')),
  cedula         text,
  kdf_sal        text,
  kdf_iter       integer,
  auth_hash      text,
  tk_envuelta    text,
  debe_cambiar   boolean NOT NULL DEFAULT false,
  desactivado_en timestamptz,
  ultimo_acceso  timestamptz,
  creado_en      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usuarios_consultorio_idx ON usuarios (consultorio_id);

-- Copia de la llave del consultorio, abrible solo con el código de recuperación del titular.
CREATE TABLE recuperacion (
  consultorio_id   uuid PRIMARY KEY REFERENCES consultorios (id),
  rec_auth_hash    text NOT NULL,
  tk_envuelta_rec  text NOT NULL,
  actualizado_en   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sesiones (
  token_hash     text PRIMARY KEY,
  usuario_id     uuid NOT NULL REFERENCES usuarios (id),
  consultorio_id uuid NOT NULL REFERENCES consultorios (id),
  expira_en      timestamptz NOT NULL,
  creado_en      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sesiones_usuario_idx ON sesiones (usuario_id);

CREATE TABLE activaciones (
  token_hash     text PRIMARY KEY,
  consultorio_id uuid NOT NULL REFERENCES consultorios (id),
  usuario_id     uuid NOT NULL REFERENCES usuarios (id),
  tipo           text NOT NULL DEFAULT 'activacion' CHECK (tipo IN ('activacion', 'recuperacion')),
  expira_en      timestamptz NOT NULL,
  usado_en       timestamptz,
  creado_en      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE intentos_acceso (
  clave           text PRIMARY KEY,
  fallos          integer NOT NULL DEFAULT 0,
  bloqueado_hasta timestamptz,
  actualizado_en  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Cobro
-- ---------------------------------------------------------------------------

CREATE TABLE solicitudes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo              text NOT NULL DEFAULT 'alta' CHECK (tipo IN ('alta', 'renovacion')),
  email             text NOT NULL,
  nombre_consultorio text NOT NULL,
  nombre_medico     text NOT NULL,
  telefono          text,
  plan              text NOT NULL CHECK (plan IN ('esencial', 'profesional', 'clinica')),
  ciclo             text NOT NULL CHECK (ciclo IN ('mensual', 'anual')),
  recurrente        boolean NOT NULL DEFAULT false,
  monto_centavos    integer NOT NULL CHECK (monto_centavos > 0),
  proveedor         text NOT NULL,
  proveedor_orden   text UNIQUE,
  token_hash        text NOT NULL,
  datos_fiscales    jsonb,
  origen            text,
  acepto_terminos_en timestamptz NOT NULL,
  estado            text NOT NULL DEFAULT 'creada' CHECK (estado IN ('creada', 'pagada', 'expirada')),
  consultorio_id    uuid REFERENCES consultorios (id),
  creado_en         timestamptz NOT NULL DEFAULT now(),
  pagada_en         timestamptz
);

CREATE TABLE pagos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultorio_id uuid NOT NULL REFERENCES consultorios (id),
  solicitud_id   uuid REFERENCES solicitudes (id),
  proveedor      text NOT NULL,
  proveedor_orden text NOT NULL,
  monto_centavos integer NOT NULL CHECK (monto_centavos > 0),
  moneda         text NOT NULL DEFAULT 'MXN',
  metodo         text,
  periodo_hasta  timestamptz NOT NULL,
  cfdi_estado    text NOT NULL DEFAULT 'pendiente' CHECK (cfdi_estado IN ('pendiente', 'emitido', 'no_requerido')),
  pagado_en      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proveedor, proveedor_orden)
);
CREATE INDEX pagos_consultorio_idx ON pagos (consultorio_id, pagado_en DESC);

-- Cada aviso del proveedor se procesa una sola vez, aunque llegue repetido.
CREATE TABLE eventos_pago (
  proveedor   text NOT NULL,
  evento_id   text NOT NULL,
  tipo        text NOT NULL,
  recibido_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proveedor, evento_id)
);

-- ---------------------------------------------------------------------------
-- Datos clínicos: todo el contenido viaja y se guarda cifrado con la llave del consultorio.
-- ---------------------------------------------------------------------------

CREATE TABLE pacientes (
  id                 uuid PRIMARY KEY,
  consultorio_id     uuid NOT NULL REFERENCES consultorios (id),
  cifrado            text NOT NULL,
  nombre_sellado     text,
  ultima_consulta_en timestamptz,
  ultima_receta_en   timestamptz,
  archivado_en       timestamptz,
  creado_en          timestamptz NOT NULL DEFAULT now(),
  actualizado_en     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pacientes_consultorio_idx ON pacientes (consultorio_id);

CREATE TABLE registros (
  id             uuid PRIMARY KEY,
  secuencia      bigserial NOT NULL,
  consultorio_id uuid NOT NULL REFERENCES consultorios (id),
  paciente_id    uuid NOT NULL REFERENCES pacientes (id),
  tipo           text NOT NULL CHECK (tipo IN ('consulta', 'receta', 'somatometria', 'desarrollo', 'vacuna', 'documento')),
  cifrado        text NOT NULL,
  autor_id       uuid NOT NULL REFERENCES usuarios (id),
  sello          text NOT NULL DEFAULT '',
  anulado_en     timestamptz,
  anulado_por    uuid REFERENCES usuarios (id),
  creado_en      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX registros_paciente_idx ON registros (paciente_id, secuencia);

-- El servidor fija la hora y encadena un sello: una nota no se puede alterar sin que se note.
CREATE FUNCTION registros_antes_de_insertar() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  previo text;
BEGIN
  NEW.creado_en := now();
  NEW.anulado_en := NULL;
  NEW.anulado_por := NULL;
  PERFORM 1 FROM pacientes
    WHERE id = NEW.paciente_id AND consultorio_id = NEW.consultorio_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'paciente_no_encontrado' USING ERRCODE = 'P0002';
  END IF;
  SELECT sello INTO previo FROM registros
    WHERE paciente_id = NEW.paciente_id ORDER BY secuencia DESC LIMIT 1;
  NEW.sello := encode(
    sha256(convert_to(coalesce(previo, '') || NEW.id::text || NEW.tipo || NEW.cifrado, 'UTF8')),
    'hex'
  );
  RETURN NEW;
END
$$;

CREATE TRIGGER registros_sello BEFORE INSERT ON registros
  FOR EACH ROW EXECUTE FUNCTION registros_antes_de_insertar();

-- Lo único que soporte verá de la actividad se actualiza aquí, sin depender del navegador.
CREATE FUNCTION registros_actualizar_actividad() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tipo = 'consulta' THEN
    UPDATE pacientes SET ultima_consulta_en = NEW.creado_en WHERE id = NEW.paciente_id;
  ELSIF NEW.tipo = 'receta' THEN
    UPDATE pacientes SET ultima_receta_en = NEW.creado_en WHERE id = NEW.paciente_id;
  END IF;
  UPDATE consultorios SET ultima_actividad_en = NEW.creado_en WHERE id = NEW.consultorio_id;
  RETURN NULL;
END
$$;

CREATE TRIGGER registros_actividad AFTER INSERT ON registros
  FOR EACH ROW EXECUTE FUNCTION registros_actualizar_actividad();

CREATE FUNCTION pacientes_contar() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  UPDATE consultorios SET n_pacientes = n_pacientes + 1, ultima_actividad_en = now()
    WHERE id = NEW.consultorio_id;
  RETURN NULL;
END
$$;

CREATE TRIGGER pacientes_conteo AFTER INSERT ON pacientes
  FOR EACH ROW EXECUTE FUNCTION pacientes_contar();

-- Enlaces para la familia: el contenido se cifra con una llave que solo viaja en el enlace.
CREATE TABLE enlaces_familia (
  id             uuid PRIMARY KEY,
  consultorio_id uuid NOT NULL REFERENCES consultorios (id),
  paciente_id    uuid NOT NULL REFERENCES pacientes (id),
  cifrado        text NOT NULL,
  expira_en      timestamptz NOT NULL,
  revocado_en    timestamptz,
  descargas      integer NOT NULL DEFAULT 0,
  creado_por     uuid NOT NULL REFERENCES usuarios (id),
  creado_en      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX enlaces_paciente_idx ON enlaces_familia (paciente_id);

-- ---------------------------------------------------------------------------
-- Bitácoras: solo se agregan renglones, nunca se editan ni se borran.
-- ---------------------------------------------------------------------------

CREATE TABLE bitacora (
  id             bigserial PRIMARY KEY,
  consultorio_id uuid NOT NULL REFERENCES consultorios (id),
  usuario_id     uuid REFERENCES usuarios (id),
  accion         text NOT NULL,
  entidad_id     uuid,
  en             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bitacora_consultorio_idx ON bitacora (consultorio_id, en DESC);

CREATE TABLE soporte_usuarios (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE CHECK (email = lower(email)),
  nombre         text NOT NULL,
  rol            text NOT NULL CHECK (rol IN ('agente', 'administrador')),
  kdf_sal        text NOT NULL,
  kdf_iter       integer NOT NULL,
  auth_hash      text NOT NULL,
  llave_envuelta text NOT NULL,
  totp_cifrado   text NOT NULL,
  debe_cambiar   boolean NOT NULL DEFAULT false,
  desactivado_en timestamptz,
  ultimo_acceso  timestamptz,
  creado_en      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE soporte_sesiones (
  token_hash text PRIMARY KEY,
  soporte_id uuid NOT NULL REFERENCES soporte_usuarios (id),
  expira_en  timestamptz NOT NULL,
  creado_en  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bitacora_soporte (
  id             bigserial PRIMARY KEY,
  consultorio_id uuid NOT NULL REFERENCES consultorios (id),
  soporte_id     uuid NOT NULL REFERENCES soporte_usuarios (id),
  soporte_nombre text NOT NULL,
  accion         text NOT NULL,
  motivo         text NOT NULL CHECK (char_length(motivo) BETWEEN 5 AND 300),
  en             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bitacora_soporte_consultorio_idx ON bitacora_soporte (consultorio_id, en DESC);

CREATE TABLE plataforma (
  clave text PRIMARY KEY,
  valor text NOT NULL
);

-- Médicos que pidieron aviso de la apertura. No contiene ningún dato de pacientes.
CREATE TABLE lista_fundadores (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL UNIQUE,
  nombre          text NOT NULL,
  especialidad    text,
  ciudad          text,
  origen          text,
  acepto_aviso_en timestamptz NOT NULL,
  creado_en       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Permisos por rol. Lo que no aparece aquí está prohibido.
-- ---------------------------------------------------------------------------

-- CUENTAS: alta, acceso, cobro y enlaces públicos. No puede leer pacientes ni notas.
GRANT SELECT, INSERT, UPDATE ON consultorios TO sigilo_cuentas;
GRANT SELECT, INSERT, UPDATE ON usuarios TO sigilo_cuentas;
GRANT SELECT, INSERT, UPDATE ON recuperacion TO sigilo_cuentas;
GRANT SELECT, INSERT, DELETE ON sesiones TO sigilo_cuentas;
GRANT SELECT, INSERT, UPDATE ON activaciones TO sigilo_cuentas;
GRANT SELECT, INSERT, UPDATE, DELETE ON intentos_acceso TO sigilo_cuentas;
GRANT SELECT, INSERT, UPDATE ON solicitudes TO sigilo_cuentas;
GRANT SELECT, INSERT ON pagos TO sigilo_cuentas;
GRANT SELECT, INSERT ON eventos_pago TO sigilo_cuentas;
GRANT SELECT (id, consultorio_id, cifrado, expira_en, revocado_en, descargas) ON enlaces_familia TO sigilo_cuentas;
GRANT UPDATE (descargas) ON enlaces_familia TO sigilo_cuentas;
GRANT INSERT ON bitacora TO sigilo_cuentas;
GRANT USAGE ON SEQUENCE bitacora_id_seq TO sigilo_cuentas;
GRANT SELECT, INSERT, UPDATE ON soporte_usuarios TO sigilo_cuentas;
GRANT SELECT, INSERT, DELETE ON soporte_sesiones TO sigilo_cuentas;
GRANT SELECT, INSERT, UPDATE ON plataforma TO sigilo_cuentas;
GRANT SELECT, INSERT ON lista_fundadores TO sigilo_cuentas;

-- CLINICO: el trabajo diario del consultorio, siempre limitado a su propio consultorio.
GRANT SELECT ON consultorios TO sigilo_clinico;
GRANT UPDATE (nombre, marca, datos_fiscales, n_pacientes, ultima_actividad_en, actualizado_en) ON consultorios TO sigilo_clinico;
GRANT SELECT (id, consultorio_id, email, nombre, rol, cedula, debe_cambiar, desactivado_en, ultimo_acceso, creado_en) ON usuarios TO sigilo_clinico;
GRANT INSERT (id, consultorio_id, email, nombre, rol, cedula, kdf_sal, kdf_iter, auth_hash, tk_envuelta, debe_cambiar) ON usuarios TO sigilo_clinico;
GRANT UPDATE (nombre, cedula, kdf_sal, kdf_iter, auth_hash, tk_envuelta, debe_cambiar, desactivado_en) ON usuarios TO sigilo_clinico;
GRANT SELECT, INSERT ON pacientes TO sigilo_clinico;
GRANT UPDATE (cifrado, nombre_sellado, archivado_en, actualizado_en, ultima_consulta_en, ultima_receta_en) ON pacientes TO sigilo_clinico;
GRANT SELECT, INSERT ON registros TO sigilo_clinico;
GRANT UPDATE (anulado_en, anulado_por) ON registros TO sigilo_clinico;
GRANT USAGE ON SEQUENCE registros_secuencia_seq TO sigilo_clinico;
GRANT SELECT, INSERT ON enlaces_familia TO sigilo_clinico;
GRANT UPDATE (revocado_en) ON enlaces_familia TO sigilo_clinico;
GRANT SELECT, INSERT ON bitacora TO sigilo_clinico;
GRANT USAGE ON SEQUENCE bitacora_id_seq TO sigilo_clinico;
GRANT SELECT ON bitacora_soporte TO sigilo_clinico;
GRANT SELECT ON pagos TO sigilo_clinico;
GRANT DELETE ON sesiones TO sigilo_clinico;
GRANT SELECT (usuario_id, consultorio_id) ON sesiones TO sigilo_clinico;

-- SOPORTE: datos de la cuenta, nombre sellado del paciente, última consulta y última receta. Nada más.
GRANT SELECT (id, nombre, plan, ciclo, estado, renovacion, pagado_hasta, contacto_email, n_pacientes, ultima_actividad_en, creado_en)
  ON consultorios TO sigilo_soporte;
GRANT SELECT (id, consultorio_id, nombre_sellado, ultima_consulta_en, ultima_receta_en, archivado_en)
  ON pacientes TO sigilo_soporte;
GRANT SELECT, INSERT ON bitacora_soporte TO sigilo_soporte;
GRANT USAGE ON SEQUENCE bitacora_soporte_id_seq TO sigilo_soporte;
GRANT SELECT (consultorio_id, monto_centavos, pagado_en) ON pagos TO sigilo_soporte;
GRANT SELECT (tipo, estado, origen) ON solicitudes TO sigilo_soporte;
GRANT SELECT ON lista_fundadores TO sigilo_soporte;

-- ---------------------------------------------------------------------------
-- Row Level Security forzada
-- ---------------------------------------------------------------------------

ALTER TABLE consultorios ENABLE ROW LEVEL SECURITY;
ALTER TABLE consultorios FORCE ROW LEVEL SECURITY;
CREATE POLICY cuentas_todo ON consultorios TO sigilo_cuentas USING (true) WITH CHECK (true);
CREATE POLICY clinico_propio ON consultorios TO sigilo_clinico
  USING (id = sigilo_consultorio_actual()) WITH CHECK (id = sigilo_consultorio_actual());
CREATE POLICY soporte_lectura ON consultorios FOR SELECT TO sigilo_soporte USING (true);

ALTER TABLE usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuarios FORCE ROW LEVEL SECURITY;
CREATE POLICY cuentas_todo ON usuarios TO sigilo_cuentas USING (true) WITH CHECK (true);
CREATE POLICY clinico_propio ON usuarios TO sigilo_clinico
  USING (consultorio_id = sigilo_consultorio_actual()) WITH CHECK (consultorio_id = sigilo_consultorio_actual());

ALTER TABLE sesiones ENABLE ROW LEVEL SECURITY;
ALTER TABLE sesiones FORCE ROW LEVEL SECURITY;
CREATE POLICY cuentas_todo ON sesiones TO sigilo_cuentas USING (true) WITH CHECK (true);
CREATE POLICY clinico_propio ON sesiones TO sigilo_clinico
  USING (consultorio_id = sigilo_consultorio_actual());

ALTER TABLE pacientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pacientes FORCE ROW LEVEL SECURITY;
CREATE POLICY clinico_propio ON pacientes TO sigilo_clinico
  USING (consultorio_id = sigilo_consultorio_actual()) WITH CHECK (consultorio_id = sigilo_consultorio_actual());
CREATE POLICY soporte_consultorio_abierto ON pacientes FOR SELECT TO sigilo_soporte
  USING (consultorio_id = sigilo_consultorio_soporte());

ALTER TABLE registros ENABLE ROW LEVEL SECURITY;
ALTER TABLE registros FORCE ROW LEVEL SECURITY;
CREATE POLICY clinico_propio ON registros TO sigilo_clinico
  USING (consultorio_id = sigilo_consultorio_actual()) WITH CHECK (consultorio_id = sigilo_consultorio_actual());

ALTER TABLE enlaces_familia ENABLE ROW LEVEL SECURITY;
ALTER TABLE enlaces_familia FORCE ROW LEVEL SECURITY;
CREATE POLICY clinico_propio ON enlaces_familia TO sigilo_clinico
  USING (consultorio_id = sigilo_consultorio_actual()) WITH CHECK (consultorio_id = sigilo_consultorio_actual());
CREATE POLICY cuentas_lectura ON enlaces_familia FOR SELECT TO sigilo_cuentas USING (true);
CREATE POLICY cuentas_descargas ON enlaces_familia FOR UPDATE TO sigilo_cuentas USING (true) WITH CHECK (true);

ALTER TABLE bitacora ENABLE ROW LEVEL SECURITY;
ALTER TABLE bitacora FORCE ROW LEVEL SECURITY;
CREATE POLICY clinico_propio ON bitacora TO sigilo_clinico
  USING (consultorio_id = sigilo_consultorio_actual()) WITH CHECK (consultorio_id = sigilo_consultorio_actual());
CREATE POLICY cuentas_insertar ON bitacora FOR INSERT TO sigilo_cuentas WITH CHECK (true);

ALTER TABLE bitacora_soporte ENABLE ROW LEVEL SECURITY;
ALTER TABLE bitacora_soporte FORCE ROW LEVEL SECURITY;
CREATE POLICY clinico_lectura ON bitacora_soporte FOR SELECT TO sigilo_clinico
  USING (consultorio_id = sigilo_consultorio_actual());
CREATE POLICY soporte_insertar ON bitacora_soporte FOR INSERT TO sigilo_soporte WITH CHECK (true);
CREATE POLICY soporte_lectura ON bitacora_soporte FOR SELECT TO sigilo_soporte USING (true);

ALTER TABLE pagos ENABLE ROW LEVEL SECURITY;
ALTER TABLE pagos FORCE ROW LEVEL SECURITY;
CREATE POLICY cuentas_todo ON pagos TO sigilo_cuentas USING (true) WITH CHECK (true);
CREATE POLICY clinico_propio ON pagos FOR SELECT TO sigilo_clinico
  USING (consultorio_id = sigilo_consultorio_actual());
CREATE POLICY soporte_lectura ON pagos FOR SELECT TO sigilo_soporte USING (true);
