'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { DEFAULT_PASSWORD } = require('../src/db');
const { testDb } = require('./helpers');
const { createApp } = require('../src/server');

// Cliente HTTP mínimo con cookie de sesión.
function client(base) {
  let cookie = '';
  const req = async (method, path, form) => {
    const res = await fetch(base + path, {
      method, redirect: 'manual',
      headers: { cookie, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return res;
  };
  return { get: (p) => req('GET', p), post: (p, f) => req('POST', p, f || {}) };
}

test('flujo completo: lote, muestras, pruebas, aprobación y certificado', async (t) => {
  const db = await testDb();
  const server = createApp(db).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u) => { const c = client(base); const r = await c.post('/login', { username: u, password: DEFAULT_PASSWORD }); assert.strictEqual(r.status, 302); return c; };

  const insp = await login('inspector');
  const analista = await login('analista');
  const jefe = await login('jefe');
  assert.strictEqual((await client(base).post('/login', { username: 'jefe', password: 'mal' })).status, 401);

  const prod = await db.prepare("SELECT * FROM products WHERE code = 'REF01-CF'").get();
  const specs = await db.prepare('SELECT * FROM specs WHERE product_id = ? ORDER BY sort').all(prod.id);
  assert.strictEqual(specs.length, 6);

  // El inspector crea el lote con el número que digita la planta
  let r = await insp.post('/lotes', { lot_number: 'L-2611-045', product_id: prod.id, production_date: '2026-11-23', shift: '2' });
  assert.strictEqual(r.status, 302);
  const lotId = Number(r.headers.get('location').split('/').pop());
  r = await insp.post('/lotes', { lot_number: 'l-2611-045', product_id: prod.id, production_date: '2026-11-23' });
  assert.strictEqual(r.status, 400, 'no permite lote repetido');

  const form = (override = {}) => {
    const f = {};
    for (const s of specs) {
      const pts = s.points ? s.points.split(',') : ['X'];
      for (const p of pts) f[`m_${s.id}_${p}`] = String(s.lcc).replace('.', ',');
    }
    return { ...f, ...override };
  };
  const diamExt = specs.find((s) => s.characteristic === 'Diámetro externo cuñete');
  // Muestra 1 con punto C fuera de límites
  await insp.post(`/lotes/${lotId}/muestras`, form({ [`m_${diamExt.id}_C`]: '305' }));
  await insp.post(`/lotes/${lotId}/muestras`, form());
  const { evaluateLot } = require('../src/quality');
  let ev = await evaluateLot(db, lotId);
  assert.strictEqual(ev.samples.length, 2);
  assert.strictEqual(ev.measurementsOk, false);
  assert.ok(ev.problems.some((p) => p.includes('punto C')));

  // Pruebas
  const types = await db.prepare('SELECT * FROM test_types').all();
  // Datos de una prueba aprobada: casillas para impacto, resultado simple para las demás.
  const aprobada = (ty) => (ty.checks ? Object.fromEntries([...Array(ty.checks)].map((_, i) => [`chk_${i + 1}`, 'si'])) : { result: 'pasa' });
  const impacto = types.find((t) => t.code === 'IMPACTO');
  assert.deepStrictEqual([impacto.checks, impacto.min_ok], [4, 2], 'impacto: 4 casillas, pasa con 2');
  assert.strictEqual(specs.filter((s) => s.points).every((s) => s.points === 'A,B,C,D'), true, 'diámetros en 4 puntos');

  // Impacto: sin marcar las 4 casillas no se guarda
  await insp.post(`/lotes/${lotId}/pruebas`, { test_type_id: impacto.id, chk_1: 'si', chk_2: 'si', chk_3: 'si' });
  assert.strictEqual(await db.prepare('SELECT 1 FROM test_results WHERE lot_id = ? AND test_type_id = ?').get(lotId, impacto.id), undefined);
  // 1 de 4 resistidos: no pasa
  await insp.post(`/lotes/${lotId}/pruebas`, { test_type_id: impacto.id, chk_1: 'si', chk_2: 'no', chk_3: 'no', chk_4: 'no' });
  let tr = await db.prepare('SELECT * FROM test_results WHERE lot_id = ? AND test_type_id = ?').get(lotId, impacto.id);
  assert.deepStrictEqual([tr.result, tr.score, tr.detail], ['no_pasa', 1, '1,0,0,0']);
  // 2 de 4 resistidos: pasa
  await insp.post(`/lotes/${lotId}/pruebas`, { test_type_id: impacto.id, chk_1: 'si', chk_2: 'no', chk_3: 'si', chk_4: 'no' });
  tr = await db.prepare('SELECT * FROM test_results WHERE lot_id = ? AND test_type_id = ?').get(lotId, impacto.id);
  assert.deepStrictEqual([tr.result, tr.score, tr.detail], ['pasa', 2, '1,0,1,0']);
  assert.ok((await (await insp.get(`/lotes/${lotId}`)).text()).includes('Impacto 4'));

  for (const ty of types) await insp.post(`/lotes/${lotId}/pruebas`, { test_type_id: ty.id, observations: 'OK', ...aprobada(ty) });

  // El inspector no puede enviar a aprobación
  assert.strictEqual((await insp.post(`/lotes/${lotId}/enviar`)).status, 403);
  await analista.post(`/lotes/${lotId}/enviar`);
  assert.strictEqual((await evaluateLot(db, lotId)).lot.status, 'en_revision');
  // El jefe no puede liberar un lote no conforme
  await jefe.post(`/lotes/${lotId}/liberar`);
  assert.strictEqual((await evaluateLot(db, lotId)).lot.status, 'en_revision');

  // Se devuelve, se corrige la muestra 1, se reenvía y se libera
  await analista.post(`/lotes/${lotId}/devolver`);
  ev = await evaluateLot(db, lotId);
  await insp.post(`/lotes/${lotId}/muestras/${ev.samples[0].id}`, form());
  await analista.post(`/lotes/${lotId}/enviar`);
  assert.strictEqual((await analista.post(`/lotes/${lotId}/liberar`)).status, 403, 'solo el jefe libera');
  await jefe.post(`/lotes/${lotId}/liberar`, { decision_notes: 'Liberado para despacho' });
  ev = await evaluateLot(db, lotId);
  assert.strictEqual(ev.lot.status, 'liberado');
  const year = new Date().getFullYear();
  assert.strictEqual(ev.lot.certificate_number, `CL-${year}-0001`);

  // Un segundo lote liberado recibe el consecutivo siguiente
  r = await insp.post('/lotes', { lot_number: 'L-2611-046', product_id: prod.id, production_date: '2026-11-23' });
  const lot2 = Number(r.headers.get('location').split('/').pop());
  await insp.post(`/lotes/${lot2}/muestras`, form());
  for (const ty of types) await insp.post(`/lotes/${lot2}/pruebas`, { test_type_id: ty.id, ...aprobada(ty) });
  await analista.post(`/lotes/${lot2}/enviar`);
  await jefe.post(`/lotes/${lot2}/liberar`);
  assert.strictEqual((await evaluateLot(db, lot2)).lot.certificate_number, `CL-${year}-0002`);

  // PDF
  r = await insp.get(`/certificados/CL-${year}-0001.pdf`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-type'), 'application/pdf');
  const buf = Buffer.from(await r.arrayBuffer());
  assert.strictEqual(buf.subarray(0, 4).toString(), '%PDF');
  if (process.env.SAVE_PDF) require('node:fs').writeFileSync(process.env.SAVE_PDF, buf);

  // Las páginas cargan para cada perfil
  for (const c of [insp, analista, jefe]) {
    for (const p of ['/', `/lotes/${lotId}`, '/indicadores', '/indicadores?molde=Colada%20fr%C3%ADa&desde=2026-01-01', '/indicadores/lotes.csv', '/menu', '/certificados', '/productos', `/productos/${prod.id}`, '/pruebas', '/cuenta']) {
      assert.strictEqual((await c.get(p)).status, 200, p);
    }
  }
  assert.strictEqual((await jefe.get('/usuarios')).status, 200);
  // Archivos para instalar la app en el celular (sin iniciar sesión)
  const anon = client(base);
  for (const p of ['/sw.js', '/manifest.webmanifest', '/offline.html', '/static/app.js', '/static/icons/icon-192.png']) {
    assert.strictEqual((await anon.get(p)).status, 200, p);
  }
  // Tras guardar una muestra, la app indica qué borrador del celular puede borrar
  r = await insp.post('/lotes', { lot_number: 'L-BORRADOR', product_id: prod.id, production_date: '2026-11-24' });
  const lot3 = Number(r.headers.get('location').split('/').pop());
  r = await insp.post(`/lotes/${lot3}/muestras`, { ...form(), draft: `${lot3}-nueva` });
  assert.strictEqual(r.headers.get('location'), `/lotes/${lot3}?guardado=${lot3}-nueva`);
  assert.strictEqual((await insp.get('/usuarios')).status, 403);
});

test('una prueba nueva se vuelve obligatoria para liberar', async () => {
  const db = await testDb();
  await db.prepare("INSERT INTO test_types (code, name) VALUES ('APILAMIENTO', 'Prueba de apilamiento')").run();
  const prod = await db.prepare("SELECT id FROM products WHERE code = 'REF04-CF'").get();
  const lot = (await db.prepare("INSERT INTO lots (lot_number, product_id, production_date) VALUES ('X1', ?, '2026-11-23')").run(prod.id)).lastInsertRowid;
  const { evaluateLot } = require('../src/quality');
  const ev = await evaluateLot(db, lot);
  assert.strictEqual(ev.tests.length, 3);
  assert.ok(ev.problems.some((p) => p.includes('apilamiento')));
});
