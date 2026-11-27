'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { open, tx, parseItems } = require('./db');
const { evaluateLot, releaseLot, specPoints, resisted } = require('./quality');
const { certificatePdf, lotReportPdf } = require('./pdf');
const indicadores = require('./indicadores');

// Cambia en cada despliegue: se agrega a los enlaces del PDF para no usar copias guardadas.
const APP_VERSION = process.env.RENDER_GIT_COMMIT ? process.env.RENDER_GIT_COMMIT.slice(0, 7) : String(Date.now());
const ROLE_NAMES = { inspector: 'Aprendiz / Operario', analista: 'Auxiliar de calidad', jefe: 'Jefe de calidad' };
const STATUS_NAMES = { en_proceso: 'En proceso', en_revision: 'En revisión', liberado: 'Liberado', rechazado: 'Rechazado' };

function createApp(db) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('trust proxy', 1);
  app.set('views', path.join(__dirname, '..', 'views'));
  // Límite amplio para las fotos de evidencia (se reducen en el celular antes de enviarlas).
  app.use(express.urlencoded({ extended: true, limit: '8mb' }));
  app.use('/static', express.static(path.join(__dirname, '..', 'public')));
  const pub = (f, type) => async (req, res) => { res.type(type); res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, '..', 'public', f)); };
  app.get('/sw.js', pub('sw.js', 'application/javascript'));
  app.get('/manifest.webmanifest', pub('manifest.webmanifest', 'application/manifest+json'));
  app.get('/favicon.ico', pub('icons/cg-32.png', 'image/png'));
  app.get('/offline.html', pub('offline.html', 'html'));
  // Con PostgreSQL las sesiones se guardan en la base: nadie pierde su sesión cuando el servidor se reinicia.
  const store = db.kind === 'pg'
    ? new (require('connect-pg-simple')(session))({ pool: db.pool, createTableIfMissing: true })
    : undefined;
  app.use(session({
    store,
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 12 * 3600 * 1000 },
  }));

  app.use(async (req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.ROLE_NAMES = ROLE_NAMES;
    res.locals.STATUS_NAMES = STATUS_NAMES;
    res.locals.flash = req.session.flash || null;
    res.locals.v = APP_VERSION;
    delete req.session.flash;
    res.locals.company = process.env.COMPANY_NAME || 'Planta de Envases Plásticos';
    next();
  });

  const flash = (req, type, msg) => { req.session.flash = { type, msg }; };
  // Quien entra con una contraseña inicial o reiniciada debe cambiarla antes de usar la app.
  app.use((req, res, next) => {
    const u = req.session.user;
    if (!u || !u.must_change || ['/cuenta', '/logout'].includes(req.path)) return next();
    if (req.method !== 'GET') return res.status(403).end();
    flash(req, 'error', 'Antes de seguir, cambia tu contraseña inicial por una personal.');
    res.redirect('/cuenta');
  });
  const auth = (req, res, next) => (req.session.user ? next() : res.redirect('/login'));
  const role = (...roles) => async (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).render('error', { title: 'Sin permiso', message: 'Tu perfil no tiene permiso para esta acción.' });
    }
    next();
  };
  // Administrador: el único que crea, modifica y elimina usuarios y elimina lotes (Luis Eduardo Gómez).
  // Se consulta en la base en cada petición para que un cambio aplique de inmediato.
  const admin = async (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    const u = await db.prepare('SELECT is_admin FROM users WHERE id = ? AND active = 1').get(req.session.user.id);
    if (!u || !u.is_admin) {
      return res.status(403).render('error', { title: 'Sin permiso', message: 'Solo el administrador (Luis Eduardo Gómez) puede hacer esto.' });
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
  app.post('/login', async (req, res) => {
    const u = await db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(req.body.username || '').trim().toLowerCase());
    if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) {
      return res.status(401).render('login', { title: 'Ingresar', error: 'Usuario o contraseña incorrectos' });
    }
    req.session.regenerate(() => {
      req.session.user = { id: u.id, username: u.username, full_name: u.full_name, role: u.role, must_change: !!u.must_change, admin: !!u.is_admin };
      res.redirect('/');
    });
  });
  app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

  app.get('/menu', auth, (req, res) => res.render('menu', { title: 'Menú', tab: 'menu' }));
  app.get('/cuenta', auth, (req, res) => res.render('account', { title: 'Mi cuenta' }));
  app.post('/cuenta', auth, async (req, res) => {
    const u = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
    const { current, password, confirm } = req.body;
    if (!bcrypt.compareSync(String(current || ''), u.password_hash)) flash(req, 'error', 'La contraseña actual no es correcta');
    else if (!password || password.length < 8) flash(req, 'error', 'La nueva contraseña debe tener al menos 8 caracteres');
    else if (password !== confirm) flash(req, 'error', 'Las contraseñas no coinciden');
    else if (password === current) flash(req, 'error', 'La nueva contraseña debe ser distinta de la actual');
    else {
      await db.prepare('UPDATE users SET password_hash = ?, must_change = 0 WHERE id = ?').run(bcrypt.hashSync(password, 10), u.id);
      const wasForced = req.session.user.must_change;
      req.session.user.must_change = false;
      flash(req, 'ok', 'Contraseña actualizada');
      if (wasForced) return res.redirect('/');
    }
    res.redirect('/cuenta');
  });

  // ---------- Tablero / lotes ----------
  app.get('/', auth, async (req, res) => {
    const status = STATUS_NAMES[req.query.estado] ? req.query.estado : null;
    const q = String(req.query.q || '').trim();
    let sql = `SELECT l.*, p.name AS product_name, p.molde, p.code AS product_code, c.number AS certificate_number
      FROM lots l JOIN products p ON p.id = l.product_id LEFT JOIN certificates c ON c.lot_id = l.id WHERE 1=1`;
    const args = [];
    if (status) { sql += ' AND l.status = ?'; args.push(status); }
    if (q) { sql += ' AND (l.lot_number LIKE ? OR p.name LIKE ? OR c.number LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    sql += ' ORDER BY l.id DESC LIMIT 200';
    const lots = await db.prepare(sql).all(...args);
    const counts = Object.fromEntries((await db.prepare('SELECT status, COUNT(*) AS n FROM lots GROUP BY status').all()).map((r) => [r.status, r.n]));
    const toReview = req.session.user.role === 'jefe'
      ? (await db.prepare('SELECT COUNT(*) AS n FROM certificates WHERE reviewed_by IS NULL').get()).n : 0;
    res.render('dashboard', { title: 'Lotes', lots, counts, status, q, tab: 'lotes', toReview });
  });

  // Listas desplegables del lote (color y material), editables en Productos.
  const parseList = (v) => [...new Set(String(v || '').split(/[,\n]/).map((x) => x.trim().replace(/\s+/g, ' ').slice(0, 40)).filter(Boolean))].slice(0, 30);
  const getList = async (key) => parseList((await db.prepare('SELECT value FROM meta WHERE key = ?').get(key) || {}).value);
  const lotLists = async () => ({ colors: await getList('colors'), materials: await getList('materials') });
  app.get('/lotes/nuevo', auth, async (req, res) => {
    const products = await db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY code').all();
    res.render('lot_new', { title: 'Nuevo lote', products, form: {}, error: null, ...(await lotLists()) });
  });
  app.post('/lotes', auth, async (req, res) => {
    const f = req.body;
    const products = await db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY code').all();
    const lotNumber = String(f.lot_number || '').trim().toUpperCase();
    let error = null;
    if (!lotNumber) error = 'El número de lote es obligatorio';
    else if (!products.some((p) => p.id === Number(f.product_id))) error = 'Selecciona un producto';
    else if (!f.production_date) error = 'La fecha de producción es obligatoria';
    else if (await db.prepare('SELECT 1 FROM lots WHERE lot_number = ?').get(lotNumber)) error = `El lote ${lotNumber} ya existe`;
    const lists = await lotLists();
    if (!error && !lists.colors.includes(f.color)) error = 'Selecciona el color del producto';
    if (!error && !lists.materials.includes(f.material)) error = 'Selecciona el material';
    if (error) return res.status(400).render('lot_new', { title: 'Nuevo lote', products, form: f, error, ...lists });
    const r = await db.prepare(`INSERT INTO lots (lot_number, product_id, production_date, shift, machine, quantity, notes, color, material, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(lotNumber, Number(f.product_id), f.production_date, f.shift || null, f.machine || null,
      f.quantity ? Number(f.quantity) : null, f.notes || null, f.color, f.material, req.session.user.id);
    await audit(req, 'crear_lote', lotNumber);
    flash(req, 'ok', `Lote ${lotNumber} creado. Registra las muestras y las pruebas.`);
    res.redirect(`/lotes/${r.lastInsertRowid}`);
  });

  const loadLot = async (req, res, next) => {
    const ev = await evaluateLot(db, Number(req.params.id));
    if (!ev) return res.status(404).render('error', { title: 'No encontrado', message: 'El lote no existe.' });
    req.ev = ev;
    next();
  };
  const editable = async (req, res, next) => {
    if (req.ev.lot.status !== 'en_proceso') {
      flash(req, 'error', 'El lote ya no está en proceso; no se puede modificar.');
      return res.redirect(`/lotes/${req.ev.lot.id}`);
    }
    next();
  };

  app.get('/lotes/:id', auth, loadLot, async (req, res) => {
    res.render('lot', { title: `Lote ${req.ev.lot.lot_number}`, ev: req.ev, specPoints, photos: await loadPhotos(req.ev.lot.id), ...(await lotLists()) });
  });
  // Corregir color y material mientras el lote no tenga decisión.
  app.post('/lotes/:id/datos', auth, loadLot, async (req, res) => {
    const lot = req.ev.lot;
    const lists = await lotLists();
    if (!['en_proceso', 'en_revision'].includes(lot.status)) flash(req, 'error', 'El lote ya tiene decisión; no se puede modificar.');
    else if (!lists.colors.includes(req.body.color) || !lists.materials.includes(req.body.material)) flash(req, 'error', 'Selecciona color y material');
    else {
      await db.prepare('UPDATE lots SET color = ?, material = ? WHERE id = ?').run(req.body.color, req.body.material, lot.id);
      await audit(req, 'cambiar_color_material', `${lot.lot_number}: ${req.body.color}, ${req.body.material}`);
      flash(req, 'ok', 'Color y material guardados');
    }
    res.redirect(`/lotes/${lot.id}`);
  });

  // Muestras
  app.get('/lotes/:id/muestras/nueva', auth, loadLot, editable, async (req, res) => {
    const next = (await db.prepare('SELECT COALESCE(MAX(sample_no),0)+1 AS n FROM samples WHERE lot_id = ?').get(req.ev.lot.id)).n;
    res.render('sample_form', { title: 'Registrar muestra', ev: req.ev, sample: null, sampleNo: next, specPoints, values: {}, error: null });
  });
  app.get('/lotes/:id/muestras/:sid/editar', auth, loadLot, editable, async (req, res) => {
    const sample = req.ev.samples.find((s) => s.id === Number(req.params.sid));
    if (!sample) return res.redirect(`/lotes/${req.ev.lot.id}`);
    const values = {};
    for (const [k, v] of Object.entries(sample.values)) values[k] = v ? v.value : '';
    res.render('sample_form', { title: `Editar muestra ${sample.sample_no}`, ev: req.ev, sample, sampleNo: sample.sample_no, specPoints, values, error: null });
  });
  const saveSample = async (req, res) => {
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
    await tx(db, async (db) => {
      let sampleId;
      if (existing) {
        sampleId = existing.id;
        await db.prepare('DELETE FROM measurements WHERE sample_id = ?').run(sampleId);
      } else {
        const n = (await db.prepare('SELECT COALESCE(MAX(sample_no),0)+1 AS n FROM samples WHERE lot_id = ?').get(ev.lot.id)).n;
        sampleId = (await db.prepare('INSERT INTO samples (lot_id, sample_no, taken_by) VALUES (?,?,?)').run(ev.lot.id, n, req.session.user.id)).lastInsertRowid;
      }
      const ins = db.prepare('INSERT INTO measurements (sample_id, spec_id, point, value, lic, lsc) VALUES (?,?,?,?,?,?)');
      for (const [spec, pt, v] of readings) await ins.run(sampleId, spec.id, pt, v, spec.lic, spec.lsc);
    });
    await audit(req, existing ? 'editar_muestra' : 'registrar_muestra', ev.lot.lot_number);
    const after = await evaluateLot(db, ev.lot.id);
    const s = existing ? after.samples.find((x) => x.id === existing.id) : after.samples[after.samples.length - 1];
    flash(req, s.ok ? 'ok' : 'error', s.ok ? `Muestra ${s.sample_no} guardada: CONFORME` : `Muestra ${s.sample_no} guardada: tiene lecturas FUERA de especificación`);
    const draft = /^[0-9]+-(nueva|[0-9]+)$/.test(String(req.body.draft || '')) ? `?guardado=${req.body.draft}` : '';
    res.redirect(`/lotes/${ev.lot.id}${draft}`);
  };
  app.post('/lotes/:id/muestras', auth, loadLot, editable, saveSample);
  app.post('/lotes/:id/muestras/:sid', auth, loadLot, editable, saveSample);
  app.post('/lotes/:id/muestras/:sid/eliminar', role('analista', 'jefe'), loadLot, editable, async (req, res) => {
    await db.prepare('DELETE FROM samples WHERE id = ? AND lot_id = ?').run(Number(req.params.sid), req.ev.lot.id);
    await audit(req, 'eliminar_muestra', req.ev.lot.lot_number);
    flash(req, 'ok', 'Muestra eliminada');
    res.redirect(`/lotes/${req.ev.lot.id}`);
  });

  // Pruebas de liberación
  app.post('/lotes/:id/pruebas', auth, loadLot, editable, async (req, res) => {
    const typeId = Number(req.body.test_type_id);
    const type = await db.prepare('SELECT * FROM test_types WHERE id = ? AND active = 1').get(typeId);
    if (!type) {
      flash(req, 'error', 'Selecciona la prueba');
      return res.redirect(`/lotes/${req.ev.lot.id}`);
    }
    // Cada prueba se registra por envase (impacto y filtración: 5). En pruebas con casillas,
    // cada casilla dice si el envase resistió ese impacto (o si NO tiene ese defecto).
    const units = Math.max(type.units || 1, 1);
    const groups = [];
    let missing = false;
    for (let u = 1; u <= units; u++) {
      if (type.checks > 0) {
        const marks = [];
        for (let i = 1; i <= type.checks; i++) marks.push(req.body[`chk_${u}_${i}`]);
        if (marks.some((m) => !['si', 'no'].includes(m))) missing = true;
        groups.push(marks.map((m) => (m === 'si' ? '1' : '0')));
      } else {
        const r = req.body[`res_${u}`];
        if (!['pasa', 'no_pasa'].includes(r)) missing = true;
        groups.push([r === 'pasa' ? '1' : '0']);
      }
    }
    if (missing) {
      flash(req, 'error', `${type.name}: ${type.checks > 0 ? `marca las ${type.checks} casillas` : 'marca el resultado'}${units > 1 ? ` de los ${units} envases` : ''} antes de guardar`);
      return res.redirect(`/lotes/${req.ev.lot.id}`);
    }
    const minOk = type.min_ok || type.checks;
    // Impacto: después de la primera caída que falla, las siguientes quedan como falladas.
    if (type.checks > 0 && !type.items) {
      for (const g of groups) { const r = resisted(g); for (let i = r; i < g.length; i++) g[i] = '0'; }
    }
    const unitOk = (g) => (type.checks > 0 ? (type.items ? g.filter((v) => v === '1').length : resisted(g)) >= minOk : g[0] === '1');
    const okUnits = groups.filter(unitOk).length;
    const allowed = Math.min(type.max_fail || 0, units - 1);
    const result = okUnits >= units - allowed ? 'pasa' : 'no_pasa';
    const failedUnits = groups.map((g, i) => (unitOk(g) ? null : i + 1)).filter(Boolean);
    const detail = groups.map((g) => g.join(',')).join(';');
    const score = units > 1 ? okUnits : type.checks > 0 ? (type.items ? groups[0].filter((v) => v === '1').length : resisted(groups[0])) : null;
    let note = '';
    if (type.items) {
      const names = type.items.split(',');
      const found = [...new Set(groups.flatMap((g) => names.filter((_, i) => g[i] === '0')))];
      note = found.length ? ` (defectos: ${found.join(', ')})` : ' (sin defectos)';
    } else if (units > 1) {
      note = ` (${okUnits} de ${units} envases conformes${result === 'pasa' && failedUnits.length ? `; no cumplió el envase ${failedUnits.join(', ')}, queda anotado en el certificado` : ''})`;
    } else if (type.checks > 0) {
      note = ` (${score} de ${type.checks} caídas resistidas)`;
    }
    await db.prepare(`INSERT INTO test_results (lot_id, test_type_id, result, observations, performed_by, detail, score) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT (lot_id, test_type_id) DO UPDATE SET result = excluded.result, observations = excluded.observations,
      performed_by = excluded.performed_by, detail = excluded.detail, score = excluded.score, performed_at = NOW()`)
      .run(req.ev.lot.id, typeId, result, (req.body.observations || '').trim() || null, req.session.user.id, detail, score);
    const extra = note;
    await audit(req, 'registrar_prueba', `${req.ev.lot.lot_number} ${type.code}=${result}${extra}`);
    flash(req, result === 'pasa' ? 'ok' : 'error', `${type.name}: ${result === 'pasa' ? 'APROBADO' : 'NO APROBADO'}${extra}`);
    res.redirect(`/lotes/${req.ev.lot.id}`);
  });

  // Eliminar un lote (por ejemplo, uno de prueba). Solo el jefe y escribiendo el número de lote.
  app.post('/lotes/:id/eliminar', admin, loadLot, async (req, res) => {
    const lot = req.ev.lot;
    if (String(req.body.confirm || '').trim() !== lot.lot_number) {
      flash(req, 'error', `Para eliminar escribe exactamente el número de lote: ${lot.lot_number}`);
      return res.redirect(`/lotes/${lot.id}`);
    }
    await tx(db, async (db) => {
      await db.prepare('DELETE FROM certificates WHERE lot_id = ?').run(lot.id);
      await db.prepare('DELETE FROM lots WHERE id = ?').run(lot.id);
    });
    await audit(req, 'eliminar_lote', `${lot.lot_number}${lot.certificate_number ? ` (certificado ${lot.certificate_number})` : ''}`);
    flash(req, 'ok', `Lote ${lot.lot_number} eliminado`);
    res.redirect('/');
  });

  // Flujo de aprobación
  app.post('/lotes/:id/enviar', role('analista', 'jefe'), loadLot, editable, async (req, res) => {
    if (!req.ev.complete) {
      flash(req, 'error', 'Faltan mediciones o pruebas para enviar el lote a aprobación.');
      return res.redirect(`/lotes/${req.ev.lot.id}`);
    }
    await db.prepare(`UPDATE lots SET status = 'en_revision', submitted_by = ?, submitted_at = NOW() WHERE id = ?`)
      .run(req.session.user.id, req.ev.lot.id);
    await audit(req, 'enviar_aprobacion', req.ev.lot.lot_number);
    flash(req, 'ok', 'Lote enviado al jefe de calidad para aprobación');
    res.redirect(`/lotes/${req.ev.lot.id}`);
  });
  app.post('/lotes/:id/devolver', role('analista', 'jefe'), loadLot, async (req, res) => {
    if (req.ev.lot.status !== 'en_revision') return res.redirect(`/lotes/${req.ev.lot.id}`);
    await db.prepare(`UPDATE lots SET status = 'en_proceso', submitted_by = NULL, submitted_at = NULL WHERE id = ?`).run(req.ev.lot.id);
    await audit(req, 'devolver_lote', req.ev.lot.lot_number);
    flash(req, 'ok', 'Lote devuelto a proceso para corrección');
    res.redirect(`/lotes/${req.ev.lot.id}`);
  });
  // Cualquier perfil emite el certificado cuando el lote cumple todo. Queda listo para imprimir
  // y le llega al jefe de calidad en Certificados para su visto bueno.
  app.post('/lotes/:id/liberar', auth, loadLot, async (req, res) => {
    try {
      const number = await releaseLot(db, req.ev.lot.id, req.session.user, (req.body.decision_notes || '').trim());
      flash(req, 'ok', `Certificado ${number} emitido. Imprímelo y entrégalo; el jefe de calidad lo verá para su visto bueno.`);
    } catch (e) {
      flash(req, 'error', e.message);
    }
    res.redirect(`/lotes/${req.ev.lot.id}`);
  });
  app.post('/lotes/:id/rechazar', role('jefe'), loadLot, async (req, res) => {
    if (!['en_revision', 'en_proceso'].includes(req.ev.lot.status)) return res.redirect(`/lotes/${req.ev.lot.id}`);
    const notes = (req.body.decision_notes || '').trim();
    if (!notes) {
      flash(req, 'error', 'Escribe el motivo del rechazo');
      return res.redirect(`/lotes/${req.ev.lot.id}`);
    }
    await db.prepare(`UPDATE lots SET status = 'rechazado', decided_by = ?, decided_at = NOW(), decision_notes = ? WHERE id = ?`)
      .run(req.session.user.id, notes, req.ev.lot.id);
    await audit(req, 'rechazar_lote', `${req.ev.lot.lot_number}: ${notes}`);
    flash(req, 'ok', 'Lote rechazado');
    res.redirect(`/lotes/${req.ev.lot.id}`);
  });

  // ---------- Evidencia fotográfica ----------
  // Las fotos se guardan en la base central (Neon), no en el disco de Render.
  const loadPhotos = (lotId) => db.prepare(`SELECT ph.id, ph.caption, ph.created_at, u.full_name AS taken_by_name
    FROM lot_photos ph LEFT JOIN users u ON u.id = ph.taken_by WHERE ph.lot_id = ? ORDER BY ph.id`).all(lotId);
  app.post('/lotes/:id/fotos', auth, loadLot, async (req, res) => {
    const lot = req.ev.lot;
    const back = `/lotes/${lot.id}#evidencia`;
    if (lot.status === 'liberado') { flash(req, 'error', 'El lote ya está liberado'); return res.redirect(back); }
    const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.photo || ''));
    if (!m) { flash(req, 'error', 'Toma o elige una foto antes de guardar'); return res.redirect(back); }
    if (m[2].length > 6 * 1024 * 1024) { flash(req, 'error', 'La foto es muy pesada'); return res.redirect(back); }
    await db.prepare('INSERT INTO lot_photos (lot_id, mime, data, caption, taken_by) VALUES (?,?,?,?,?)')
      .run(lot.id, m[1], m[2], String(req.body.caption || '').trim().slice(0, 200) || null, req.session.user.id);
    await audit(req, 'agregar_foto', lot.lot_number);
    flash(req, 'ok', 'Foto de evidencia guardada');
    res.redirect(back);
  });
  app.get('/fotos/:id', auth, async (req, res) => {
    const ph = await db.prepare('SELECT mime, data FROM lot_photos WHERE id = ?').get(Number(req.params.id));
    if (!ph) return res.status(404).end();
    res.setHeader('Content-Type', ph.mime);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.end(Buffer.from(ph.data, 'base64'));
  });
  app.post('/fotos/:id/eliminar', role('analista', 'jefe'), async (req, res) => {
    const ph = await db.prepare('SELECT ph.id, ph.lot_id, l.status, l.lot_number FROM lot_photos ph JOIN lots l ON l.id = ph.lot_id WHERE ph.id = ?').get(Number(req.params.id));
    if (!ph) return res.redirect('/');
    if (ph.status !== 'liberado') {
      await db.prepare('DELETE FROM lot_photos WHERE id = ?').run(ph.id);
      await audit(req, 'eliminar_foto', ph.lot_number);
      flash(req, 'ok', 'Foto eliminada');
    }
    res.redirect(`/lotes/${ph.lot_id}#evidencia`);
  });
  const photosWithData = (lotId) => db.prepare(`SELECT ph.mime, ph.data, ph.caption, ph.created_at, u.full_name AS taken_by_name
      FROM lot_photos ph LEFT JOIN users u ON u.id = ph.taken_by WHERE ph.lot_id = ? ORDER BY ph.id`).all(lotId);
  // Informe del lote en cualquier estado: hallazgos, mediciones, pruebas y fotos (si se rechazó, también el motivo).
  app.get('/lotes/:id/informe.pdf', auth, loadLot, async (req, res) => {
    const photos = await photosWithData(req.ev.lot.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Content-Disposition', `inline; filename="Informe-${req.ev.lot.lot_number}.pdf"`);
    lotReportPdf(req.ev, photos, res);
  });

  // ---------- Certificados ----------
  app.get('/certificados', auth, async (req, res) => {
    const pending = req.query.pendientes === '1';
    const certs = await db.prepare(`SELECT c.number, c.issued_at, c.reviewed_at, l.id AS lot_id, l.lot_number, p.name AS product_name, p.molde,
        u.full_name AS issued_by_name, r.full_name AS reviewed_by_name
      FROM certificates c JOIN lots l ON l.id = c.lot_id JOIN products p ON p.id = l.product_id
      LEFT JOIN users u ON u.id = c.issued_by LEFT JOIN users r ON r.id = c.reviewed_by
      ${pending ? 'WHERE c.reviewed_by IS NULL' : ''}
      ORDER BY c.year DESC, c.seq DESC`).all();
    res.render('certificates', { title: 'Certificados', certs, pending });
  });
  app.post('/certificados/:number/visto-bueno', role('jefe'), async (req, res) => {
    const r = await db.prepare('UPDATE certificates SET reviewed_by = ?, reviewed_at = NOW() WHERE number = ? AND reviewed_by IS NULL')
      .run(req.session.user.id, req.params.number);
    if (r.changes) {
      await audit(req, 'visto_bueno_certificado', req.params.number);
      flash(req, 'ok', `Visto bueno registrado en ${req.params.number}`);
    }
    res.redirect(req.body.back === 'pendientes' ? '/certificados?pendientes=1' : '/certificados');
  });
  app.get('/certificados/:number.pdf', auth, async (req, res) => {
    const c = await db.prepare('SELECT * FROM certificates WHERE number = ?').get(req.params.number);
    if (!c) return res.status(404).render('error', { title: 'No encontrado', message: 'Certificado no encontrado.' });
    res.setHeader('Content-Type', 'application/pdf');
    // El PDF se arma con el formato vigente cada vez: que el celular no muestre una copia vieja.
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Content-Disposition', `inline; filename="${c.number}.pdf"`);
    certificatePdf(JSON.parse(c.snapshot), res, await photosWithData(c.lot_id));
  });

  // ---------- Indicadores ----------
  app.get('/indicadores', auth, async (req, res) => {
    const ind = await indicadores.calcular(db, req.query);
    const products = await db.prepare('SELECT id, code, name, molde FROM products ORDER BY code').all();
    const qs = new URLSearchParams(Object.entries(ind.filtros).filter(([, v]) => v).map(([k, v]) => [k, String(v)])).toString();
    res.render('indicadores', { title: 'Indicadores', ind, products, qs, tab: 'indicadores' });
  });
  app.get('/indicadores/lotes.csv', auth, async (req, res) => {
    const ind = await indicadores.calcular(db, req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="lotes-indicadores.csv"');
    res.send(indicadores.csvLotes(ind.lotes));
  });

  // ---------- Catálogo de productos ----------
  app.get('/productos', auth, async (req, res) => {
    const products = await db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM specs s WHERE s.product_id = p.id) AS n_specs
      FROM products p ORDER BY p.active DESC, p.code`).all();
    res.render('products', { title: 'Productos y especificaciones', products, ...(await lotLists()) });
  });
  app.post('/listas', role('analista', 'jefe'), async (req, res) => {
    for (const key of ['colors', 'materials']) {
      const items = parseList(req.body[key]);
      if (!items.length) continue;
      await db.prepare('DELETE FROM meta WHERE key = ?').run(key);
      await db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(key, items.join(','));
    }
    await audit(req, 'cambiar_listas', `${req.body.colors || ''} | ${req.body.materials || ''}`);
    flash(req, 'ok', 'Listas de color y material guardadas');
    res.redirect('/productos#listas');
  });
  app.get('/productos/nuevo', role('analista', 'jefe'), (req, res) =>
    res.render('product_form', { title: 'Nuevo producto', product: {}, specs: [], error: null }));
  app.get('/productos/:id', auth, async (req, res) => {
    const product = await db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
    if (!product) return res.status(404).render('error', { title: 'No encontrado', message: 'Producto no encontrado.' });
    const specs = await db.prepare('SELECT * FROM specs WHERE product_id = ? ORDER BY sort, id').all(product.id);
    res.render('product_form', { title: product.name, product, specs, error: null });
  });
  const saveProduct = async (req, res) => {
    const id = req.params.id ? Number(req.params.id) : null;
    const b = req.body;
    const product = { id, code: String(b.code || '').trim().toUpperCase(), name: String(b.name || '').trim(), referencia: b.referencia,
      capacidad: b.capacidad, molde: b.molde, uso: b.uso, active: b.active ? 1 : 0,
      min_samples: Math.min(Math.max(Math.round(Number(b.min_samples)) || 5, 1), 50) };
    const arr = (x) => (Array.isArray(x) ? x : x === undefined ? [] : [x]);
    const rows = arr(b.s_characteristic).map((c, i) => ({
      id: Number(arr(b.s_id)[i]) || null, component: arr(b.s_component)[i], characteristic: String(c || '').trim(),
      unit: arr(b.s_unit)[i], points: arr(b.s_points)[i] === '4' ? 'A,B,C,D' : '',
      lic: num(arr(b.s_lic)[i]), lcc: num(arr(b.s_lcc)[i]), lsc: num(arr(b.s_lsc)[i]),
    })).filter((r) => r.characteristic);
    let error = null;
    if (!product.code || !product.name || !product.molde) error = 'Código, nombre y tipo de molde son obligatorios';
    for (const r of rows) {
      if (r.lic === null || r.lsc === null || Number.isNaN(r.lic) || Number.isNaN(r.lsc) || Number.isNaN(r.lcc)) error = error || `Límites inválidos en "${r.characteristic}"`;
      else if (r.lic > r.lsc) error = error || `En "${r.characteristic}" el LIC es mayor que el LSC`;
      else if (r.lcc !== null && (r.lcc < r.lic || r.lcc > r.lsc)) error = error || `En "${r.characteristic}" el LCC está fuera de LIC–LSC`;
    }
    const dup = await db.prepare('SELECT id FROM products WHERE code = ?').get(product.code);
    if (dup && dup.id !== id) error = error || `Ya existe un producto con código ${product.code}`;
    if (error) return res.status(400).render('product_form', { title: product.name || 'Producto', product, specs: rows, error });

    const savedId = await tx(db, async (db) => {
      let pid = id;
      if (pid) {
        await db.prepare('UPDATE products SET code=?, name=?, referencia=?, capacidad=?, molde=?, uso=?, active=?, min_samples=? WHERE id=?')
          .run(product.code, product.name, product.referencia || null, product.capacidad || null, product.molde, product.uso || null, product.active, product.min_samples, pid);
      } else {
        pid = (await db.prepare('INSERT INTO products (code, name, referencia, capacidad, molde, uso, active, min_samples) VALUES (?,?,?,?,?,?,1,?)')
          .run(product.code, product.name, product.referencia || null, product.capacidad || null, product.molde, product.uso || null, product.min_samples)).lastInsertRowid;
      }
      const keep = rows.filter((r) => r.id).map((r) => r.id);
      const current = (await db.prepare('SELECT id FROM specs WHERE product_id = ?').all(pid)).map((r) => r.id);
      for (const sid of current) {
        if (keep.includes(sid)) continue;
        const used = await db.prepare('SELECT 1 FROM measurements WHERE spec_id = ? LIMIT 1').get(sid);
        if (used) throw new Error('No se puede borrar una especificación que ya tiene mediciones registradas. Cambia sus límites en su lugar.');
        await db.prepare('DELETE FROM specs WHERE id = ?').run(sid);
      }
      for (const [i, r] of rows.entries()) {
        if (r.id && current.includes(r.id)) {
          await db.prepare('UPDATE specs SET component=?, characteristic=?, unit=?, points=?, lic=?, lcc=?, lsc=?, sort=? WHERE id=?')
            .run(r.component, r.characteristic, r.unit, r.points, r.lic, r.lcc, r.lsc, i, r.id);
        } else {
          await db.prepare('INSERT INTO specs (product_id, component, characteristic, unit, points, lic, lcc, lsc, sort) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(pid, r.component, r.characteristic, r.unit, r.points, r.lic, r.lcc, r.lsc, i);
        }
      }
      return pid;
    });
    await audit(req, id ? 'editar_producto' : 'crear_producto', product.code);
    flash(req, 'ok', 'Producto guardado');
    res.redirect(`/productos/${savedId}`);
  };
  const safe = (fn) => async (req, res, next) => {
    try { await fn(req, res, next); } catch (e) {
      flash(req, 'error', e.message);
      res.redirect(req.get('referer') || '/');
    }
  };
  app.post('/productos', role('analista', 'jefe'), safe(saveProduct));
  app.post('/productos/:id', role('analista', 'jefe'), safe(saveProduct));

  // ---------- Tipos de prueba ----------
  const clampUnits = (v) => Math.min(Math.max(Math.round(Number(v)) || 1, 1), 20);
  app.get('/pruebas', auth, async (req, res) => {
    res.render('tests', { title: 'Pruebas de liberación', types: await db.prepare('SELECT * FROM test_types ORDER BY active DESC, id').all() });
  });
  app.post('/pruebas', role('analista', 'jefe'), async (req, res) => {
    const name = String(req.body.name || '').trim();
    const code = String(req.body.code || name).trim().toUpperCase().normalize('NFD').replace(/[^A-Z0-9]/g, '_');
    const items = parseItems(req.body.items);
    const checks = items.length || Math.min(Math.max(Number(req.body.checks) || 0, 0), 10);
    const minOk = items.length ? items.length : checks ? Math.min(Math.max(Number(req.body.min_ok) || checks, 1), checks) : null;
    if (!name) flash(req, 'error', 'Escribe el nombre de la prueba');
    else if (await db.prepare('SELECT 1 FROM test_types WHERE code = ?').get(code)) flash(req, 'error', 'Ya existe una prueba con ese código');
    else {
      await db.prepare('INSERT INTO test_types (code, name, description, checks, min_ok, items, units) VALUES (?,?,?,?,?,?,?)').run(code, name, req.body.description || null, checks, minOk, items.join(',') || null, clampUnits(req.body.units));
      await audit(req, 'crear_prueba', code);
      flash(req, 'ok', `Prueba "${name}" agregada. Desde ahora es obligatoria para liberar lotes.`);
    }
    res.redirect('/pruebas');
  });
  app.post('/pruebas/:id/casillas', role('analista', 'jefe'), async (req, res) => {
    const checks = Math.min(Math.max(Number(req.body.checks) || 0, 0), 10);
    const minOk = checks ? Math.min(Math.max(Number(req.body.min_ok) || checks, 1), checks) : null;
    await db.prepare('UPDATE test_types SET checks = ?, min_ok = ? WHERE id = ? AND items IS NULL').run(checks, minOk, Number(req.params.id));
    await audit(req, 'cambiar_casillas_prueba', `${req.params.id}: ${checks} casillas, mínimo ${minOk ?? '-'}`);
    flash(req, 'ok', checks ? `Prueba con ${checks} casillas; se aprueba con ${minOk} o más` : 'Prueba de resultado simple (aprobado / no aprobado)');
    res.redirect('/pruebas');
  });
  app.post('/pruebas/:id/envases', role('analista', 'jefe'), async (req, res) => {
    const units = clampUnits(req.body.units);
    const maxFail = Math.min(Math.max(Math.round(Number(req.body.max_fail)) || 0, 0), units - 1);
    await db.prepare('UPDATE test_types SET units = ?, max_fail = ? WHERE id = ?').run(units, maxFail, Number(req.params.id));
    await audit(req, 'cambiar_envases_prueba', `${req.params.id}: ${units} envases`);
    flash(req, 'ok', `La prueba se hace ahora a ${units} envase(s) por lote`);
    res.redirect('/pruebas');
  });
  app.post('/pruebas/:id/defectos', role('analista', 'jefe'), async (req, res) => {
    const items = parseItems(req.body.items);
    if (!items.length) {
      flash(req, 'error', 'Escribe al menos un defecto a revisar');
      return res.redirect('/pruebas');
    }
    await db.prepare('UPDATE test_types SET items = ?, checks = ?, min_ok = ? WHERE id = ?').run(items.join(','), items.length, items.length, Number(req.params.id));
    await audit(req, 'cambiar_defectos_prueba', `${req.params.id}: ${items.join(', ')}`);
    flash(req, 'ok', `Defectos a revisar: ${items.join(', ')}`);
    res.redirect('/pruebas');
  });
  app.post('/pruebas/:id/estado', role('analista', 'jefe'), async (req, res) => {
    await db.prepare('UPDATE test_types SET active = 1 - active WHERE id = ?').run(Number(req.params.id));
    await audit(req, 'cambiar_estado_prueba', req.params.id);
    res.redirect('/pruebas');
  });

  // ---------- Usuarios (jefe de calidad) ----------
  app.get('/usuarios', admin, async (req, res) => {
    res.render('users', { title: 'Usuarios', users: await db.prepare('SELECT * FROM users ORDER BY active DESC, role, username').all() });
  });
  app.post('/usuarios', admin, async (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    const { full_name, role: r, password } = req.body;
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) flash(req, 'error', 'Usuario inválido (3–30 letras, números, punto o guion)');
    else if (!full_name || !ROLE_NAMES[r]) flash(req, 'error', 'Nombre y perfil son obligatorios');
    else if (!password || password.length < 8) flash(req, 'error', 'La contraseña debe tener al menos 8 caracteres');
    else if (await db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) flash(req, 'error', 'Ese usuario ya existe');
    else {
      await db.prepare('INSERT INTO users (username, full_name, role, password_hash, must_change) VALUES (?,?,?,?,1)').run(username, full_name.trim(), r, bcrypt.hashSync(password, 10));
      await audit(req, 'crear_usuario', username);
      flash(req, 'ok', `Usuario ${username} creado`);
    }
    res.redirect('/usuarios');
  });
  // Eliminar usuario: solo si no tiene lotes, muestras, pruebas ni certificados a su nombre.
  // Si los tiene, se desactiva para no perder quién hizo cada registro.
  app.post('/usuarios/:id/eliminar', admin, async (req, res) => {
    const id = Number(req.params.id);
    const u = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) return res.redirect('/usuarios');
    if (id === req.session.user.id) {
      flash(req, 'error', 'No puedes eliminar tu propio usuario');
      return res.redirect('/usuarios');
    }
    const { n } = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM lots WHERE created_by = ? OR submitted_by = ? OR decided_by = ?) +
      (SELECT COUNT(*) FROM samples WHERE taken_by = ?) +
      (SELECT COUNT(*) FROM test_results WHERE performed_by = ?) +
      (SELECT COUNT(*) FROM certificates WHERE issued_by = ?) +
      (SELECT COUNT(*) FROM lot_photos WHERE taken_by = ?) AS n`).get(id, id, id, id, id, id, id);
    if (n > 0) {
      await db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(id);
      await audit(req, 'desactivar_usuario', u.username);
      flash(req, 'error', `${u.full_name} tiene ${n} registro(s) de calidad a su nombre. Se desactivó (ya no puede entrar) en vez de eliminarse. Si eran lotes de prueba, elimina esos lotes y vuelve a intentarlo.`);
      return res.redirect('/usuarios');
    }
    await tx(db, async (db) => {
      await db.prepare("UPDATE audit_log SET user_id = NULL, detail = '[' || CAST(? AS TEXT) || '] ' || COALESCE(detail, '') WHERE user_id = ?").run(u.username, id);
      await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    });
    await audit(req, 'eliminar_usuario', `${u.username} (${u.full_name})`);
    flash(req, 'ok', `Usuario ${u.username} eliminado`);
    res.redirect('/usuarios');
  });
  app.post('/usuarios/:id', admin, async (req, res) => {
    const id = Number(req.params.id);
    const u = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) return res.redirect('/usuarios');
    const { full_name, role: r, password } = req.body;
    const active = req.body.active ? 1 : 0;
    if (id === req.session.user.id && (r !== 'jefe' || !active)) {
      flash(req, 'error', 'No puedes quitarte el perfil de jefe ni desactivar tu propio usuario');
      return res.redirect('/usuarios');
    }
    if (!ROLE_NAMES[r] || !full_name) { flash(req, 'error', 'Datos inválidos'); return res.redirect('/usuarios'); }
    await db.prepare('UPDATE users SET full_name = ?, role = ?, active = ? WHERE id = ?').run(full_name.trim(), r, active, id);
    if (password) {
      if (password.length < 8) { flash(req, 'error', 'La contraseña debe tener al menos 8 caracteres'); return res.redirect('/usuarios'); }
      await db.prepare('UPDATE users SET password_hash = ?, must_change = 1 WHERE id = ?').run(bcrypt.hashSync(password, 10), id);
    }
    await audit(req, 'editar_usuario', u.username);
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
  open().then((db) => {
    const port = Number(process.env.PORT) || 3000;
    createApp(db).listen(port, () => console.log(`App de calidad lista en el puerto ${port} (base de datos: ${db.kind === 'pg' ? 'PostgreSQL' : 'SQLite'})`));
  }).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { createApp };
