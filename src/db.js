'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const POINTS_8 = 'A,B,C,D,E,F,G,H';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('inspector','analista','jefe')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
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
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
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
  taken_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
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
  performed_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (lot_id, test_type_id)
);
CREATE TABLE IF NOT EXISTS certificates (
  id INTEGER PRIMARY KEY,
  number TEXT UNIQUE NOT NULL,
  year INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  lot_id INTEGER UNIQUE NOT NULL REFERENCES lots(id),
  issued_by INTEGER REFERENCES users(id),
  issued_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  snapshot TEXT NOT NULL,
  UNIQUE (year, seq)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`;

// Datos tomados de las fichas técnicas (fotos del manual de calidad).
// Supuesto: el número del producto en la tabla de pesos (#1, #3, #5) corresponde
// a la referencia de las fichas dimensionales (Ref. 01, 03, 05).
const SEED_PRODUCTS = [
  {
    code: 'REF01-CF', name: 'Cuñete 5 galones Ref. 01', referencia: '01', capacidad: '5 galones', molde: 'Colada fría',
    specs: [
      ['Cuñete', 'Peso cuñete', 'g', '', 800, 810, 820],
      ['Tapa', 'Peso tapa', 'g', '', 225, 230, 235],
      ['Cuñete', 'Diámetro externo cuñete', 'mm', POINTS_8, 298, 301, 304],
      ['Cuñete', 'Diámetro interno cuñete', 'mm', POINTS_8, 292, 295, 298],
      ['Tapa', 'Diámetro externo tapa', 'mm', POINTS_8, 300, 302, 304],
      ['Tapa', 'Diámetro interno tapa', 'mm', POINTS_8, 289, 291, 293],
    ],
  },
  {
    code: 'REF01-CC', name: 'Cuñete 5 galones Ref. 01', referencia: '01', capacidad: '5 galones', molde: 'Colada caliente',
    specs: [
      ['Cuñete', 'Peso cuñete', 'g', '', 800, 810, 820],
      ['Tapa', 'Peso tapa', 'g', '', 246, 250, 254],
      ['Cuñete', 'Diámetro externo cuñete', 'mm', POINTS_8, 298, 301, 304],
      ['Cuñete', 'Diámetro interno cuñete', 'mm', POINTS_8, 292, 295, 298],
      ['Tapa', 'Diámetro externo tapa', 'mm', POINTS_8, 300, 302, 304],
      ['Tapa', 'Diámetro interno tapa', 'mm', POINTS_8, 286, 290, 294],
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
      ['Cuñete', 'Diámetro externo cuñete', 'mm', POINTS_8, 238, 242, 246],
      ['Cuñete', 'Diámetro interno cuñete', 'mm', POINTS_8, 228, 232, 236],
      ['Tapa', 'Diámetro externo tapa', 'mm', POINTS_8, 248, 250, 252],
      ['Tapa', 'Diámetro interno tapa', 'mm', POINTS_8, 228, 230, 232],
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
      ['Galón', 'Diámetro externo cuñete', 'mm', POINTS_8, 238, 242, 246],
      ['Galón', 'Diámetro interno cuñete', 'mm', POINTS_8, 228, 232, 236],
      ['Tapa', 'Diámetro externo tapa', 'mm', POINTS_8, 248, 250, 252],
      ['Tapa', 'Diámetro interno tapa', 'mm', POINTS_8, 228, 230, 232],
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

function open(file) {
  const dbFile = file || process.env.DB_FILE || path.join(__dirname, '..', 'data', 'calidad.db');
  if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  seed(db);
  return db;
}

function seed(db) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;
  tx(db, () => {
    const insUser = db.prepare('INSERT INTO users (username, full_name, role, password_hash) VALUES (?,?,?,?)');
    const hash = bcrypt.hashSync(DEFAULT_PASSWORD, 10);
    for (const [u, n, r] of SEED_USERS) insUser.run(u, n, r, hash);

    const insProd = db.prepare('INSERT INTO products (code, name, referencia, capacidad, molde, uso) VALUES (?,?,?,?,?,?)');
    const insSpec = db.prepare('INSERT INTO specs (product_id, component, characteristic, unit, points, lic, lcc, lsc, sort) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const p of SEED_PRODUCTS) {
      const r = insProd.run(p.code, p.name, p.referencia, p.capacidad, p.molde, 'Pintura / Alimentos');
      p.specs.forEach((s, i) => insSpec.run(r.lastInsertRowid, ...s, i));
    }
    const insTest = db.prepare('INSERT INTO test_types (code, name, description) VALUES (?,?,?)');
    for (const t of SEED_TESTS) insTest.run(...t);
  });
}

function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { open, tx, POINTS_8, DEFAULT_PASSWORD };
