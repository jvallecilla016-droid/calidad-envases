'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { open, tx } = require('./db');
const { evaluateLot, releaseLot, specPoints } = require('./quality');
const { certificatePdf } = require('./pdf');
const indicadores = require('./indicadores');

const ROLE_NAMES = { inspector: 'Operario / Inspector', analista: 'Analista de calidad', jefe: 'Jefe de calidad' };
const STATUS_NAMES = { en_proceso: 'En proceso', en_revision: 'En revisión', liberado: 'Liberado', rechazado: 'Rechazado' };

function createApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('trust proxy', 1);
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use('/static', express.static(path.join(__dirname, '..', 'public')));
  const pub = (f, type) => (req, res) => { res.type(type); res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, '..', 'public', f)); };
  app.get('/sw.js', pub('sw.js', 'application/javascript'));
  app.get('/manifest.webmanifest', pub('manifest.webmanifest', 'application/manifest+json'));
  app.get('/offline.html', pub('offline.html', 'html'));
  app.use(session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'strict', maxAge: 12 * 3600 * 1000 },
  }));

  app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.ROLE_NAMES = ROLE_NAMES;
    res.locals.STATUS_NAMES = STATUS_NAMES;
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    res.locals.company = process.env.COMPANY_NAME || 'Planta de Envases Plásticos';
    next();
  });

  const flash = (req, type, msg) => { req.session.flash = { type, msg }; };
  const auth = (req, res, next) => (req.session.user ? next() : res.redirect('/login'));
  const role = (...roles) => (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).render('error', { title: 'Sin permiso', message: 'Tu perfil no tiene permiso para esta acción.' });
    }
    next();
  };
  const audit = (req, action, detail) =>
    db.prepare('INSERT INTO audit_log (user_id, action, detail) VALUES (?,?,?)').run(req.session.user.id, action, detail);
  const num = (v) => {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    const n = Number(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : NaN;
  };

  // ---------- Sesión ----------
  app.get('/login', (req, res) => res.render('login', { title: 'Ingresar', error: null }));
  app.post('/login', (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(req.body.username || '').trim().toLowerCase());
    if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) {
      return res.status(401).render('login', { title: 'Ingresar', error: 'Usuario o contraseña incorrectos' });
    }
    req.session.regenerate(() => {
      req.session.user = { id: u.id, username: u.username, full_name: u.full_name, role: u.role };
      res.redirect('/');
    });
  });
  app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

  app.get('/menu', auth, (req, res) => res.render('menu', { title: 'Menú', tab: 'menu' }));
  app.get('/cuenta', auth, (req, res) => res.render('account', { title: 'Mi cuenta' }));
  app.post('/cuenta', auth, (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
    const { current, password, confirm } = req.body;
    if (!bcrypt.compareSync(String(current || ''), u.password_hash)) flash(req, 'error', 'La contraseña actual no es correcta');
    else if (!password || password.length < 8) flash(req, 'error', 'La nueva contraseña debe tener al menos 8 caracteres');
    else if (password !== confirm) flash(req, 'error', 'Las contraseñas no coinciden');
    else {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), u.id);
      flash(req, 'ok', 'Contraseña actualizada');
    }
    res.redirect('/cuenta');
  });

  // ---------- Tablero / lotes ----------
  app.get('/', auth, (req, res) => {
    const status = STATUS_NAMES[req.query.estado] ? req.query.estado : null;
    const q = String(req.query.q || '').trim();
    let sql = `SELECT l.*, p.name AS product_name, p.molde, p.code AS product_code, c.number AS certificate_number
      FROM lots l JOIN products p ON p.id = l.product_id LEFT JOIN certificates c ON c.lot_id = l.id WHERE 1=1`;
    const args = [];
    if (status) { sql += ' AND l.status = ?'; args.push(status); }
    if (q) { sql += ' AND (l.lot_number LIKE ? OR p.name LIKE ? OR c.number LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    sql += ' ORDER BY l.id DESC LIMIT 200';
    const lots = db.prepare(sql).all(...args);
    const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM lots GROUP BY status').all().map((r) => [r.status, r.n]));
    res.render('dashboard', { title: 'Lotes', lots, counts, status, q, tab: 'lotes' });
  });

  app.get('/lotes/nuevo', auth, (req, res) => {
    const products = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY code').all();
    res.render('lot_new', { title: 'Nuevo lote', products, form: {}, error: null });
  });
  app.post('/lotes', auth, (req, res) => {
    const f = req.body;
    const products = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY code').all();
    const lotNumber = String(f.lot_number || '').trim().toUpperCase();
    let error = null;
    if (!lotNumber) error = 'El número de lote es obligatorio';
    else if (!products.some((p) => p.id === Number(f.product_id))) error = 'Selecciona un producto';
    else if (!f.production_date) error = 'La fecha de producción es obligatoria';
    else if (db.prepare('SELECT 1 FROM lots WHERE lot_number = ?').get(lotNumber)) error = `El lote ${lotNumber} ya existe`;
    if (error) return res.status(400).render('lot_new', { title: 'Nuevo lote', products, form: f, error });
    const r = db.prepare(`INSERT INTO lots (lot_number, product_id, production_date, shift, machine, quantity, notes, created_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(lotNumber, Number(f.product_id), f.production_date, f.shift || null, f.machine || null,
      f.quantity ? Number(f.quantity) : null, f.notes || null, req.session.user.id);
    audit(req, 'crear_lote', lotNumber);
    flash(req, 'ok', `Lote ${lotNumber} creado. Registra las muestras y las pruebas.`);
    res.redirect(`/lotes/${r.lastInsertRowid}`);
  });

  const loadLot = (req, res, next) => {
    const ev = evaluateLot(db, Number(req.params.id));
    if (!ev) return res.status(404).render('error', { title: 'No encontrado', message: 'El lote no existe.' });
    req.ev = ev;
    next();
  };
  const editable = (req, res, next) => {
    if (req.ev.lot.status !== 'en_proceso') {
      flash(req, 'error', 'El lote ya no está en proceso; no se puede modificar.');
      return res.redirect(`/lotes/${req.ev.lot.id}`);
    }
    next();
  };

  app.get('/lotes/:id', auth, loadLot, (req, res) => {
    res.render('lot', { title: `Lote ${req.ev.lot.lot_number}`, ev: req.ev, specPoints });
  });

  // Muestras
  app.get('/lotes/:id/muestras/nueva', auth, loadLot, editable, (req, res) => {
    const next = (db.prepare('SELECT COALESCE(MAX(sample_no),0)+1 AS n FROM samples WHERE lot_id = ?').get(req.ev.lot.id)).n;
    res.render('sample_form', { title: 'Registrar muestra', ev: req.ev, sample: null, sampleNo: next, specPoints, values: {}, error: null });
  });
  app.get('/lotes/:id/muestras/:sid/editar', auth, loadLot, editable, (req, res) => {
    const sample = req.ev.samples.find((s) => s.id === Number(req.params.sid));
    if (!sample) return res.redirect(`/lotes/${req.ev.lot.id}`);
    const values = {};
    for (const [k, v] of Object.entries(sample.values)) values[k] = v ? v.value : '';
    res.render('sample_form', { title: `Editar muestra ${sample.sample_no}`, ev: req.ev, sample, sampleNo: sample.sample_no, specPoints, values, error: null });
  });
  const saveSample = (req, res) => {
    const ev = req.ev;
    const existing = req.params.sid ? ev.samples.find((s) => s.id === Number(req.params.sid)) : null;
    const readings = [];
    const values = {};
    let error = null;
    for (const spec of ev.specs) {
      for (const pt of specPoints(spec)) {
        const key = `${spec.id}|${pt}`;
        const raw = req.body[`m_${spec.id}_${pt || 'X'}`];
        values[key] = raw;
        const v = num(raw);
        if (v === null) { error = error || `Falta el valor de ${spec.characteristic}${pt ? ' punto ' + pt : ''}`; continue; }
        if (Number.isNaN(v) || v < 0) { error = error || `Valor inválido en ${spec.characteristic}${pt ? ' punto ' + pt : ''}`; continue; }
        readings.push([spec, pt, v]);
      }
    }
    if (error) {
      return res.status(400).render('sample_form', {
        title: 'Registrar muestra', ev, sample: existing, sampleNo: existing ? existing.sample_no : Number(req.body.sample_no) || 1,
        specPoints, values, error,
      });
    }
    tx(db, () => {
      let sampleId;
      if (existing) {
        sampleId = existing.id;
        db.prepare('DELETE FROM measurements WHERE sample_id = ?').run(sampleId);
      } else {
        const n = db.prepare('SELECT COALESCE(MAX(sample_no),0)+1 AS n FROM samples WHERE lot_id = ?').get(ev.lot.id).n;
        sampleId = db.prepare('INSERT INTO samples (lot_id, sample_no, taken_by) VALUES (?,?,?)').run(ev.lot.id, n, req.session.user.id).lastInsertRowid;
      }
      const ins = db.prepare('INSERT INTO measurements (sample_id, spec_id, point, value, lic, lsc) VALUES (?,?,?,?,?,?)');
      for (const [spec, pt, v] of readings) ins.run(sampleId, spec.id, pt, v, spec.lic, spec.lsc);
    });
    audit(req, existing ? 'editar_muestra' : 'registrar_muestra', ev.lot.lot_number);
    const after = evaluateLot(db, ev.lot.id);
    const s = existing ? after.samples.find((x) => x.id === existing.id) : after.samples[after.samples.length - 1];
    flash(req, s.ok ? 'ok' : 'error', s.ok ? `Muestra ${s.sample_no} guardada: CONFORME` : `Muestra ${s.sample_no} guardada: tiene lecturas FUERA de especificación`);
    const draft = /^[0-9]+-(nueva|[0-9]+)$/.test(String(req.body.draft || '')) ? `?guardado=${req.body.draft}` : '';
    res.redirect(`/lotes/${ev.lot.id}${draft}`);
  };
  app.post('/lotes/:id/muestras', auth, loadLot, editable, saveSample);
  app.post('/lotes/:id/muestras/:sid', auth, loadLot, editable, saveSample);
  app.post('/lotes/:id/muestras/:sid/eliminar', role('analista', 'jefe'), loadLot, editable, (req, res) => {
    db.prepare('DELETE FROM samples WHERE id = ? AND lot_id = ?').run(Number(req.params.sid), req.ev.lot.id);
    audit(req, 'eliminar_muestra', req.ev.lot.lot_number);
    flash(req, 'ok', 'Muestra eliminada');
    res.redirect(`/lotes/${req.ev.lot.id}`);
  });

  // Pruebas de liberación
  app.post('/lotes/:id/pruebas', auth, loadLot, editable, (req, res) => {
    const typeId = Number(req.body.test_type_id);
    const result = req.body.result;
    const type = db.prepare('SELECT * FROM test_types WHERE id = ? AND active = 1').get(typeId);
    if (!type || !['pasa', 'no_pasa'].includes(result)) {
      flash(req, 'error', 'Selecciona la prueba y el resultado');
      return res.redirect(`/lotes/${req.ev.lot.id}`);
    }
    db.prepare(`INSERT INTO test_results (lot_id, test_type_id, result, observations, performed_by) VALUES (?,?,?,?,?)
      ON CONFLICT (lot_id, test_type_id) DO UPDATE SET result = excluded.result, observations = excluded.observations,
      performed_by = excluded.performed_by, performed_at = datetime('now','localtime')`)
      .run(req.ev.lot.id, typeId, result, (req.body.observations || '').trim() || null, req.session.user.id);
    audit(req, 'registrar_prueba', `${req.ev.lot.lot_number} ${type.code}=${result}`);
    flash(req, result === 'pasa' ? 'ok' : 'error', `${type.name}: ${result === 'pasa' ? 'PASA' : 'NO PASA'}`);
    res.redirect(`/lotes/${req.ev.lot.id}`);
  });

  // Flujo de aprobación
  app.post('/lotes/:id/enviar', role('analista', 'jefe'), loadLot, editable, (req, res) => {
    if (!req.ev.complete) {
      flash(req, 'error', 'Faltan mediciones o pruebas para enviar el lote a aprobación.');
      return res.redirect(`/lotes/${req.ev.lot.id}`);
    }
    db.prepare(`UPDATE lots SET status = 'en_revision', submitted_by = ?, submitted_at = datetime('now','localtime') WHERE id = ?`)
      .run(req.session.user.id, req.ev.lot.id);
    audit(req, 'enviar_aprobacion', req.ev.lot.lot_number);
    flash(req, 'ok', 'Lote enviado al jefe de calidad para aprobación');
    res.redirect(`/lotes/${req.ev.lot.id}`);
  });
  app.post('/lotes/:id/devolver', role('analista', 'jefe'), loadLot, (req, res) => {
    if (req.ev.lot.status !== 'en_revision') return res.redirect(`/lotes/${req.ev.lot.id}`);
    db.prepare(`UPDATE lots SET status = 'en_proceso', submitted_by = NULL, submitted_at = NULL WHERE id = ?`).run(req.ev.lot.id);
    audit(req, 'devolver_lote', req.ev.lot.lot_number);
    flash(req, 'ok', 'Lote devuelto a proceso para corrección');
    res.redirect(`/lotes/${req.ev.lot.id}`);
  });
  app.post('/lotes/:id/liberar', role('jefe'), loadLot, (req, res) => {
    try {
      const number = releaseLot(db, req.ev.lot.id, req.session.user, (req.body.decision_notes || '').trim());
      flash(req, 'ok', `Lote liberado. Certificado ${number} emitido.`);
    } catch (e) {
      flash(req, 'error', e.message);
    }
    res.redirect(`/lotes/${req.ev.lot.id}`);
  });
  app.post('/lotes/:id/rechazar', role('jefe'), loadLot, (req, res) => {
    if (!['en_revision', 'en_proceso'].includes(req.ev.lot.status)) return res.redirect(`/lotes/${req.ev.lot.id}`);
    const notes = (req.body.decision_notes || '').trim();
    if (!notes) {
      flash(req, 'error', 'Escribe el motivo del rechazo');
      return res.redirect(`/lotes/${req.ev.lot.id}`);
    }
    db.prepare(`UPDATE lots SET status = 'rechazado', decided_by = ?, decided_at = datetime('now','localtime'), decision_notes = ? WHERE id = ?`)
      .run(req.session.user.id, notes, req.ev.lot.id);
    audit(req, 'rechazar_lote', `${req.ev.lot.lot_number}: ${notes}`);
    flash(req, 'ok', 'Lote rechazado');
    res.redirect(`/lotes/${req.ev.lot.id}`);
  });

  // ---------- Certificados ----------
  app.get('/certificados', auth, (req, res) => {
    const certs = db.prepare(`SELECT c.number, c.issued_at, l.id AS lot_id, l.lot_number, p.name AS product_name, p.molde, u.full_name AS issued_by_name
      FROM certificates c JOIN lots l ON l.id = c.lot_id JOIN products p ON p.id = l.product_id LEFT JOIN users u ON u.id = c.issued_by
      ORDER BY c.year DESC, c.seq DESC`).all();
    res.render('certificates', { title: 'Certificados', certs });
  });
  app.get('/certificados/:number.pdf', auth, (req, res) => {
    const c = db.prepare('SELECT * FROM certificates WHERE number = ?').get(req.params.number);
    if (!c) return res.status(404).render('error', { title: 'No encontrado', message: 'Certificado no encontrado.' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${c.number}.pdf"`);
    certificatePdf(JSON.parse(c.snapshot), res);
  });

  // ---------- Indicadores ----------
  app.get('/indicadores', auth, (req, res) => {
    const ind = indicadores.calcular(db, req.query);
    const products = db.prepare('SELECT id, code, name, molde FROM products ORDER BY code').all();
    const qs = new URLSearchParams(Object.entries(ind.filtros).filter(([, v]) => v).map(([k, v]) => [k, String(v)])).toString();
    res.render('indicadores', { title: 'Indicadores', ind, products, qs, tab: 'indicadores' });
  });
  app.get('/indicadores/lotes.csv', auth, (req, res) => {
    const ind = indicadores.calcular(db, req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="lotes-indicadores.csv"');
    res.send(indicadores.csvLotes(ind.lotes));
  });

  // ---------- Catálogo de productos ----------
  app.get('/productos', auth, (req, res) => {
    const products = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM specs s WHERE s.product_id = p.id) AS n_specs
      FROM products p ORDER BY p.active DESC, p.code`).all();
    res.render('products', { title: 'Productos y especificaciones', products });
  });
  app.get('/productos/nuevo', role('analista', 'jefe'), (req, res) =>
    res.render('product_form', { title: 'Nuevo producto', product: {}, specs: [], error: null }));
  app.get('/productos/:id', auth, (req, res) => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
    if (!product) return res.status(404).render('error', { title: 'No encontrado', message: 'Producto no encontrado.' });
    const specs = db.prepare('SELECT * FROM specs WHERE product_id = ? ORDER BY sort, id').all(product.id);
    res.render('product_form', { title: product.name, product, specs, error: null });
  });
  const saveProduct = (req, res) => {
    const id = req.params.id ? Number(req.params.id) : null;
    const b = req.body;
    const product = { id, code: String(b.code || '').trim().toUpperCase(), name: String(b.name || '').trim(), referencia: b.referencia,
      capacidad: b.capacidad, molde: b.molde, uso: b.uso, active: b.active ? 1 : 0 };
    const arr = (x) => (Array.isArray(x) ? x : x === undefined ? [] : [x]);
    const rows = arr(b.s_characteristic).map((c, i) => ({
      id: Number(arr(b.s_id)[i]) || null, component: arr(b.s_component)[i], characteristic: String(c || '').trim(),
      unit: arr(b.s_unit)[i], points: arr(b.s_points)[i] === '8' ? 'A,B,C,D,E,F,G,H' : '',
      lic: num(arr(b.s_lic)[i]), lcc: num(arr(b.s_lcc)[i]), lsc: num(arr(b.s_lsc)[i]),
    })).filter((r) => r.characteristic);
    let error = null;
    if (!product.code || !product.name || !product.molde) error = 'Código, nombre y tipo de molde son obligatorios';
    for (const r of rows) {
      if (r.lic === null || r.lsc === null || Number.isNaN(r.lic) || Number.isNaN(r.lsc) || Number.isNaN(r.lcc)) error = error || `Límites inválidos en "${r.characteristic}"`;
      else if (r.lic > r.lsc) error = error || `En "${r.characteristic}" el LIC es mayor que el LSC`;
      else if (r.lcc !== null && (r.lcc < r.lic || r.lcc > r.lsc)) error = error || `En "${r.characteristic}" el LCC está fuera de LIC–LSC`;
    }
    const dup = db.prepare('SELECT id FROM products WHERE code = ?').get(product.code);
    if (dup && dup.id !== id) error = error || `Ya existe un producto con código ${product.code}`;
    if (error) return res.status(400).render('product_form', { title: product.name || 'Producto', product, specs: rows, error });

    const savedId = tx(db, () => {
      let pid = id;
      if (pid) {
        db.prepare('UPDATE products SET code=?, name=?, referencia=?, capacidad=?, molde=?, uso=?, active=? WHERE id=?')
          .run(product.code, product.name, product.referencia || null, product.capacidad || null, product.molde, product.uso || null, product.active, pid);
      } else {
        pid = db.prepare('INSERT INTO products (code, name, referencia, capacidad, molde, uso, active) VALUES (?,?,?,?,?,?,1)')
          .run(product.code, product.name, product.referencia || null, product.capacidad || null, product.molde, product.uso || null).lastInsertRowid;
      }
      const keep = rows.filter((r) => r.id).map((r) => r.id);
      const current = db.prepare('SELECT id FROM specs WHERE product_id = ?').all(pid).map((r) => r.id);
      for (const sid of current) {
        if (keep.includes(sid)) continue;
        const used = db.prepare('SELECT 1 FROM measurements WHERE spec_id = ? LIMIT 1').get(sid);
        if (used) throw new Error('No se puede borrar una especificación que ya tiene mediciones registradas. Cambia sus límites en su lugar.');
        db.prepare('DELETE FROM specs WHERE id = ?').run(sid);
      }
      rows.forEach((r, i) => {
        if (r.id && current.includes(r.id)) {
          db.prepare('UPDATE specs SET component=?, characteristic=?, unit=?, points=?, lic=?, lcc=?, lsc=?, sort=? WHERE id=?')
            .run(r.component, r.characteristic, r.unit, r.points, r.lic, r.lcc, r.lsc, i, r.id);
        } else {
          db.prepare('INSERT INTO specs (product_id, component, characteristic, unit, points, lic, lcc, lsc, sort) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(pid, r.component, r.characteristic, r.unit, r.points, r.lic, r.lcc, r.lsc, i);
        }
      });
      return pid;
    });
    audit(req, id ? 'editar_producto' : 'crear_producto', product.code);
    flash(req, 'ok', 'Producto guardado');
    res.redirect(`/productos/${savedId}`);
  };
  const safe = (fn) => (req, res, next) => {
    try { fn(req, res, next); } catch (e) {
      flash(req, 'error', e.message);
      res.redirect(req.get('referer') || '/');
    }
  };
  app.post('/productos', role('analista', 'jefe'), safe(saveProduct));
  app.post('/productos/:id', role('analista', 'jefe'), safe(saveProduct));

  // ---------- Tipos de prueba ----------
  app.get('/pruebas', auth, (req, res) => {
    res.render('tests', { title: 'Pruebas de liberación', types: db.prepare('SELECT * FROM test_types ORDER BY active DESC, id').all() });
  });
  app.post('/pruebas', role('analista', 'jefe'), (req, res) => {
    const name = String(req.body.name || '').trim();
    const code = String(req.body.code || name).trim().toUpperCase().normalize('NFD').replace(/[^A-Z0-9]/g, '_');
    if (!name) flash(req, 'error', 'Escribe el nombre de la prueba');
    else if (db.prepare('SELECT 1 FROM test_types WHERE code = ?').get(code)) flash(req, 'error', 'Ya existe una prueba con ese código');
    else {
      db.prepare('INSERT INTO test_types (code, name, description) VALUES (?,?,?)').run(code, name, req.body.description || null);
      audit(req, 'crear_prueba', code);
      flash(req, 'ok', `Prueba "${name}" agregada. Desde ahora es obligatoria para liberar lotes.`);
    }
    res.redirect('/pruebas');
  });
  app.post('/pruebas/:id/estado', role('analista', 'jefe'), (req, res) => {
    db.prepare('UPDATE test_types SET active = 1 - active WHERE id = ?').run(Number(req.params.id));
    audit(req, 'cambiar_estado_prueba', req.params.id);
    res.redirect('/pruebas');
  });

  // ---------- Usuarios (jefe de calidad) ----------
  app.get('/usuarios', role('jefe'), (req, res) => {
    res.render('users', { title: 'Usuarios', users: db.prepare('SELECT * FROM users ORDER BY active DESC, role, username').all() });
  });
  app.post('/usuarios', role('jefe'), (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    const { full_name, role: r, password } = req.body;
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) flash(req, 'error', 'Usuario inválido (3–30 letras, números, punto o guion)');
    else if (!full_name || !ROLE_NAMES[r]) flash(req, 'error', 'Nombre y perfil son obligatorios');
    else if (!password || password.length < 8) flash(req, 'error', 'La contraseña debe tener al menos 8 caracteres');
    else if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) flash(req, 'error', 'Ese usuario ya existe');
    else {
      db.prepare('INSERT INTO users (username, full_name, role, password_hash) VALUES (?,?,?,?)').run(username, full_name.trim(), r, bcrypt.hashSync(password, 10));
      audit(req, 'crear_usuario', username);
      flash(req, 'ok', `Usuario ${username} creado`);
    }
    res.redirect('/usuarios');
  });
  app.post('/usuarios/:id', role('jefe'), (req, res) => {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) return res.redirect('/usuarios');
    const { full_name, role: r, password } = req.body;
    const active = req.body.active ? 1 : 0;
    if (id === req.session.user.id && (r !== 'jefe' || !active)) {
      flash(req, 'error', 'No puedes quitarte el perfil de jefe ni desactivar tu propio usuario');
      return res.redirect('/usuarios');
    }
    if (!ROLE_NAMES[r] || !full_name) { flash(req, 'error', 'Datos inválidos'); return res.redirect('/usuarios'); }
    db.prepare('UPDATE users SET full_name = ?, role = ?, active = ? WHERE id = ?').run(full_name.trim(), r, active, id);
    if (password) {
      if (password.length < 8) { flash(req, 'error', 'La contraseña debe tener al menos 8 caracteres'); return res.redirect('/usuarios'); }
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), id);
    }
    audit(req, 'editar_usuario', u.username);
    flash(req, 'ok', `Usuario ${u.username} actualizado`);
    res.redirect('/usuarios');
  });

  app.use((req, res) => res.status(404).render('error', { title: 'No encontrado', message: 'La página no existe.' }));
  app.use((err, req, res, _next) => {
    console.error(err);
    res.status(500).render('error', { title: 'Error', message: 'Ocurrió un error inesperado.' });
  });
  return app;
}

if (require.main === module) {
  const db = open();
  const port = Number(process.env.PORT) || 3000;
  createApp(db).listen(port, () => console.log(`App de calidad lista en http://localhost:${port}`));
}

module.exports = { createApp };
