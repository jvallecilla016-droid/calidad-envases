// Comportamiento del lado del celular: instalación, borradores y validación en vivo.
(function () {
  'use strict';
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
  }

  // Botón «Instalar app» (Android / Chrome).
  var deferred = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); deferred = e;
    var card = document.getElementById('install-card'); if (card) card.hidden = false;
  });
  document.addEventListener('click', function (e) {
    if (e.target && e.target.id === 'install-btn' && deferred) {
      deferred.prompt(); deferred.userChoice.finally(function () { deferred = null; document.getElementById('install-card').hidden = true; });
    }
  });

  function safe(fn) { try { return fn(); } catch (e) { return null; } }

  // Borrador: lo digitado en una muestra se guarda en el celular hasta que el servidor confirma.
  var params = new URLSearchParams(location.search);
  var done = params.get('guardado');
  if (done) safe(function () { localStorage.removeItem('borrador:' + done); });

  document.addEventListener('DOMContentLoaded', function () {
    var form = document.querySelector('form[data-draft]');
    var inputs = document.querySelectorAll('input.meas');
    var key = form ? 'borrador:' + form.dataset.draft : null;

    if (form && key) {
      var saved = safe(function () { return JSON.parse(localStorage.getItem(key) || 'null'); });
      var anyFilled = Array.prototype.some.call(inputs, function (i) { return i.value.trim() !== ''; });
      if (saved && !anyFilled) {
        inputs.forEach(function (i) { if (saved[i.name] !== undefined) i.value = saved[i.name]; });
        var note = document.getElementById('draft-note'); if (note) note.hidden = false;
      }
      form.addEventListener('input', function () {
        var data = {}; inputs.forEach(function (i) { if (i.value.trim() !== '') data[i.name] = i.value; });
        safe(function () { localStorage.setItem(key, JSON.stringify(data)); });
      });
      form.addEventListener('submit', function (e) {
        if (!navigator.onLine) {
          e.preventDefault();
          alertBox('Sin señal: la muestra NO se ha enviado. Queda guardada en el celular; toca Guardar cuando vuelva la conexión.');
        }
      });
    }

    function check(el) {
      var v = parseFloat(String(el.value).replace(',', '.'));
      el.classList.remove('in', 'out');
      if (el.value.trim() === '' || isNaN(v)) return;
      el.classList.add(v >= +el.dataset.lic && v <= +el.dataset.lsc ? 'in' : 'out');
    }
    function summary() {
      var live = document.getElementById('live'); if (!live) return;
      var out = document.querySelectorAll('input.meas.out').length;
      var filled = document.querySelectorAll('input.meas.in, input.meas.out').length;
      live.textContent = filled + ' de ' + inputs.length + ' lecturas' + (out ? ' · ' + out + ' FUERA' : '');
      live.classList.toggle('bad', out > 0);
      document.querySelectorAll('fieldset.spec').forEach(function (fs) {
        var o = fs.querySelectorAll('input.meas.out').length, all = fs.querySelectorAll('input.meas').length, f = fs.querySelectorAll('input.meas.in, input.meas.out').length;
        fs.classList.toggle('has-out', o > 0); fs.classList.toggle('done', f === all && o === 0);
      });
    }
    inputs.forEach(function (el, i) {
      check(el);
      el.addEventListener('input', function () { check(el); summary(); });
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); var n = inputs[i + 1]; if (n) n.focus(); else if (form) form.requestSubmit(); }
      });
    });
    summary();
  });

  function alertBox(msg) {
    var d = document.getElementById('net-alert');
    if (!d) { d = document.createElement('div'); d.id = 'net-alert'; d.className = 'flash error'; d.setAttribute('role', 'alert'); var m = document.querySelector('main'); m.insertBefore(d, m.firstChild); }
    d.textContent = msg; window.scrollTo(0, 0);
  }
  window.addEventListener('offline', function () { document.body.classList.add('offline'); });
  window.addEventListener('online', function () { document.body.classList.remove('offline'); });
})();

// Prueba con casillas: muestra cuántos impactos resistió (o defectos encontrados) y si pasa.
document.querySelectorAll('fieldset.checklist').forEach((fs) => {
  const min = Number(fs.dataset.min);
  const out = fs.querySelector('.chk-total');
  const rows = fs.querySelectorAll('.chk-row');
  const impact = fs.dataset.kind !== 'defectos';
  // Impacto: si el envase falla en una caída, las siguientes quedan marcadas como falladas.
  if (impact) {
    fs.addEventListener('change', (e) => {
      if (e.target.value !== 'no') return;
      const idx = [...rows].findIndex((r) => r.contains(e.target));
      [...rows].slice(idx + 1).forEach((r) => { const no = r.querySelector('input[value=no]'); if (no) no.checked = true; });
    });
  }
  const update = () => {
    const marked = fs.querySelectorAll('input:checked');
    let si = fs.querySelectorAll('input[value=si]:checked').length;
    if (impact) {
      si = 0;
      for (const r of rows) { if (r.querySelector('input[value=si]:checked')) si++; else break; }
    }
    if (marked.length < rows.length) {
      out.textContent = `Faltan ${rows.length - marked.length} casillas por marcar`;
      out.className = 'chk-total muted';
    } else {
      const pasa = si >= min;
      const bad = rows.length - si;
      out.textContent = fs.dataset.kind === 'defectos'
        ? `${bad ? `${bad} defecto${bad > 1 ? 's' : ''} encontrado${bad > 1 ? 's' : ''}` : 'Sin defectos'}: ${pasa ? 'APROBADO' : 'NO APROBADO'}`
        : `Resistió ${si} de ${rows.length} caídas: ${pasa ? 'APROBADO' : 'NO APROBADO'}`;
      out.className = `chk-total ${pasa ? 'ok' : 'bad'}`;
    }
  };
  fs.addEventListener('change', update);
  update();
});

// Acciones que no se pueden deshacer: piden confirmación antes de enviar.
document.querySelectorAll('form[data-confirm]').forEach((f) => {
  f.addEventListener('submit', (e) => { if (!window.confirm(f.dataset.confirm)) e.preventDefault(); });
});

// Evidencia fotográfica: la foto se reduce en el celular (máx. 1600 px, JPEG) antes de enviarla.
(function () {
  const form = document.getElementById('photo-form');
  if (!form) return;
  const file = document.getElementById('photo-file');
  const data = document.getElementById('photo-data');
  const preview = document.getElementById('photo-preview');
  const btn = document.getElementById('photo-btn');
  let ready = null;
  file.addEventListener('change', () => {
    data.value = '';
    const f = file.files && file.files[0];
    if (!f) return;
    btn.disabled = true; btn.textContent = 'Preparando foto…';
    const url = URL.createObjectURL(f);
    const img = new Image();
    ready = new Promise((resolve) => {
      img.onload = () => {
        const max = 1600;
        const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        data.value = c.toDataURL('image/jpeg', 0.75);
        preview.src = data.value; preview.hidden = false;
        URL.revokeObjectURL(url);
        btn.disabled = false; btn.textContent = 'Guardar foto';
        resolve();
      };
      img.onerror = () => { btn.disabled = false; btn.textContent = 'Guardar foto'; window.alert('No se pudo leer la imagen. Intenta con otra foto.'); resolve(); };
    });
    img.src = url;
  });
  form.addEventListener('submit', (e) => {
    if (!data.value) { e.preventDefault(); if (ready) ready.then(() => { if (data.value) form.requestSubmit(); }); return; }
    file.disabled = true; // el archivo original no se envía, solo la versión reducida
    btn.disabled = true; btn.textContent = 'Enviando…';
  });
})();
