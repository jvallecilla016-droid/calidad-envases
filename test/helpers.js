'use strict';
const test = require('node:test');
const { open } = require('../src/db');

// Base de pruebas: SQLite en memoria, o PostgreSQL si se define TEST_DATABASE_URL
// (esa base se vacía en cada prueba; no uses la base real).
async function testDb() {
  const url = process.env.TEST_DATABASE_URL;
  const db = await open(url || ':memory:', { reset: Boolean(url) });
  test.after(() => db.close());
  return db;
}

module.exports = { testDb };
