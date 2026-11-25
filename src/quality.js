'use strict';
// Reglas de conformidad del lote y emisión del certificado con consecutivo.
const { tx, yearNow } = require('./db');

function specPoints(spec) {
  return spec.points ? spec.points.split(',').map((p) => p.trim()).filter(Boolean) : [''];
}

function inLimits(value, lic, lsc) {
  return value >= lic && value <= lsc;
}

async function getLot(db, lotId) {
  return db.prepare(`
    SELECT l.*, p.code AS product_code, p.name AS product_name, p.molde, p.referencia, p.capacidad, p.min_samples,
      uc.full_name AS created_by_name, us.full_name AS submitted_by_name, ud.full_name AS decided_by_name,
      c.number AS certificate_number
    FROM lots l
    JOIN products p ON p.id = l.product_id
    LEFT JOIN users uc ON uc.id = l.created_by
    LEFT JOIN users us ON us.id = l.submitted_by
    LEFT JOIN users ud ON ud.id = l.decided_by
    LEFT JOIN certificates c ON c.lot_id = l.id
    WHERE l.id = ?`).get(lotId);
}

// Una prueba se registra por envase. detail guarda un grupo por envase separado por ';'
// (casillas '1,0,1,0' o resultado '1'/'0'). Resultados antiguos sin detalle cuentan como 1 envase.
function unitsDone(r) {
  return r && r.detail ? r.detail.split(';').length : r ? 1 : 0;
}

// Evalúa el lote completo: mediciones de todas las muestras + pruebas de liberación.
async function evaluateLot(db, lotId) {
  const lot = await getLot(db, lotId);
  if (!lot) return null;
  const specs = await db.prepare('SELECT * FROM specs WHERE product_id = ? ORDER BY sort, id').all(lot.product_id);
  const samples = await db.prepare(`
    SELECT s.*, u.full_name AS taken_by_name FROM samples s LEFT JOIN users u ON u.id = s.taken_by
    WHERE s.lot_id = ? ORDER BY s.sample_no`).all(lotId);

  const problems = [];
  const specSummary = specs.map((s) => ({ spec: s, values: [], out: 0 }));
  const bySpecId = new Map(specSummary.map((x) => [x.spec.id, x]));

  for (const sample of samples) {
    const rows = await db.prepare('SELECT * FROM measurements WHERE sample_id = ?').all(sample.id);
    const map = new Map(rows.map((m) => [`${m.spec_id}|${m.point}`, m]));
    sample.values = {};
    sample.ok = true;
    sample.complete = true;
    for (const spec of specs) {
      for (const pt of specPoints(spec)) {
        const m = map.get(`${spec.id}|${pt}`);
        const key = `${spec.id}|${pt}`;
        if (!m) {
          sample.complete = false;
          sample.values[key] = null;
          continue;
        }
        const ok = inLimits(m.value, m.lic, m.lsc);
        sample.values[key] = { value: m.value, ok };
        bySpecId.get(spec.id).values.push(m.value);
        if (!ok) {
          sample.ok = false;
          bySpecId.get(spec.id).out++;
          problems.push(`Muestra ${sample.sample_no}: ${spec.characteristic}${pt ? ' punto ' + pt : ''} = ${m.value} ${spec.unit} (límites ${m.lic}–${m.lsc})`);
        }
      }
    }
    if (!sample.complete) problems.push(`Muestra ${sample.sample_no}: faltan mediciones`);
  }

  for (const x of specSummary) {
    const v = x.values;
    x.n = v.length;
    x.min = v.length ? Math.min(...v) : null;
    x.max = v.length ? Math.max(...v) : null;
    x.avg = v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    x.ok = v.length > 0 && x.out === 0;
  }

  const testTypes = await db.prepare('SELECT * FROM test_types WHERE active = 1 ORDER BY id').all();
  const results = await db.prepare(`
    SELECT r.*, t.name AS test_name, t.code AS test_code, t.checks AS test_checks, t.min_ok AS test_min_ok, t.items AS test_items, u.full_name AS performed_by_name
    FROM test_results r JOIN test_types t ON t.id = r.test_type_id
    LEFT JOIN users u ON u.id = r.performed_by WHERE r.lot_id = ?`).all(lotId);
  const resultByType = new Map(results.map((r) => [r.test_type_id, r]));
  const tests = testTypes.map((t) => ({ type: t, result: resultByType.get(t.id) || null }));
  // Resultados de pruebas que luego se desactivaron siguen apareciendo en el lote.
  for (const r of results) {
    if (!testTypes.some((t) => t.id === r.test_type_id)) {
      tests.push({ type: { id: r.test_type_id, name: r.test_name, code: r.test_code, active: 0 }, result: r });
    }
  }

  const minSamples = lot.min_samples || 1;
  if (samples.length === 0) problems.push(`No hay muestras registradas (mínimo ${minSamples} por lote)`);
  else if (samples.length < minSamples) problems.push(`Faltan ${minSamples - samples.length} muestra(s): el mínimo es ${minSamples} por lote`);
  if (specs.length === 0) problems.push('El producto no tiene especificaciones cargadas');
  for (const t of tests) {
    if (!t.type.active) continue;
    const units = t.type.units || 1;
    if (!t.result) problems.push(`Falta la ${t.type.name.toLowerCase()}${units > 1 ? ` (${units} envases)` : ''}`);
    else if (unitsDone(t.result) < units) problems.push(`${t.type.name}: faltan ${units - unitsDone(t.result)} envase(s) de ${units}`);
    else if (t.result.result !== 'pasa') problems.push(`${t.type.name}: NO APROBADO`);
  }

  const measurementsComplete = samples.length >= minSamples && samples.every((s) => s.complete) && specs.length > 0;
  const measurementsOk = measurementsComplete && samples.every((s) => s.ok);
  const testsComplete = tests.filter((t) => t.type.active).every((t) => t.result && unitsDone(t.result) >= (t.type.units || 1));
  const testsOk = testsComplete && tests.filter((t) => t.type.active).every((t) => t.result.result === 'pasa');

  return {
    lot, specs, samples, specSummary, tests, problems,
    measurementsComplete, measurementsOk, testsComplete, testsOk,
    complete: measurementsComplete && testsComplete,
    conforme: measurementsOk && testsOk,
  };
}

async function nextCertificateNumber(db, year) {
  const row = await db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM certificates WHERE year = ?').get(year);
  return { seq: row.seq, number: `CL-${year}-${String(row.seq).padStart(4, '0')}` };
}

// Libera el lote y emite el certificado en una sola transacción.
function releaseLot(db, lotId, user, notes) {
  return tx(db, async (db) => {
    const ev = await evaluateLot(db, lotId);
    if (!ev) throw new Error('Lote no encontrado');
    if (!['en_proceso', 'en_revision'].includes(ev.lot.status)) throw new Error('El lote ya fue liberado o rechazado');
    if (!ev.conforme) throw new Error('El lote no cumple todas las especificaciones y pruebas');

    const year = yearNow();
    // Evita que dos liberaciones simultáneas tomen el mismo consecutivo.
    if (db.kind === 'pg') await db.exec('LOCK TABLE certificates IN SHARE ROW EXCLUSIVE MODE');
    const { seq, number } = await nextCertificateNumber(db, year);
    await db.prepare(`UPDATE lots SET status = 'liberado', decided_by = ?, decided_at = NOW(),
      decision_notes = ? WHERE id = ?`).run(user.id, notes || null, lotId);

    const lot = await getLot(db, lotId);
    const snapshot = {
      number,
      issued_at: new Date().toISOString(),
      issued_by: user.full_name,
      lot,
      specSummary: ev.specSummary.map((x) => ({
        component: x.spec.component, characteristic: x.spec.characteristic, unit: x.spec.unit,
        points: x.spec.points, lic: x.spec.lic, lcc: x.spec.lcc, lsc: x.spec.lsc,
        n: x.n, min: x.min, max: x.max, avg: x.avg, ok: x.ok,
      })),
      samples: ev.samples.map((s) => ({ sample_no: s.sample_no, taken_by: s.taken_by_name, taken_at: s.taken_at, values: s.values })),
      specs: ev.specs.map((s) => ({ id: s.id, characteristic: s.characteristic, unit: s.unit, points: s.points })),
      tests: ev.tests.filter((t) => t.result).map((t) => ({
        name: t.type.name, result: t.result.result, observations: t.result.observations,
        checks: t.result.test_checks || 0, min_ok: t.result.test_min_ok || null, units: unitsDone(t.result), score: t.result.score, detail: t.result.detail, items: t.result.test_items || null,
        performed_by: t.result.performed_by_name, performed_at: t.result.performed_at,
      })),
    };
    await db.prepare('INSERT INTO certificates (number, year, seq, lot_id, issued_by, snapshot) VALUES (?,?,?,?,?,?)')
      .run(number, year, seq, lotId, user.id, JSON.stringify(snapshot));
    await db.prepare('INSERT INTO audit_log (user_id, action, detail) VALUES (?,?,?)')
      .run(user.id, 'liberar_lote', `${lot.lot_number} → ${number}`);
    return number;
  });
}

module.exports = { unitsDone, evaluateLot, releaseLot, specPoints, inLimits, getLot, nextCertificateNumber };
