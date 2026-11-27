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
  // Mínimo 5 muestras por lote
  assert.ok(ev.problems.some((p) => p.includes('Faltan 3 muestra(s)')));
  for (let i = 0; i < 3; i++) await insp.post(`/lotes/${lotId}/muestras`, form());
  ev = await evaluateLot(db, lotId);
  assert.strictEqual(ev.samples.length, 5);
  assert.ok(!ev.problems.some((p) => p.includes('Faltan')));

  // Pruebas
  const types = await db.prepare('SELECT * FROM test_types').all();
  // Datos de una prueba aprobada: casillas para impacto, resultado simple para las demás.
  const aprobada = (ty) => {
    const f = {};
    for (let u = 1; u <= (ty.units || 1); u++) {
      if (ty.checks) for (let i = 1; i <= ty.checks; i++) f[`chk_${u}_${i}`] = 'si';
      else f[`res_${u}`] = 'pasa';
    }
    return f;
  };
  // Envase u con las casillas dadas ('1' resistió, '0' falló)
  const envases = (lista) => Object.fromEntries(lista.flatMap((g, u) => [...g].map((v, i) => [`chk_${u + 1}_${i + 1}`, v === '1' ? 'si' : 'no'])));
  const impacto = types.find((t) => t.code === 'IMPACTO');
  assert.deepStrictEqual([impacto.checks, impacto.min_ok], [4, 2], 'impacto: 4 casillas, pasa con 2');
  assert.strictEqual(specs.filter((s) => s.points).every((s) => s.points === 'A,B,C,D'), true, 'diámetros en 4 puntos');

  assert.deepStrictEqual(types.filter((t) => ['IMPACTO', 'FILTRACION'].includes(t.code)).map((t) => t.units), [5, 5], '5 envases en impacto y filtración');
  const filtracion = types.find((t) => t.code === 'FILTRACION');

  // Impacto: si falta un envase no se guarda
  await insp.post(`/lotes/${lotId}/pruebas`, { test_type_id: impacto.id, ...envases(['1111', '1111', '1111', '1111']) });
  assert.strictEqual(await db.prepare('SELECT 1 FROM test_results WHERE lot_id = ? AND test_type_id = ?').get(lotId, impacto.id), undefined);
  // Un envase con 1 de 4 resistidos: no pasa
  // Envase 5 falla en la primera caída: aunque se marquen las siguientes, no cuentan (se cuentan en orden)
  await insp.post(`/lotes/${lotId}/pruebas`, { test_type_id: impacto.id, ...envases(['1111', '1100', '1110', '1111', '0111']) });
  let tr = await db.prepare('SELECT * FROM test_results WHERE lot_id = ? AND test_type_id = ?').get(lotId, impacto.id);
  assert.deepStrictEqual([tr.result, tr.score, tr.detail], ['no_pasa', 4, '1,1,1,1;1,1,0,0;1,1,1,0;1,1,1,1;0,0,0,0']);
  // Un envase que falla en la segunda caída (solo resistió 1) no se aprueba
  await insp.post(`/lotes/${lotId}/pruebas`, { test_type_id: impacto.id, ...envases(['1111', '1000', '1110', '1111', '1111']) });
  tr = await db.prepare('SELECT * FROM test_results WHERE lot_id = ? AND test_type_id = ?').get(lotId, impacto.id);
  assert.deepStrictEqual([tr.result, tr.score], ['no_pasa', 4]);
  // Los 5 envases con 2 o más resistidos: pasa
  await insp.post(`/lotes/${lotId}/pruebas`, { test_type_id: impacto.id, ...envases(['1111', '1100', '1110', '1111', '1100']) });
  tr = await db.prepare('SELECT * FROM test_results WHERE lot_id = ? AND test_type_id = ?').get(lotId, impacto.id);
  assert.deepStrictEqual([tr.result, tr.score], ['pasa', 5]);
  // Filtración: 5 envases; uno que no pasa reprueba
  await insp.post(`/lotes/${lotId}/pruebas`, { test_type_id: filtracion.id, res_1: 'pasa', res_2: 'pasa', res_3: 'no_pasa', res_4: 'pasa', res_5: 'pasa' });
  tr = await db.prepare('SELECT * FROM test_results WHERE lot_id = ? AND test_type_id = ?').get(lotId, filtracion.id);
  assert.deepStrictEqual([tr.result, tr.detail], ['no_pasa', '1;1;0;1;1']);
  assert.ok((await (await insp.get(`/lotes/${lotId}`)).text()).includes('Envase 5'));
  assert.ok((await (await insp.get(`/lotes/${lotId}`)).text()).includes('Impacto 4'));

  // Inspección visual: rotos, manchados, producto incompleto; un solo defecto la reprueba
  const visual = types.find((t) => t.code === 'VISUAL');
  assert.deepStrictEqual([visual.items, visual.checks, visual.min_ok], ['Rotos,Manchas,Producto incompleto', 3, 3]);
  assert.ok((await (await insp.get(`/lotes/${lotId}`)).text()).includes('Producto incompleto'));
  await insp.post(`/lotes/${lotId}/pruebas`, { test_type_id: visual.id, chk_1_1: 'si', chk_1_2: 'no', chk_1_3: 'si' });
  tr = await db.prepare('SELECT * FROM test_results WHERE lot_id = ? AND test_type_id = ?').get(lotId, visual.id);
  assert.deepStrictEqual([tr.result, tr.detail], ['no_pasa', '1,0,1']);
  assert.ok((await db.prepare("SELECT detail FROM audit_log WHERE action = 'registrar_prueba' ORDER BY id DESC").get()).detail.includes('defectos: Manchas'));

  for (const ty of types) await insp.post(`/lotes/${lotId}/pruebas`, { test_type_id: ty.id, observations: 'OK', ...aprobada(ty) });

  // Un lote no conforme no emite certificado
  await insp.post(`/lotes/${lotId}/liberar`);
  assert.strictEqual((await evaluateLot(db, lotId)).lot.status, 'en_proceso');

  // Se corrige la muestra 1 y el aprendiz emite el certificado
  ev = await evaluateLot(db, lotId);
  await insp.post(`/lotes/${lotId}/muestras/${ev.samples[0].id}`, form());
  await insp.post(`/lotes/${lotId}/liberar`, { decision_notes: 'Liberado para despacho' });
  ev = await evaluateLot(db, lotId);
  assert.strictEqual(ev.lot.status, 'liberado');
  const year = new Date().getFullYear();
  assert.strictEqual(ev.lot.certificate_number, `CL-${year}-0001`);
  assert.ok((await (await insp.get(`/lotes/${lotId}`)).text()).includes('Imprimir certificado'));

  // Le llega al jefe para su visto bueno; solo un jefe puede darlo
  assert.ok((await (await jefe.get('/')).text()).includes('esperando tu visto bueno'));
  assert.ok((await (await jefe.get('/certificados?pendientes=1')).text()).includes(`CL-${year}-0001`));
  assert.strictEqual((await analista.post(`/certificados/CL-${year}-0001/visto-bueno`)).status, 403);
  await jefe.post(`/certificados/CL-${year}-0001/visto-bueno`);
  const cert = await db.prepare('SELECT reviewed_by, reviewed_at FROM certificates WHERE number = ?').get(`CL-${year}-0001`);
  assert.ok(cert.reviewed_by && cert.reviewed_at);
  assert.ok(!(await (await jefe.get('/')).text()).includes('esperando tu visto bueno'));

  // Un segundo lote liberado recibe el consecutivo siguiente
  r = await insp.post('/lotes', { lot_number: 'L-2611-046', product_id: prod.id, production_date: '2026-11-23' });
  const lot2 = Number(r.headers.get('location').split('/').pop());
  for (let i = 0; i < 5; i++) await insp.post(`/lotes/${lot2}/muestras`, form());
  for (const ty of types) await insp.post(`/lotes/${lot2}/pruebas`, { test_type_id: ty.id, ...aprobada(ty) });
  await analista.post(`/lotes/${lot2}/liberar`);
  assert.strictEqual((await evaluateLot(db, lot2)).lot.certificate_number, `CL-${year}-0002`);

  // PDF
  r = await insp.get(`/certificados/CL-${year}-0001.pdf`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-type'), 'application/pdf');
  assert.match(r.headers.get('cache-control'), /no-store/);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.strictEqual(buf.subarray(0, 4).toString(), '%PDF');
  if (process.env.SAVE_PDF) require('node:fs').writeFileSync(process.env.SAVE_PDF, buf);

  // Las páginas cargan para cada perfil
  for (const c of [insp, analista, jefe]) {
    for (const p of ['/', `/lotes/${lotId}`, '/indicadores', '/indicadores?molde=Colada%20fr%C3%ADa&desde=2026-01-01', '/indicadores/lotes.csv', '/menu', '/certificados', '/productos', `/productos/${prod.id}`, '/pruebas', '/cuenta']) {
      assert.strictEqual((await c.get(p)).status, 200, p);
    }
  }
  assert.strictEqual((await jefe.get('/usuarios')).status, 403, 'el jefe genérico no administra usuarios');
  // Archivos para instalar la app en el celular (sin iniciar sesión)
  const anon = client(base);
  for (const p of ['/sw.js', '/manifest.webmanifest', '/offline.html', '/static/app.js', '/static/icons/cg-192.png', '/favicon.ico']) {
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
  assert.strictEqual(ev.tests.length, 4);
  assert.ok(ev.problems.some((p) => p.includes('apilamiento')));
});

test('usuarios del equipo deben cambiar la contraseña inicial', async (t) => {
  const db = await testDb();
  const server = createApp(db).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const team = await db.prepare("SELECT username, full_name, role, must_change FROM users WHERE must_change = 1 ORDER BY id").all();
  assert.deepStrictEqual(team.map((u) => [u.username, u.full_name, u.role]), [
    ['lgomez', 'Luis Eduardo Gómez', 'jefe'],
    ['jcvallecilla', 'Juan Camilo Vallecilla', 'analista'],
    ['paola', 'Paola', 'analista'],
    ['ncastellanos', 'Nicolás Castellanos', 'inspector'],
  ]);

  const c = client(base);
  assert.strictEqual((await c.post('/login', { username: 'lgomez', password: DEFAULT_PASSWORD })).status, 302);
  assert.strictEqual((await c.get('/')).headers.get('location'), '/cuenta');
  assert.strictEqual((await c.post('/lotes', { lot_number: 'X' })).status, 403);
  const r = await c.post('/cuenta', { current: DEFAULT_PASSWORD, password: 'ClaveLuis2026', confirm: 'ClaveLuis2026' });
  assert.strictEqual(r.headers.get('location'), '/');
  assert.strictEqual((await c.get('/')).status, 200);
  assert.strictEqual((await db.prepare("SELECT must_change FROM users WHERE username = 'lgomez'").get()).must_change, 0);
  assert.strictEqual((await c.get('/usuarios')).status, 200, 'Luis administra usuarios');
});

test('solo Luis (administrador) elimina lotes y usuarios', async (t) => {
  const db = await testDb();
  const server = createApp(db).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u) => { const c = client(base); await c.post('/login', { username: u, password: DEFAULT_PASSWORD }); return c; };
  const jefeGen = await login('jefe');
  const jefe = await login('lgomez');
  await jefe.post('/cuenta', { current: DEFAULT_PASSWORD, password: 'ClaveLuis2026', confirm: 'ClaveLuis2026' });
  const insp = await login('inspector');
  const prod = await db.prepare("SELECT id FROM products WHERE code = 'REF04-CF'").get();
  await insp.post('/lotes', { lot_number: 'PRUEBA-1', product_id: prod.id, production_date: '2026-11-24' });
  const lot = await db.prepare("SELECT id FROM lots WHERE lot_number = 'PRUEBA-1'").get();
  await insp.post(`/lotes/${lot.id}/muestras`, {});

  // El inspector no puede eliminar; el jefe debe escribir el número exacto
  assert.strictEqual((await insp.post(`/lotes/${lot.id}/eliminar`, { confirm: 'PRUEBA-1' })).status, 403);
  assert.strictEqual((await jefeGen.post(`/lotes/${lot.id}/eliminar`, { confirm: 'PRUEBA-1' })).status, 403, 'el jefe genérico no elimina');
  assert.strictEqual((await jefeGen.post('/usuarios', { username: 'nuevo', full_name: 'X', role: 'inspector', password: '12345678' })).status, 403);
  await jefe.post(`/lotes/${lot.id}/eliminar`, { confirm: 'otro' });
  assert.ok(await db.prepare('SELECT 1 FROM lots WHERE id = ?').get(lot.id));

  // Usuario con un lote a su nombre: se desactiva, no se borra
  const inspId = (await db.prepare("SELECT id FROM users WHERE username = 'inspector'").get()).id;
  await jefe.post(`/usuarios/${inspId}/eliminar`);
  assert.strictEqual((await db.prepare('SELECT active FROM users WHERE id = ?').get(inspId)).active, 0);

  await jefe.post(`/lotes/${lot.id}/eliminar`, { confirm: 'PRUEBA-1' });
  assert.strictEqual(await db.prepare('SELECT 1 FROM lots WHERE id = ?').get(lot.id), undefined);
  assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM samples').get()).n, 0);

  // Sin registros de calidad: se elimina y el historial conserva su nombre
  await jefe.post(`/usuarios/${inspId}/eliminar`);
  assert.strictEqual(await db.prepare('SELECT 1 FROM users WHERE id = ?').get(inspId), undefined);
  assert.ok(await db.prepare("SELECT 1 FROM audit_log WHERE detail LIKE '[inspector]%'").get());
  // Nadie puede eliminarse a sí mismo
  const jefeId = (await db.prepare("SELECT id FROM users WHERE username = 'lgomez'").get()).id;
  await jefe.post(`/usuarios/${jefeId}/eliminar`);
  assert.ok(await db.prepare('SELECT 1 FROM users WHERE id = ?').get(jefeId));
});

test('certificados antiguos sin mínimo de impacto se evalúan con 2 caídas', async () => {
  const { open } = require('../src/db');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cal-')), 'c.db');
  let db = await open(file);
  const lot = (await db.prepare("INSERT INTO lots (lot_number, product_id, production_date) VALUES ('V1', 1, '2026-11-24')").run()).lastInsertRowid;
  const snap = { tests: [{ name: 'Prueba de impacto', checks: 4, detail: '1,1,1,0;1,1,1,1' }] };
  await db.prepare("INSERT INTO certificates (number, year, seq, lot_id, snapshot) VALUES ('CL-2026-0009', 2026, 9, ?, ?)").run(lot, JSON.stringify(snap));
  await db.prepare("UPDATE meta SET value = '8' WHERE key = 'version'").run();
  await db.close();
  db = await open(file);
  const s = JSON.parse((await db.prepare("SELECT snapshot FROM certificates WHERE number = 'CL-2026-0009'").get()).snapshot);
  assert.strictEqual(s.tests[0].min_ok, 2);
  await db.close();
});

test('evidencia fotográfica en lote rechazado', async (t) => {
  const db = await testDb();
  const server = createApp(db).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (u) => { const c = client(base); await c.post('/login', { username: u, password: DEFAULT_PASSWORD }); return c; };
  const insp = await login('inspector');
  const jefe = await login('jefe');
  const prod = await db.prepare("SELECT id FROM products WHERE code = 'REF04-CF'").get();
  await insp.post('/lotes', { lot_number: 'FOTO-1', product_id: prod.id, production_date: '2026-11-26' });
  const lot = await db.prepare("SELECT id FROM lots WHERE lot_number = 'FOTO-1'").get();

  // PNG 1x1 válido
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await insp.post(`/lotes/${lot.id}/fotos`, { photo: 'data:image/png;base64,' + png, caption: 'Envase roto en la base' });
  await insp.post(`/lotes/${lot.id}/fotos`, { photo: 'no es una foto' });
  const fotos = await db.prepare('SELECT id, caption FROM lot_photos WHERE lot_id = ?').all(lot.id);
  assert.strictEqual(fotos.length, 1);
  assert.strictEqual(fotos[0].caption, 'Envase roto en la base');

  const img = await insp.get(`/fotos/${fotos[0].id}`);
  assert.strictEqual(img.headers.get('content-type'), 'image/png');
  assert.strictEqual(Buffer.from(await img.arrayBuffer()).toString('base64'), png);
  assert.match(await (await insp.get(`/lotes/${lot.id}`)).text(), /Envase roto en la base/);

  // Antes del rechazo no hay informe
  assert.strictEqual((await jefe.get(`/lotes/${lot.id}/informe.pdf`)).status, 302);
  await jefe.post(`/lotes/${lot.id}/rechazar`, { decision_notes: 'Envases rotos' });
  const pdf = await jefe.get(`/lotes/${lot.id}/informe.pdf`);
  assert.strictEqual(pdf.status, 200);
  assert.strictEqual(pdf.headers.get('content-type'), 'application/pdf');
  const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.ok(bytes.subarray(0, 4).toString() === '%PDF');
  assert.match(await (await jefe.get(`/lotes/${lot.id}`)).text(), /Informe de rechazo \(PDF\)/);

  // El aprendiz no elimina fotos; el jefe sí
  await insp.post(`/fotos/${fotos[0].id}/eliminar`);
  assert.ok(await db.prepare('SELECT 1 FROM lot_photos WHERE id = ?').get(fotos[0].id));
  await jefe.post(`/fotos/${fotos[0].id}/eliminar`);
  assert.strictEqual(await db.prepare('SELECT 1 FROM lot_photos WHERE id = ?').get(fotos[0].id), undefined);
});
