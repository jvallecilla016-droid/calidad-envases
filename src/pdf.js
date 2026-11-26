'use strict';
const { resisted } = require('./quality');
const PDFDocument = require('pdfkit');

const COMPANY = () => process.env.COMPANY_NAME || 'Planta de Envases Plásticos';
const fmt = (v, d = 1) => (v === null || v === undefined ? '—' : Number(v).toFixed(d).replace(/\.0+$/, ''));

// Genera el certificado de liberación a partir de la foto (snapshot) guardada al liberar.
function certificatePdf(snap, stream) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 40, bufferPages: true, info: { Title: `Certificado ${snap.number}` } });
  doc.pipe(stream);
  const L = 40;
  const W = doc.page.width - 80;
  const lot = snap.lot;

  // Encabezado
  doc.rect(L, 40, W, 60).stroke('#1f3b57');
  doc.fillColor('#1f3b57').font('Helvetica-Bold').fontSize(13).text(COMPANY(), L + 10, 50, { width: W - 180 });
  doc.font('Helvetica-Bold').fontSize(11).text('CERTIFICADO DE LIBERACIÓN DE LOTE', L + 10, 72, { width: W - 180 });
  doc.fontSize(9).font('Helvetica').fillColor('#333').text('Control de calidad de producto terminado', L + 10, 86);
  doc.rect(L + W - 160, 40, 160, 60).fill('#1f3b57');
  doc.fillColor('#fff').fontSize(9).text('CONSECUTIVO', L + W - 160, 52, { width: 160, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(16).text(snap.number, L + W - 160, 66, { width: 160, align: 'center' });
  doc.fillColor('#000');

  // Datos del lote
  let y = 115;
  const info = [
    ['Lote de producción', lot.lot_number],
    ['Producto', `${lot.product_name} (${lot.product_code})`],
    ['Tipo de molde', lot.molde],
    ['Fecha de producción', lot.production_date],
    ['Turno / Máquina', [lot.shift, lot.machine].filter(Boolean).join(' / ') || '—'],
    ['Cantidad del lote', lot.quantity ? `${lot.quantity} unidades` : '—'],
    ['Muestras evaluadas', String(snap.samples.length)],
    ['Fecha de liberación', lot.decided_at],
  ];
  const colW = W / 2;
  info.forEach(([k, v], i) => {
    const x = L + (i % 2) * colW;
    const yy = y + Math.floor(i / 2) * 18;
    doc.font('Helvetica-Bold').fontSize(8.5).text(k + ':', x, yy, { width: 105 });
    doc.font('Helvetica').text(v || '—', x + 105, yy, { width: colW - 110 });
  });
  y += Math.ceil(info.length / 2) * 18 + 10;

  // Especificaciones
  y = sectionTitle(doc, '1. Cumplimiento de especificaciones (peso y dimensiones)', L, y, W);
  const cols = [
    ['Característica', 150, 'left'], ['Unid.', 32], ['Puntos', 40], ['LIC', 40], ['LCC', 40], ['LSC', 40],
    ['Mín', 40], ['Máx', 40], ['Prom.', 40], ['Resultado', W - 462],
  ];
  y = tableHeader(doc, cols, L, y);
  for (const s of snap.specSummary) {
    const pts = s.points ? s.points.split(',').length : 1;
    const row = [s.characteristic, s.unit, String(pts), fmt(s.lic), fmt(s.lcc), fmt(s.lsc), fmt(s.min, 2), fmt(s.max, 2), fmt(s.avg, 2), s.ok ? 'CONFORME' : 'NO CONFORME'];
    y = tableRow(doc, cols, row, L, y, { last: s.ok ? '#1d7a35' : '#b3261e' });
  }
  y += 6;
  doc.font('Helvetica-Oblique').fontSize(7.5).fillColor('#444')
    .text('Cada diámetro se midió en los puntos A–D de cada muestra. Todas las lecturas quedaron dentro de LIC–LSC.', L, y, { width: W });
  doc.fillColor('#000');
  y += 18;

  // Pruebas
  y = sectionTitle(doc, '2. Pruebas de liberación', L, y, W);
  const tcols = [['Prueba', 120, 'left'], ['Resultado', 60], ['Realizada por', 110, 'left'], ['Fecha', 85], ['Observaciones', W - 375, 'left']];
  y = tableHeader(doc, tcols, L, y);
  for (const t of snap.tests) {
    let obs = t.observations || '';
    const groups = t.detail ? t.detail.split(';') : [];
    let extra = '';
    if (groups.length > 1) extra = ` (${t.score}/${groups.length})`;
    else if (t.score != null && t.checks) extra = ` (${t.score}/${t.checks})`;
    if (t.items && t.detail) {
      const names = t.items.split(',');
      const found = [...new Set(groups.flatMap((g) => names.filter((_, i) => g.split(',')[i] === '0')))];
      extra = '';
      obs = (found.length ? `Defectos: ${found.join(', ')}` : 'Sin defectos') + (obs ? `. ${obs}` : '');
    } else if (groups.length > 1) {
      obs = `${groups.length} envases probados` + (obs ? `. ${obs}` : '');
    }
    y = tableRow(doc, tcols, [t.name, (t.result === 'pasa' ? 'APROBADO' : 'NO APROBADO') + extra, t.performed_by || '—', t.performed_at, obs], L, y,
      { color1: t.result === 'pasa' ? '#1d7a35' : '#b3261e' });
  }
  y += 14;

  // Dictamen
  doc.rect(L, y, W, 34).fill('#e8f3ea');
  doc.fillColor('#1d7a35').font('Helvetica-Bold').fontSize(12).text('DICTAMEN: LOTE LIBERADO', L + 10, y + 6);
  doc.font('Helvetica').fontSize(8.5).fillColor('#222')
    .text('El lote cumple con todas las especificaciones dimensionales, de peso y con las pruebas de liberación definidas.', L + 10, y + 21, { width: W - 20 });
  y += 44;
  if (lot.decision_notes) {
    doc.font('Helvetica-Bold').fontSize(8.5).text('Observaciones de liberación: ', L, y, { continued: true }).font('Helvetica').text(lot.decision_notes, { width: W });
    y = doc.y + 8;
  }

  // Firmas
  y += 30;
  if (y > doc.page.height - 120) { doc.addPage(); y = 80; }
  const sigW = (W - 40) / 3;
  const inspectors = [...new Set(snap.samples.map((s) => s.taken_by).filter(Boolean))].join(', ');
  [['Inspeccionó', inspectors || lot.created_by_name], ['Emitió', snap.issued_by || lot.decided_by_name], ['Visto bueno (Jefe de calidad)', '']]
    .forEach(([role, name], i) => {
      const x = L + i * (sigW + 20);
      doc.moveTo(x, y + 25).lineTo(x + sigW, y + 25).stroke('#555');
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000').text(name || '—', x, y + 30, { width: sigW, align: 'center' });
      doc.font('Helvetica').fontSize(8).text(role, x, y + 42, { width: sigW, align: 'center' });
    });

  // Anexo: lecturas por punto
  doc.addPage();
  y = 40;
  y = sectionTitle(doc, `Anexo. Lecturas por muestra — Certificado ${snap.number} — Lote ${lot.lot_number}`, L, y, W);
  const pcols = [['Característica', 150, 'left'], ...'ABCD'.split('').map((p) => [p, (W - 150) / 4])];
  for (const sample of snap.samples) {
    if (y > doc.page.height - 150) { doc.addPage(); y = 40; }
    doc.font('Helvetica-Bold').fontSize(9).text(`Muestra ${sample.sample_no}  ·  ${sample.taken_by || ''}  ·  ${sample.taken_at}`, L, y);
    y += 14;
    y = tableHeader(doc, pcols, L, y);
    for (const spec of snap.specs) {
      if (spec.points) {
        const vals = spec.points.split(',').map((p) => sample.values[`${spec.id}|${p}`]);
        y = tableRow(doc, pcols, [`${spec.characteristic} (${spec.unit})`, ...vals.map((v) => (v ? fmt(v.value, 2) : '—'))], L, y);
      } else {
        const v = sample.values[`${spec.id}|`];
        const single = [['', 150, 'left'], ['', W - 150, 'left']];
        y = tableRow(doc, single, [`${spec.characteristic} (${spec.unit})`, v ? fmt(v.value, 2) : '—'], L, y);
      }
    }
    y += 10;
  }

  // Anexo: detalle de pruebas por envase (impacto, filtración, inspección visual)
  const detailed = snap.tests.filter((t) => t.detail && (t.checks || t.detail.includes(';')));
  if (detailed.length) {
    if (y > doc.page.height - 150) { doc.addPage(); y = 40; } else y += 6;
    y = sectionTitle(doc, `Anexo. Pruebas de liberación por envase — Lote ${lot.lot_number}`, L, y, W);
    for (const t of detailed) {
      if (y > doc.page.height - 120) { doc.addPage(); y = 40; }
      const groups = t.detail.split(';').map((g) => g.split(','));
      const names = t.items ? t.items.split(',') : null;
      const n = t.checks || 0;
      const rule = names ? 'Se aprueba si no tiene ningún defecto'
        : n ? `Cada envase se aprueba si resiste mínimo ${t.min_ok || n} caídas` : 'Resultado por envase';
      doc.font('Helvetica-Bold').fontSize(9).text(`${t.name}  ·  ${rule}  ·  ${t.performed_by || ''}  ·  ${t.performed_at || ''}`, L, y, { width: W });
      y = doc.y + 4;
      const first = 60;
      const last = 80;
      if (n && !names) {
        // Checklist de impactos: una casilla por golpe (✓ resistió, ✗ falló) y el total resistido.
        const tot = 70;
        const mid = (W - first - tot - last) / n;
        const cols = [['Envase', first], ...[...Array(n)].map((_, i) => [`Impacto ${i + 1}`, mid]), ['Resistió', tot], ['Resultado', last]];
        y = tableHeader(doc, cols, L, y);
        groups.forEach((g, ui) => {
          const si = resisted(g);
          const ok = si >= (t.min_ok || n);
          y = tableRow(doc, cols, [String(ui + 1), ...g.map(() => ''), `${si} de ${n}`, ok ? 'APROBADO' : 'NO APROBADO'], L, y, { last: ok ? '#1d7a35' : '#b3261e' });
          const rowTop = y - 13;
          // Después de la primera caída que falla, las siguientes quedan como falladas (X).
          g.forEach((v, i) => checkbox(doc, L + first + i * mid + mid / 2 - 5, rowTop + 1.5, i < si));
        });
      } else {
        const mid = n ? (W - first - last) / n : 0;
        const cols = [['Envase', first], ...[...Array(n)].map((_, i) => [names[i] || `Defecto ${i + 1}`, mid]), ['Resultado', n ? last : W - first]];
        y = tableHeader(doc, cols, L, y);
        groups.forEach((g, ui) => {
          const ok = n ? g.every((v) => v === '1') : g[0] === '1';
          const cells = n ? g.map((v) => (v === '1' ? 'No tiene' : 'Sí tiene')) : [];
          y = tableRow(doc, cols, [String(ui + 1), ...cells, ok ? 'APROBADO' : 'NO APROBADO'], L, y, { last: ok ? '#1d7a35' : '#b3261e' });
        });
      }
      y += 10;
    }
  }

  // Pie de página
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7).fillColor('#777').text(
      `${snap.number} · Emitido por ${snap.issued_by} · Página ${i + 1} de ${range.count}`,
      L, doc.page.height - 30, { width: W, align: 'center', lineBreak: false });
  }
  doc.end();
}

// Informe de lote rechazado, con hallazgos y evidencia fotográfica.
function rejectionPdf(ev, photos, stream) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 40, bufferPages: true, info: { Title: `Informe de rechazo ${ev.lot.lot_number}` } });
  doc.pipe(stream);
  const L = 40;
  const W = doc.page.width - 80;
  const lot = ev.lot;
  const RED = '#b3261e';

  doc.rect(L, 40, W, 60).stroke(RED);
  doc.fillColor('#1f3b57').font('Helvetica-Bold').fontSize(13).text(COMPANY(), L + 10, 50, { width: W - 180 });
  doc.fillColor(RED).font('Helvetica-Bold').fontSize(11).text('INFORME DE LOTE RECHAZADO', L + 10, 72, { width: W - 180 });
  doc.fontSize(9).font('Helvetica').fillColor('#333').text('Control de calidad de producto terminado', L + 10, 86);
  doc.rect(L + W - 160, 40, 160, 60).fill(RED);
  doc.fillColor('#fff').fontSize(9).text('LOTE', L + W - 160, 52, { width: 160, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(14).text(lot.lot_number, L + W - 160, 66, { width: 160, align: 'center' });
  doc.fillColor('#000');

  let y = 115;
  const info = [
    ['Producto', `${lot.product_name} (${lot.product_code})`],
    ['Tipo de molde', lot.molde],
    ['Fecha de producción', lot.production_date],
    ['Turno / Máquina', [lot.shift, lot.machine].filter(Boolean).join(' / ') || '—'],
    ['Cantidad del lote', lot.quantity ? `${lot.quantity} unidades` : '—'],
    ['Muestras evaluadas', String(ev.samples.length)],
    ['Rechazado por', lot.decided_by_name],
    ['Fecha de rechazo', lot.decided_at],
  ];
  const colW = W / 2;
  info.forEach(([k, v], i) => {
    const x = L + (i % 2) * colW;
    const yy = y + Math.floor(i / 2) * 18;
    doc.font('Helvetica-Bold').fontSize(8.5).text(k + ':', x, yy, { width: 105 });
    doc.font('Helvetica').text(v || '—', x + 105, yy, { width: colW - 110 });
  });
  y += Math.ceil(info.length / 2) * 18 + 10;

  y = sectionTitle(doc, '1. Motivo del rechazo', L, y, W);
  doc.font('Helvetica').fontSize(9).text(lot.decision_notes || '—', L + 4, y, { width: W - 8 });
  y = doc.y + 10;

  y = sectionTitle(doc, '2. Hallazgos registrados', L, y, W);
  const found = ev.problems.length ? ev.problems : ['Sin hallazgos automáticos: ver motivo y evidencia fotográfica.'];
  doc.font('Helvetica').fontSize(8.5);
  for (const p of found) {
    if (y > doc.page.height - 60) { doc.addPage(); y = 40; }
    doc.text('• ' + p, L + 4, y, { width: W - 8 });
    y = doc.y + 2;
  }
  y += 8;

  if (y > doc.page.height - 120) { doc.addPage(); y = 40; }
  y = sectionTitle(doc, '3. Especificaciones (peso y dimensiones)', L, y, W);
  const cols = [['Característica', 170, 'left'], ['Unid.', 40], ['LIC', 50], ['LSC', 50], ['Mín', 50], ['Máx', 50], ['Fuera', 40], ['Resultado', W - 450]];
  y = tableHeader(doc, cols, L, y);
  for (const x of ev.specSummary) {
    const s = x.spec;
    const res = x.n ? (x.ok ? 'CONFORME' : 'NO CONFORME') : 'SIN DATOS';
    y = tableRow(doc, cols, [s.characteristic, s.unit, fmt(s.lic), fmt(s.lsc), fmt(x.min, 2), fmt(x.max, 2), String(x.out), res], L, y, { last: x.ok ? '#1d7a35' : RED });
  }
  y += 10;

  if (y > doc.page.height - 100) { doc.addPage(); y = 40; }
  y = sectionTitle(doc, '4. Pruebas', L, y, W);
  const tcols = [['Prueba', 200, 'left'], ['Realizada por', 160, 'left'], ['Resultado', W - 360]];
  y = tableHeader(doc, tcols, L, y);
  for (const t of ev.tests) {
    const r = t.result;
    const res = !r ? 'PENDIENTE' : r.result === 'pasa' ? 'APROBADO' : 'NO APROBADO';
    y = tableRow(doc, tcols, [t.type.name, r ? r.performed_by_name || '—' : '—', res], L, y, { last: r && r.result === 'pasa' ? '#1d7a35' : RED });
  }
  y += 10;

  // Evidencia fotográfica: 2 por fila.
  if (y > doc.page.height - 120) { doc.addPage(); y = 40; }
  y = sectionTitle(doc, `5. Evidencia fotográfica (${photos.length})`, L, y, W);
  if (!photos.length) {
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#444').text('No se adjuntaron fotos.', L + 4, y);
    doc.fillColor('#000');
  }
  const gap = 12;
  const pw = (W - gap) / 2;
  const ph = 190;
  photos.forEach((p, i) => {
    const col = i % 2;
    if (col === 0 && y + ph + 40 > doc.page.height - 45) { doc.addPage(); y = 40; }
    const x = L + col * (pw + gap);
    doc.rect(x, y, pw, ph).stroke('#c8ced4');
    try {
      doc.image(Buffer.from(p.data, 'base64'), x + 4, y + 4, { fit: [pw - 8, ph - 8], align: 'center', valign: 'center' });
    } catch (e) {
      doc.font('Helvetica-Oblique').fontSize(8).text('Imagen no disponible', x, y + ph / 2, { width: pw, align: 'center' });
    }
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#000').text(`Foto ${i + 1}${p.caption ? ': ' + p.caption : ''}`, x, y + ph + 3, { width: pw });
    doc.font('Helvetica').fontSize(7.5).fillColor('#444').text(`${p.taken_by_name || '—'} · ${p.created_at}`, x, doc.y + 1, { width: pw });
    doc.fillColor('#000');
    if (col === 1 || i === photos.length - 1) y += ph + 38;
  });

  // Firmas
  if (y > doc.page.height - 110) { doc.addPage(); y = 40; }
  y = Math.max(y + 20, doc.y + 30);
  const sw = (W - 40) / 2;
  [['Rechazó', lot.decided_by_name], ['Recibe (producción)', '']].forEach(([k, v], i) => {
    const x = L + i * (sw + 40);
    doc.moveTo(x, y + 30).lineTo(x + sw, y + 30).stroke('#555');
    doc.font('Helvetica-Bold').fontSize(8.5).text(k, x, y + 34, { width: sw, align: 'center' });
    doc.font('Helvetica').fontSize(8).text(v || ' ', x, y + 46, { width: sw, align: 'center' });
  });

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7.5).fillColor('#666').text(
      `Informe de rechazo · Lote ${lot.lot_number} · Página ${i + 1} de ${range.count}`,
      L, doc.page.height - 30, { width: W, align: 'center', lineBreak: false });
  }
  doc.end();
}

// Casilla de 10 pt: con chulo verde si resistió, con X roja si falló.
function checkbox(doc, x, y, ok) {
  doc.save().lineWidth(0.8).rect(x, y, 10, 10).stroke('#555');
  if (ok) doc.lineWidth(1.6).moveTo(x + 2, y + 5.2).lineTo(x + 4.3, y + 7.8).lineTo(x + 8.4, y + 2.2).stroke('#1d7a35');
  else doc.lineWidth(1.4).moveTo(x + 2.3, y + 2.3).lineTo(x + 7.7, y + 7.7).moveTo(x + 7.7, y + 2.3).lineTo(x + 2.3, y + 7.7).stroke('#b3261e');
  doc.restore();
}

function sectionTitle(doc, text, x, y, w) {
  doc.rect(x, y, w, 16).fill('#dfe7ef');
  doc.fillColor('#1f3b57').font('Helvetica-Bold').fontSize(9).text(text, x + 6, y + 4, { width: w - 12 });
  doc.fillColor('#000');
  return y + 20;
}

function tableHeader(doc, cols, x, y) {
  let cx = x;
  doc.font('Helvetica-Bold').fontSize(7.5);
  for (const [label, w, align] of cols) {
    doc.rect(cx, y, w, 14).fillAndStroke('#f2f4f6', '#c8ced4');
    doc.fillColor('#000').text(label, cx + 3, y + 4, { width: w - 6, align: align || 'center' });
    cx += w;
  }
  return y + 14;
}

function tableRow(doc, cols, values, x, y, opts = {}) {
  doc.font('Helvetica').fontSize(7.5);
  const heights = cols.map(([, w], i) => doc.heightOfString(String(values[i] ?? ''), { width: w - 6 }));
  const h = Math.max(13, ...heights.map((hh) => hh + 5));
  if (y + h > doc.page.height - 45) { doc.addPage(); y = 40; }
  let cx = x;
  cols.forEach(([, w, align], i) => {
    doc.rect(cx, y, w, h).stroke('#c8ced4');
    let color = '#000';
    if (i === cols.length - 1 && opts.last) color = opts.last;
    if (i === 1 && opts.color1) color = opts.color1;
    doc.fillColor(color).font(color !== '#000' ? 'Helvetica-Bold' : 'Helvetica')
      .text(String(values[i] ?? ''), cx + 3, y + 3, { width: w - 6, align: align || 'center' });
    cx += w;
  });
  doc.fillColor('#000');
  return y + h;
}

module.exports = { certificatePdf, rejectionPdf };
