'use strict';
// Indicadores de calidad calculados con los lotes reales de la base de datos.

const ESTADOS = ['liberado', 'rechazado', 'en_revision', 'en_proceso'];

// Lunes de la semana de una fecha AAAA-MM-DD.
function semanaDe(fecha) {
  const d = new Date(`${fecha}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

function normalizaFiltros(q = {}) {
  const fecha = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
  return {
    producto: /^\d+$/.test(String(q.producto || '')) ? Number(q.producto) : null,
    molde: ['Colada fría', 'Colada caliente'].includes(q.molde) ? q.molde : '',
    desde: fecha(q.desde),
    hasta: fecha(q.hasta),
  };
}

function where(f) {
  const cond = ['1=1'];
  const args = [];
  if (f.producto) { cond.push('l.product_id = ?'); args.push(f.producto); }
  if (f.molde) { cond.push('p.molde = ?'); args.push(f.molde); }
  if (f.desde) { cond.push('l.production_date >= ?'); args.push(f.desde); }
  if (f.hasta) { cond.push('l.production_date <= ?'); args.push(f.hasta); }
  return { sql: cond.join(' AND '), args };
}

async function lotesFiltrados(db, f) {
  const w = where(f);
  return db.prepare(`
    SELECT l.id, l.lot_number, l.production_date, l.status, p.id AS product_id, p.code AS product_code,
      p.name AS product_name, p.molde, c.number AS certificate_number,
      (SELECT COUNT(*) FROM measurements m JOIN samples s ON s.id = m.sample_id WHERE s.lot_id = l.id) AS lecturas,
      (SELECT COUNT(*) FROM measurements m JOIN samples s ON s.id = m.sample_id
        WHERE s.lot_id = l.id AND (m.value < m.lic OR m.value > m.lsc)) AS lecturas_fuera
    FROM lots l JOIN products p ON p.id = l.product_id LEFT JOIN certificates c ON c.lot_id = l.id
    WHERE ${w.sql}
    ORDER BY l.production_date DESC, l.id DESC`).all(...w.args);
}

async function calcular(db, filtros) {
  const f = normalizaFiltros(filtros);
  const lotes = await lotesFiltrados(db, f);
  const w = where(f);

  const cuenta = (e) => lotes.filter((l) => l.status === e).length;
  const liberados = cuenta('liberado');
  const rechazados = cuenta('rechazado');
  const resumen = {
    lotes: lotes.length,
    liberados,
    rechazados,
    en_revision: cuenta('en_revision'),
    en_proceso: cuenta('en_proceso'),
    cumplimiento: pct(liberados, liberados + rechazados),
    lecturas: lotes.reduce((a, l) => a + l.lecturas, 0),
    lecturas_fuera: lotes.reduce((a, l) => a + l.lecturas_fuera, 0),
  };

  // Lotes por semana de producción y estado.
  const semanas = new Map();
  for (const l of lotes) {
    const s = semanaDe(l.production_date);
    if (!s) continue;
    if (!semanas.has(s)) semanas.set(s, Object.fromEntries(ESTADOS.map((e) => [e, 0])));
    semanas.get(s)[l.status]++;
  }
  const porSemana = [...semanas.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).slice(-16)
    .map(([semana, c]) => ({ semana, ...c, total: ESTADOS.reduce((a, e) => a + c[e], 0) }));

  // Cumplimiento por producto.
  const prods = new Map();
  for (const l of lotes) {
    if (!prods.has(l.product_id)) prods.set(l.product_id, { codigo: l.product_code, nombre: l.product_name, molde: l.molde, lotes: 0, liberados: 0, rechazados: 0 });
    const p = prods.get(l.product_id);
    p.lotes++;
    if (l.status === 'liberado') p.liberados++;
    if (l.status === 'rechazado') p.rechazados++;
  }
  const porProducto = [...prods.values()]
    .map((p) => ({ ...p, decididos: p.liberados + p.rechazados, cumplimiento: pct(p.liberados, p.liberados + p.rechazados) }))
    .sort((a, b) => (a.codigo < b.codigo ? -1 : 1));

  // Lecturas fuera de LIC–LSC.
  const fuera = (await db.prepare(`
    SELECT l.id AS lot_id, l.lot_number, l.production_date, p.code AS product_code, sp.characteristic, sp.unit,
      m.point, s.sample_no, m.value, m.lic, m.lsc
    FROM measurements m
    JOIN samples s ON s.id = m.sample_id
    JOIN lots l ON l.id = s.lot_id
    JOIN products p ON p.id = l.product_id
    JOIN specs sp ON sp.id = m.spec_id
    WHERE ${w.sql} AND (m.value < m.lic OR m.value > m.lsc)
    ORDER BY l.production_date DESC, l.id DESC, s.sample_no, sp.sort, m.point`).all(...w.args))
    .map((r) => ({ ...r, desviacion: Math.round((r.value > r.lsc ? r.value - r.lsc : r.value - r.lic) * 100) / 100 }));

  const porPunto = 'ABCD'.split('').map((punto) => ({ punto, fuera: fuera.filter((r) => r.point === punto).length }));
  const caracs = new Map();
  for (const r of fuera) caracs.set(r.characteristic, (caracs.get(r.characteristic) || 0) + 1);
  const porCaracteristica = [...caracs.entries()].map(([caracteristica, n]) => ({ caracteristica, fuera: n }))
    .sort((a, b) => b.fuera - a.fuera);

  // Pruebas de liberación.
  const pruebas = (await db.prepare(`
    SELECT t.name AS prueba, t.active,
      SUM(CASE WHEN r.result = 'pasa' THEN 1 ELSE 0 END) AS pasa,
      SUM(CASE WHEN r.result = 'no_pasa' THEN 1 ELSE 0 END) AS no_pasa
    FROM test_results r
    JOIN test_types t ON t.id = r.test_type_id
    JOIN lots l ON l.id = r.lot_id
    JOIN products p ON p.id = l.product_id
    WHERE ${w.sql}
    GROUP BY t.id, t.name, t.active ORDER BY t.id`).all(...w.args))
    .map((t) => ({ ...t, aprobacion: pct(t.pasa, t.pasa + t.no_pasa) }));

  return { filtros: f, resumen, porSemana, porProducto, porPunto, porCaracteristica, pruebas, fuera, lotes };
}

function csvLotes(lotes) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['lote', 'fecha_produccion', 'producto', 'nombre', 'molde', 'lecturas', 'lecturas_fuera', 'estado', 'certificado'];
  const rows = lotes.map((l) => [l.lot_number, l.production_date, l.product_code, l.product_name, l.molde, l.lecturas, l.lecturas_fuera, l.status, l.certificate_number]);
  // BOM para que Excel abra bien las tildes; separador ; por configuración regional de Colombia.
  return '﻿' + [head, ...rows].map((r) => r.map(esc).join(';')).join('\r\n') + '\r\n';
}

module.exports = { calcular, csvLotes, semanaDe, normalizaFiltros };
