'use strict';
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
    .text('Cada diámetro se midió en los puntos A–H de cada muestra. Todas las lecturas quedaron dentro de LIC–LSC.', L, y, { width: W });
  doc.fillColor('#000');
  y += 18;

  // Pruebas
  y = sectionTitle(doc, '2. Pruebas de liberación', L, y, W);
  const tcols = [['Prueba', 120, 'left'], ['Resultado', 60], ['Realizada por', 110, 'left'], ['Fecha', 85], ['Observaciones', W - 375, 'left']];
  y = tableHeader(doc, tcols, L, y);
  for (const t of snap.tests) {
    y = tableRow(doc, tcols, [t.name, t.result === 'pasa' ? 'PASA' : 'NO PASA', t.performed_by || '—', t.performed_at, t.observations || ''], L, y,
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
  [['Inspeccionó', inspectors || lot.created_by_name], ['Revisó (Analista de calidad)', lot.submitted_by_name], ['Aprobó (Jefe de calidad)', lot.decided_by_name]]
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
  const pcols = [['Característica', 150, 'left'], ...'ABCDEFGH'.split('').map((p) => [p, (W - 150) / 8])];
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

module.exports = { certificatePdf };
