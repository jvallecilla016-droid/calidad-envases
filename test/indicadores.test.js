'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { open, tx } = require('../src/db');
const { calcular, csvLotes, semanaDe, normalizaFiltros } = require('../src/indicadores');

// Crea un lote con una muestra; `fuera` = lista de [característica, punto, valor] que se salen.
function lote(db, { num, code, fecha, estado, fuera = [], impacto = 'pasa', filtracion = 'pasa' }) {
  return tx(db, () => {
    const prod = db.prepare('SELECT id FROM products WHERE code = ?').get(code);
    const lotId = db.prepare('INSERT INTO lots (lot_number, product_id, production_date, status) VALUES (?,?,?,?)').run(num, prod.id, fecha, estado).lastInsertRowid;
    const sid = db.prepare('INSERT INTO samples (lot_id, sample_no) VALUES (?, 1)').run(lotId).lastInsertRowid;
    for (const s of db.prepare('SELECT * FROM specs WHERE product_id = ?').all(prod.id)) {
      for (const pt of s.points ? s.points.split(',') : ['']) {
        const bad = fuera.find(([c, p]) => c === s.characteristic && p === pt);
        db.prepare('INSERT INTO measurements (sample_id, spec_id, point, value, lic, lsc) VALUES (?,?,?,?,?,?)').run(sid, s.id, pt, bad ? bad[2] : s.lcc, s.lic, s.lsc);
      }
    }
    const types = db.prepare('SELECT id, code FROM test_types').all();
    for (const t of types) db.prepare('INSERT INTO test_results (lot_id, test_type_id, result) VALUES (?,?,?)').run(lotId, t.id, t.code === 'IMPACTO' ? impacto : filtracion);
    return lotId;
  });
}

test('indicadores con lotes reales de la base de datos', () => {
  const db = open(':memory:');
  lote(db, { num: 'A1', code: 'REF01-CF', fecha: '2026-11-02', estado: 'liberado' });
  lote(db, { num: 'A2', code: 'REF01-CF', fecha: '2026-11-03', estado: 'rechazado', fuera: [['Diámetro interno cuñete', 'C', 299.2], ['Diámetro externo tapa', 'C', 299]] });
  lote(db, { num: 'A3', code: 'REF01-CC', fecha: '2026-11-10', estado: 'rechazado', filtracion: 'no_pasa' });
  lote(db, { num: 'A4', code: 'REF04-CF', fecha: '2026-11-11', estado: 'en_proceso', fuera: [['Peso galón', '', 200]] });

  const ind = calcular(db, {});
  assert.deepStrictEqual(
    { lotes: ind.resumen.lotes, lib: ind.resumen.liberados, rec: ind.resumen.rechazados, proc: ind.resumen.en_proceso, pct: ind.resumen.cumplimiento, fuera: ind.resumen.lecturas_fuera },
    { lotes: 4, lib: 1, rec: 2, proc: 1, pct: 33.3, fuera: 3 });
  assert.strictEqual(ind.porPunto.find((p) => p.punto === 'C').fuera, 2);
  assert.strictEqual(ind.porPunto.reduce((a, p) => a + p.fuera, 0), 2, 'el peso no cuenta como punto A–H');
  assert.deepStrictEqual(ind.porSemana.map((s) => [s.semana, s.total]), [['2026-11-02', 2], ['2026-11-09', 2]]);
  const ref01 = ind.porProducto.find((p) => p.codigo === 'REF01-CF');
  assert.deepStrictEqual([ref01.liberados, ref01.rechazados, ref01.cumplimiento], [1, 1, 50]);
  const fil = ind.pruebas.find((t) => t.prueba === 'Prueba de filtración');
  assert.deepStrictEqual([fil.pasa, fil.no_pasa, fil.aprobacion], [3, 1, 75]);
  const ext = ind.fuera.find((r) => r.characteristic === 'Diámetro externo tapa');
  assert.strictEqual(ext.desviacion, -1);

  // Filtros
  assert.strictEqual(calcular(db, { molde: 'Colada caliente' }).resumen.lotes, 1);
  assert.strictEqual(calcular(db, { desde: '2026-11-10' }).resumen.lotes, 2);
  assert.strictEqual(calcular(db, { hasta: '2026-11-02' }).resumen.lotes, 1);
  const prod = db.prepare("SELECT id FROM products WHERE code = 'REF04-CF'").get().id;
  assert.strictEqual(calcular(db, { producto: String(prod) }).resumen.lecturas_fuera, 1);
  assert.deepStrictEqual(normalizaFiltros({ producto: '1; DROP', molde: 'x', desde: 'ayer' }), { producto: null, molde: '', desde: '', hasta: '' });

  const csv = csvLotes(ind.lotes);
  assert.ok(csv.startsWith('﻿lote;fecha_produccion'));
  assert.strictEqual(csv.trim().split('\r\n').length, 5);
  assert.strictEqual(semanaDe('2026-11-08'), '2026-11-02');
});

test('indicadores sin lotes', () => {
  const ind = calcular(open(':memory:'), {});
  assert.strictEqual(ind.resumen.lotes, 0);
  assert.strictEqual(ind.resumen.cumplimiento, null);
});
