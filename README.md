# Calidad Envases · Liberación de lotes

Aplicación web para registrar las mediciones de calidad de cada lote de producción (pesos y diámetros), las pruebas de liberación (impacto y filtración) y emitir un certificado PDF con consecutivo cuando el lote cumple todo.

## Qué hace

- **Catálogo de productos** con especificaciones LIC / LCC / LSC. Los pesos llevan 1 lectura por muestra; los diámetros llevan 8 lecturas (puntos A–H). Viene precargado con las fichas del manual de calidad (Ref. 01 colada fría y caliente, Ref. 02, Ref. 03, Ref. 04 y Ref. 05 colada fría y caliente).
- **Lotes**: el número de lote lo digita el usuario tal como sale de producción. La app solo valida que no se repita.
- **Muestras**: cada casilla se pone verde o roja al digitarla. Una sola lectura fuera de LIC–LSC deja el lote como NO CUMPLE.
- **Pruebas de liberación**: impacto y filtración (Pasa / No pasa + observaciones). Desde el menú *Pruebas* se pueden agregar más; toda prueba activa se vuelve obligatoria.
- **Flujo de aprobación**: En proceso → En revisión → Liberado o Rechazado.
- **Certificado PDF** con consecutivo único por año (`CL-2026-0001`, `CL-2026-0002`…), con el resumen de especificaciones, las pruebas, las firmas y un anexo con todas las lecturas por punto. El certificado guarda una foto de los datos al momento de liberar, así que no cambia si después se editan las especificaciones.
- **Indicadores** (menú *Indicadores*): lotes liberados y rechazados, porcentaje de cumplimiento, lotes por semana, cumplimiento por producto, lecturas fuera de LIC–LSC por punto A–H y por característica, resultados de impacto y filtración, y el detalle de cada lectura fuera de especificación. Se calcula en vivo con los lotes de la base de datos y se filtra por producto, tipo de molde y rango de fechas de producción. El botón *Descargar lotes (CSV)* exporta los lotes filtrados para abrirlos en Excel.
- **Registro de auditoría** de cada acción (tabla `audit_log`).

## Perfiles

| Perfil | Puede |
|---|---|
| Operario / Inspector | Crear lotes, registrar muestras y resultados de pruebas |
| Analista de calidad | Lo anterior + editar productos y especificaciones, crear pruebas, eliminar muestras, enviar lotes a aprobación |
| Jefe de calidad | Lo anterior + aprobar (emite el certificado) o rechazar lotes, administrar usuarios |

Usuarios iniciales (contraseña `Calidad2026*` para los tres): `inspector`, `analista`, `jefe`.
**Cámbienla el primer día** desde *Mi cuenta* (clic en el nombre arriba a la derecha). El jefe puede crear los usuarios con el nombre real de cada persona en *Usuarios*.

## Instalar y ejecutar

Requisito: [Node.js 22 LTS o más reciente](https://nodejs.org/) (trae SQLite incluido; no hay que instalar base de datos).

```bash
npm install
npm start
```

Abrir http://localhost:3000. En el computador, sin `DATABASE_URL`, los datos quedan en `data/calidad.db` (SQLite).

**Para usarla desde los celulares con una base de datos central en internet**, sigue [docs/PUBLICAR-EN-INTERNET.md](docs/PUBLICAR-EN-INTERNET.md) (Render + Neon, plan gratis).

Para que otros equipos de la planta entren, abran `http://IP-DEL-EQUIPO:3000` desde la misma red.

Variables opcionales:

| Variable | Uso |
|---|---|
| `PORT` | Puerto (por defecto 3000) |
| `COMPANY_NAME` | Nombre de la empresa en el encabezado y el certificado |
| `SESSION_SECRET` | Clave fija para las sesiones (si no se pone, al reiniciar el servidor todos deben volver a ingresar) |
| `DATABASE_URL` | Cadena de conexión PostgreSQL (Neon). Si existe, la app usa PostgreSQL y guarda ahí también las sesiones |
| `DB_FILE` | Ruta del archivo SQLite cuando no hay `DATABASE_URL` |

Ejemplo en Windows (PowerShell):

```powershell
$env:COMPANY_NAME="Envases XYZ S.A.S."; $env:SESSION_SECRET="una-frase-larga-secreta"; npm start
```

## Pruebas automáticas

```bash
npm test
```

Para correrlas contra PostgreSQL, usa una base de pruebas vacía (las pruebas la borran):

```bash
TEST_DATABASE_URL=postgres://usuario:clave@localhost/calidad_test npm test
```

## Supuestos sobre los datos precargados

- En la tabla de pesos, el número del producto (#1, #3, #5) se asumió igual a la referencia de las fichas dimensionales (Ref. 01, 03, 05).
- Ref. 02 y Ref. 04 solo tienen pesos; no había ficha dimensional en las fotos.
- Ref. 05 colada fría no tiene peso de tapa en la tabla; Ref. 05 colada caliente no tiene ficha dimensional.
- Las fichas de Ref. 03 y Ref. 05 traen los mismos diámetros. Verifíquenlo contra el manual.

Todo se corrige desde *Productos* sin tocar código.
