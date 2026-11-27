'use strict';
const path = require('node:path');
const fs = require('node:fs');
const bcrypt = require('bcryptjs');

// Los diámetros se miden en 4 puntos.
const POINTS = 'A,B,C,D';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('inspector','analista','jefe')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (__NOW__)
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  referencia TEXT,
  capacidad TEXT,
  molde TEXT NOT NULL,
  uso TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS specs (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  component TEXT NOT NULL,
  characteristic TEXT NOT NULL,
  unit TEXT NOT NULL,
  points TEXT NOT NULL DEFAULT '',
  lic REAL NOT NULL,
  lcc REAL,
  lsc REAL NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS test_types (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS lots (
  id INTEGER PRIMARY KEY,
  lot_number TEXT UNIQUE NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  production_date TEXT NOT NULL,
  shift TEXT,
  machine TEXT,
  quantity INTEGER,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'en_proceso'
    CHECK (status IN ('en_proceso','en_revision','liberado','rechazado')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (__NOW__),
  submitted_by INTEGER REFERENCES users(id),
  submitted_at TEXT,
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  decision_notes TEXT
);
CREATE TABLE IF NOT EXISTS samples (
  id INTEGER PRIMARY KEY,
  lot_id INTEGER NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  sample_no INTEGER NOT NULL,
  taken_by INTEGER REFERENCES users(id),
  taken_at TEXT NOT NULL DEFAULT (__NOW__),
  UNIQUE (lot_id, sample_no)
);
CREATE TABLE IF NOT EXISTS measurements (
  id INTEGER PRIMARY KEY,
  sample_id INTEGER NOT NULL REFERENCES samples(id) ON DELETE CASCADE,
  spec_id INTEGER NOT NULL REFERENCES specs(id),
  point TEXT NOT NULL DEFAULT '',
  value REAL NOT NULL,
  lic REAL NOT NULL,
  lsc REAL NOT NULL,
  UNIQUE (sample_id, spec_id, point)
);
CREATE TABLE IF NOT EXISTS test_results (
  id INTEGER PRIMARY KEY,
  lot_id INTEGER NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  test_type_id INTEGER NOT NULL REFERENCES test_types(id),
  result TEXT NOT NULL CHECK (result IN ('pasa','no_pasa')),
  observations TEXT,
  performed_by INTEGER REFERENCES users(id),
  performed_at TEXT NOT NULL DEFAULT (__NOW__),
  UNIQUE (lot_id, test_type_id)
);
CREATE TABLE IF NOT EXISTS certificates (
  id INTEGER PRIMARY KEY,
  number TEXT UNIQUE NOT NULL,
  year INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  lot_id INTEGER UNIQUE NOT NULL REFERENCES lots(id),
  issued_by INTEGER REFERENCES users(id),
  issued_at TEXT NOT NULL DEFAULT (__NOW__),
  snapshot TEXT NOT NULL,
  UNIQUE (year, seq)
);
CREATE TABLE IF NOT EXISTS lot_photos (
  id INTEGER PRIMARY KEY,
  lot_id INTEGER NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  data TEXT NOT NULL,
  caption TEXT,
  taken_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (__NOW__)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (__NOW__)
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

// Datos tomados de las fichas técnicas (fotos del manual de calidad).
// Supuesto: el número del producto en la tabla de pesos (#1, #3, #5) corresponde
// a la referencia de las fichas dimensionales (Ref. 01, 03, 05).
const SEED_PRODUCTS = [
  {
    code: 'REF01-CF', name: 'Cuñete 5 galones Ref. 01', referencia: '01', capacidad: '5 galones', molde: 'Colada fría',
    specs: [
      ['Cuñete', 'Peso cuñete', 'g', '', 820, 830, 840],
      ['Tapa', 'Peso tapa', 'g', '', 250, 255, 260],
      ['Cuñete', 'Diámetro externo cuñete', 'mm', POINTS, 298, 301, 304],
      ['Cuñete', 'Diámetro interno cuñete', 'mm', POINTS, 292, 295, 298],
      ['Tapa', 'Diámetro externo tapa', 'mm', POINTS, 300, 302, 304],
      ['Tapa', 'Diámetro interno tapa', 'mm', POINTS, 289, 291, 293],
    ],
  },
  {
    code: 'REF01-CC', name: 'Cuñete 5 galones Ref. 01', referencia: '01', capacidad: '5 galones', molde: 'Colada caliente',
    specs: [
      ['Cuñete', 'Peso cuñete', 'g', '', 820, 830, 840],
      ['Tapa', 'Peso tapa', 'g', '', 250, 255, 260],
      ['Cuñete', 'Diámetro externo cuñete', 'mm', POINTS, 298, 301, 304],
      ['Cuñete', 'Diámetro interno cuñete', 'mm', POINTS, 292, 295, 298],
      ['Tapa', 'Diámetro externo tapa', 'mm', POINTS, 300, 302, 304],
      ['Tapa', 'Diámetro interno tapa', 'mm', POINTS, 286, 290, 294],
    ],
  },
  {
    code: 'REF02-CF', name: 'Cuñete Ref. 02', referencia: '02', capacidad: '', molde: 'Colada fría',
    specs: [
      ['Cuñete', 'Peso cuñete', 'g', '', 895, 905, 915],
      ['Tapa', 'Peso tapa', 'g', '', 270, 275, 280],
    ],
  },
  {
    code: 'REF03-CF', name: 'Cuñete 2,5 galones Ref. 03', referencia: '03', capacidad: '2,5 galones', molde: 'Colada fría',
    specs: [
      ['Cuñete', 'Peso cuñete', 'g', '', 430, 440, 450],
      ['Tapa', 'Peso tapa', 'g', '', 85, 95, 105],
      ['Cuñete', 'Diámetro externo cuñete', 'mm', POINTS, 238, 242, 246],
      ['Cuñete', 'Diámetro interno cuñete', 'mm', POINTS, 228, 232, 236],
      ['Tapa', 'Diámetro externo tapa', 'mm', POINTS, 248, 250, 252],
      ['Tapa', 'Diámetro interno tapa', 'mm', POINTS, 228, 230, 232],
    ],
  },
  {
    code: 'REF04-CF', name: 'Galón Ref. 04', referencia: '04', capacidad: '1 galón', molde: 'Colada fría',
    specs: [
      ['Galón', 'Peso galón', 'g', '', 185, 190, 195],
      ['Tapa', 'Peso tapa', 'g', '', 46, 50, 54],
    ],
  },
  {
    code: 'REF05-CF', name: 'Galón cónico Ref. 05', referencia: '05', capacidad: '1 galón', molde: 'Colada fría',
    specs: [
      ['Galón', 'Peso galón', 'g', '', 165, 170, 175],
      ['Galón', 'Diámetro externo cuñete', 'mm', POINTS, 238, 242, 246],
      ['Galón', 'Diámetro interno cuñete', 'mm', POINTS, 228, 232, 236],
      ['Tapa', 'Diámetro externo tapa', 'mm', POINTS, 248, 250, 252],
      ['Tapa', 'Diámetro interno tapa', 'mm', POINTS, 228, 230, 232],
    ],
  },
  {
    code: 'REF05-CC', name: 'Galón cónico Ref. 05', referencia: '05', capacidad: '1 galón', molde: 'Colada caliente',
    specs: [
      ['Galón', 'Peso galón', 'g', '', 170, 175, 180],
      ['Tapa', 'Peso tapa', 'g', '', 39, 41, 43],
    ],
  },
];

const VISUAL_ITEMS = ['Rotos', 'Manchas', 'Producto incompleto'];

const SEED_TESTS = [
  ['IMPACTO', 'Prueba de impacto', 'Resistencia del envase lleno a la caída o golpe. Registrar altura y condición de la prueba en observaciones.'],
  ['FILTRACION', 'Prueba de filtración', 'Hermeticidad del conjunto envase + tapa. Registrar tiempo y método en observaciones.'],
];

const SEED_USERS = [
  ['inspector', 'Operario / Inspector', 'inspector'],
  ['analista', 'Analista de Calidad', 'analista'],
  ['jefe', 'Jefe de Calidad', 'jefe'],
];
const DEFAULT_PASSWORD = 'Calidad2026*';

// Hora de Colombia (Render y Neon trabajan en UTC).
const TZ = 'America/Bogota';
const SQLITE_NOW = "datetime('now','localtime')";
const PG_NOW = `to_char(now() AT TIME ZONE '${TZ}', 'YYYY-MM-DD HH24:MI:SS')`;

function yearNow() {
  return Number(new Intl.DateTimeFormat('en', { timeZone: TZ, year: 'numeric' }).format(new Date()));
}

// ---------------------------------------------------------------------------
// Acceso a datos con la misma interfaz para SQLite (local y pruebas) y
// PostgreSQL (Neon, en internet). Todo es async:
//   await db.prepare(sql).get(...args) / .all(...args) / .run(...args)
//   await tx(db, async (db) => { ... })
// En el SQL se escribe ? para los parámetros y NOW() para la hora actual.
// ---------------------------------------------------------------------------

class SqliteStore {
  constructor(file) {
    const { DatabaseSync } = require('node:sqlite');
    this.kind = 'sqlite';
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.lock = Promise.resolve();
    this.inTx = false;
  }

  sql(q) { return q.replace(/\bNOW\(\)/g, SQLITE_NOW); }

  // Fuera de una transacción, cada consulta espera a que termine la transacción en curso.
  async wait() { if (!this.inTx) await this.lock; }

  prepare(q) {
    const st = () => this.raw.prepare(this.sql(q));
    return {
      get: async (...a) => { await this.wait(); return st().get(...a); },
      all: async (...a) => { await this.wait(); return st().all(...a); },
      run: async (...a) => {
        await this.wait();
        const r = st().run(...a);
        return { lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) };
      },
    };
  }

  async exec(q) { await this.wait(); this.raw.exec(this.sql(q)); }

  async transaction(fn) {
    const prev = this.lock;
    let release;
    this.lock = new Promise((r) => { release = r; });
    await prev;
    const t = Object.create(this);
    t.inTx = true;
    this.raw.exec('BEGIN');
    try {
      const out = await fn(t);
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      release();
    }
  }

  async close() { this.raw.close(); }
}

class PgStore {
  constructor(url) {
    const pg = require('pg');
    // COUNT/SUM devuelven bigint/numeric: los convertimos a número de JS.
    pg.types.setTypeParser(20, Number);
    pg.types.setTypeParser(1700, Number);
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    this.kind = 'pg';
    this.pool = new pg.Pool({
      connectionString: url,
      ssl: local || /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false },
      max: Number(process.env.PG_POOL_MAX || 5),
    });
    this.client = null;
  }

  sql(q) {
    let i = 0;
    let out = q.replace(/\?/g, () => `$${++i}`)
      .replace(/\bNOW\(\)/g, PG_NOW)
      .replace(/\bLIKE\b/g, 'ILIKE');
    // Todas las tablas tienen id, salvo meta.
    if (/^\s*INSERT\b/i.test(out) && !/\bRETURNING\b/i.test(out) && !/^\s*INSERT INTO meta\b/i.test(out)) out += ' RETURNING id';
    return out;
  }

  query(q, args) { return (this.client || this.pool).query(this.sql(q), args); }

  prepare(q) {
    return {
      get: async (...a) => (await this.query(q, a)).rows[0],
      all: async (...a) => (await this.query(q, a)).rows,
      run: async (...a) => {
        const r = await this.query(q, a);
        return { lastInsertRowid: r.rows[0] ? Number(r.rows[0].id) : undefined, changes: r.rowCount };
      },
    };
  }

  async exec(q) { await (this.client || this.pool).query(q.replace(/\bNOW\(\)/g, PG_NOW)); }

  async transaction(fn) {
    const client = await this.pool.connect();
    const t = Object.create(this);
    t.client = client;
    try {
      await client.query('BEGIN');
      const out = await fn(t);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async close() { await this.pool.end(); }
}

const TABLES = ['meta', 'lot_photos', 'audit_log', 'certificates', 'test_results', 'measurements', 'samples', 'lots', 'test_types', 'specs', 'products', 'users', 'session'];

function pgSchema() {
  return SCHEMA
    .replace(/id INTEGER PRIMARY KEY/g, 'id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY')
    .replace(/\bREAL\b/g, 'DOUBLE PRECISION');
}

// destino: URL postgres://... o archivo SQLite (':memory:' para pruebas).
// Por defecto usa DATABASE_URL si existe; si no, DB_FILE o data/calidad.db.
// reset: true vacía la base PostgreSQL de pruebas antes de empezar.
// Acepta la cadena tal como se copia de Neon: con espacios, comillas o el
// comando "psql '...'" delante. Devuelve null si no hay una URL postgres.
function cleanPgUrl(v) {
  if (!v) return null;
  const m = String(v).match(/postgres(?:ql)?:\/\/[^\s'"]+/);
  return m ? m[0] : null;
}

async function open(target, { reset = false } = {}) {
  const envUrl = process.env.DATABASE_URL;
  if (!target && process.env.RENDER && !cleanPgUrl(envUrl)) {
    throw new Error('Falta DATABASE_URL en Render. Pega la cadena de Neon en Environment y vuelve a desplegar.');
  }
  if (!target && envUrl && envUrl.trim() && !cleanPgUrl(envUrl)) {
    throw new Error('DATABASE_URL no es una cadena de PostgreSQL válida. Debe empezar con postgresql:// (cópiala de Neon con el botón Connect).');
  }
  const dest = cleanPgUrl(target) || target || cleanPgUrl(envUrl) || process.env.DB_FILE || path.join(__dirname, '..', 'data', 'calidad.db');
  let db;
  if (/^postgres(ql)?:\/\//.test(dest)) {
    db = new PgStore(dest);
    if (reset) await db.exec(`DROP TABLE IF EXISTS ${TABLES.join(', ')}`);
    await db.exec(pgSchema().replace(/__NOW__/g, 'NOW()'));
  } else {
    if (dest !== ':memory:') fs.mkdirSync(path.dirname(dest), { recursive: true });
    db = new SqliteStore(dest);
    await db.exec(SCHEMA.replace(/__NOW__/g, 'NOW()'));
  }
  await seed(db);
  await migrate(db);
  return db;
}

// Cambios de estructura sobre bases ya existentes (la de Neon incluida).
// Cada paso corre una sola vez; la versión queda guardada en la tabla meta.
const MIGRATIONS = [
  // 1. Diámetros en 4 puntos (A–D) y prueba de impacto con casillas.
  async (db) => {
    await db.exec("UPDATE specs SET points = 'A,B,C,D' WHERE points = 'A,B,C,D,E,F,G,H'");
    await db.exec('ALTER TABLE test_types ADD COLUMN checks INTEGER NOT NULL DEFAULT 0');
    await db.exec('ALTER TABLE test_types ADD COLUMN min_ok INTEGER');
    await db.exec('ALTER TABLE test_results ADD COLUMN detail TEXT');
    await db.exec('ALTER TABLE test_results ADD COLUMN score INTEGER');
    await db.exec("UPDATE test_types SET checks = 4, min_ok = 2, description = 'Se dan 4 impactos al envase y se marca en cada casilla si resistió. Se aprueba si resiste al menos 2.' WHERE code = 'IMPACTO'");
  },
  // 2. Inspección visual: lista de defectos con nombre; se aprueba solo si no aparece ninguno.
  async (db) => {
    await db.exec('ALTER TABLE test_types ADD COLUMN items TEXT');
    if (!(await db.prepare("SELECT 1 FROM test_types WHERE code = 'VISUAL'").get())) {
      await db.prepare('INSERT INTO test_types (code, name, description, checks, min_ok, items) VALUES (?,?,?,?,?,?)')
        .run('VISUAL', 'Inspección visual', 'Revisar el producto a la vista. Marcar cada defecto como presente o ausente. Se aprueba solo si no tiene ninguno.', VISUAL_ITEMS.length, VISUAL_ITEMS.length, VISUAL_ITEMS.join(','));
    }
  },
  // 3. Usuarios del equipo de calidad. Entran con la contraseña inicial y deben cambiarla.
  async (db) => {
    await db.exec('ALTER TABLE users ADD COLUMN must_change INTEGER NOT NULL DEFAULT 0');
    const hash = bcrypt.hashSync(DEFAULT_PASSWORD, 10);
    for (const [u, name, r] of TEAM_USERS) {
      if (await db.prepare('SELECT 1 FROM users WHERE username = ?').get(u)) continue;
      await db.prepare('INSERT INTO users (username, full_name, role, password_hash, must_change) VALUES (?,?,?,?,1)').run(u, name, r, hash);
    }
  },
  // 4. Solo el administrador (Luis) crea, modifica y elimina usuarios y elimina lotes.
  async (db) => {
    await db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
    await db.exec("UPDATE users SET is_admin = 1 WHERE username = 'lgomez'");
  },
  // 5. Mínimos por lote: 5 muestras por producto y 5 envases en impacto y filtración.
  async (db) => {
    await db.exec('ALTER TABLE products ADD COLUMN min_samples INTEGER NOT NULL DEFAULT 5');
    await db.exec('ALTER TABLE test_types ADD COLUMN units INTEGER NOT NULL DEFAULT 1');
    await db.exec("UPDATE test_types SET units = 5 WHERE code IN ('IMPACTO', 'FILTRACION')");
  },
  // 6. Cualquier perfil emite el certificado; el jefe le da el visto bueno después.
  async (db) => {
    await db.exec('ALTER TABLE certificates ADD COLUMN reviewed_by INTEGER REFERENCES users(id)');
    await db.exec('ALTER TABLE certificates ADD COLUMN reviewed_at TEXT');
  },
  // 7. Resultados como «Aprobado / No aprobado» también en las descripciones guardadas.
  async (db) => {
    await db.exec("UPDATE test_types SET description = REPLACE(REPLACE(description, 'Pasa solo si', 'Se aprueba solo si'), 'Pasa si', 'Se aprueba si')");
  },
  // 8. Inspección visual: «Manchados» pasa a llamarse «Manchas» (también en certificados ya emitidos).
  async (db) => {
    await db.exec("UPDATE test_types SET items = REPLACE(items, 'Manchados', 'Manchas') WHERE items IS NOT NULL");
    await db.exec("UPDATE certificates SET snapshot = REPLACE(snapshot, 'Manchados', 'Manchas')");
  },
  // 9. Certificados emitidos antes de guardar el mínimo de la prueba de impacto: se completa con
  // el mínimo configurado (2 caídas) para que cada envase se evalúe con la regla correcta.
  async (db) => {
    const types = await db.prepare('SELECT name, min_ok FROM test_types WHERE checks > 0 AND items IS NULL').all();
    for (const c of await db.prepare('SELECT id, snapshot FROM certificates').all()) {
      const snap = JSON.parse(c.snapshot);
      let changed = false;
      for (const t of snap.tests || []) {
        if (t.checks && !t.items && !t.min_ok) {
          t.min_ok = (types.find((x) => x.name === t.name) || {}).min_ok || 2;
          changed = true;
        }
      }
      if (changed) await db.prepare('UPDATE certificates SET snapshot = ? WHERE id = ?').run(JSON.stringify(snap), c.id);
    }
  },
  // 10. Color y material del lote (listas editables guardadas en meta) y nuevos pesos de 5 galones:
  // tapa 255 ± 5 g y cuñete 830 ± 10 g (pedido de Camilo, 2026-11-27).
  async (db) => {
    await addColumn(db, 'lots', 'color', 'TEXT');
    await addColumn(db, 'lots', 'material', 'TEXT');
    // Envases no conformes que se admiten sin rechazar la prueba (impacto: 1 de 5) y quedan anotados.
    await addColumn(db, 'test_types', 'max_fail', 'INTEGER NOT NULL DEFAULT 0');
    await db.exec("UPDATE test_types SET max_fail = 1 WHERE code = 'IMPACTO'");
    for (const [k, v] of [['colors', DEFAULT_COLORS.join(',')], ['materials', DEFAULT_MATERIALS.join(',')]]) {
      if (!(await db.prepare('SELECT 1 FROM meta WHERE key = ?').get(k))) await db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(k, v);
    }
    const five = "product_id IN (SELECT id FROM products WHERE capacidad = '5 galones')";
    await db.exec(`UPDATE specs SET lic = 250, lcc = 255, lsc = 260 WHERE characteristic = 'Peso tapa' AND ${five}`);
    await db.exec(`UPDATE specs SET lic = 820, lcc = 830, lsc = 840 WHERE characteristic = 'Peso cuñete' AND ${five}`);
  },
];

async function addColumn(db, table, col, type) {
  const has = db.kind === 'pg'
    ? await db.prepare('SELECT 1 FROM information_schema.columns WHERE table_name = ? AND column_name = ?').get(table, col)
    : (await db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all()).some((c) => c.name === col);
  if (!has) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

const DEFAULT_COLORS = ['Blanco', 'Negro', 'Azul', 'Rojo', 'Amarillo', 'Verde', 'Gris', 'Natural'];
const DEFAULT_MATERIALS = ['PEAD virgen', 'PEAD recuperado'];

const TEAM_USERS = [
  ['lgomez', 'Luis Eduardo Gómez', 'jefe'],
  ['jcvallecilla', 'Juan Camilo Vallecilla', 'analista'],
  ['paola', 'Paola', 'analista'],
  ['ncastellanos', 'Nicolás Castellanos', 'inspector'],
];

// Lista de defectos para una prueba de inspección: texto separado por comas o saltos de línea.
function parseItems(v) {
  return String(v || '').split(/[,\n]/).map((x) => x.trim().replace(/\s+/g, ' ')).filter(Boolean).slice(0, 10);
}

async function migrate(db) {
  const row = await db.prepare("SELECT value FROM meta WHERE key = 'version'").get();
  let version = row ? Number(row.value) : 0;
  while (version < MIGRATIONS.length) {
    await tx(db, async (db) => {
      await MIGRATIONS[version](db);
      version += 1;
      await db.prepare("DELETE FROM meta WHERE key = 'version'").run();
      await db.prepare("INSERT INTO meta (key, value) VALUES ('version', ?)").run(String(version));
    });
  }
}

async function seed(db) {
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n > 0) return;
  await tx(db, async (db) => {
    const hash = bcrypt.hashSync(DEFAULT_PASSWORD, 10);
    for (const [u, name, r] of SEED_USERS) {
      await db.prepare('INSERT INTO users (username, full_name, role, password_hash) VALUES (?,?,?,?)').run(u, name, r, hash);
    }
    for (const p of SEED_PRODUCTS) {
      const r = await db.prepare('INSERT INTO products (code, name, referencia, capacidad, molde, uso) VALUES (?,?,?,?,?,?)')
        .run(p.code, p.name, p.referencia, p.capacidad, p.molde, 'Pintura / Alimentos');
      for (const [i, s] of p.specs.entries()) {
        await db.prepare('INSERT INTO specs (product_id, component, characteristic, unit, points, lic, lcc, lsc, sort) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(r.lastInsertRowid, ...s, i);
      }
    }
    for (const t of SEED_TESTS) await db.prepare('INSERT INTO test_types (code, name, description) VALUES (?,?,?)').run(...t);
  });
}

function tx(db, fn) {
  return db.transaction(fn);
}

module.exports = { open, tx, yearNow, cleanPgUrl, parseItems, POINTS, DEFAULT_PASSWORD };
