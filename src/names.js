'use strict';
// Nombre de la pieza principal según el producto: «Cuñete» o «Galón», con su referencia.
function bodyName(name, ref) {
  const n = String(name || '');
  const base = /^gal[oó]n/i.test(n) ? 'Galón' : /^cu[ñn]ete/i.test(n) ? 'Cuñete' : 'Envase';
  return ref ? `${base} Ref. ${ref}` : base;
}
module.exports = { bodyName };
