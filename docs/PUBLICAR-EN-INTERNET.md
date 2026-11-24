# Publicar la app en internet (Render + Neon, gratis)

Al terminar tendrás una dirección como `https://calidad-envases.onrender.com` que abre en cualquier celular con datos o wifi. Todos los operarios escriben en la misma base de datos.

- **Neon** guarda la base de datos (PostgreSQL).
- **Render** ejecuta la app y la conecta con GitHub: cada cambio que se una a `main` se publica solo.

Tiempo estimado: 20 minutos. No piden tarjeta de crédito.

## 1. Crear la base de datos en Neon

1. Entra a https://neon.tech y elige **Sign up** con tu cuenta de GitHub.
2. Crea un proyecto: nombre `calidad-envases`, región **AWS Este de EE. UU. 1 (Norte de Virginia)** (es la más cercana a Colombia y la misma donde queda la app en Render), versión de Postgres la que venga por defecto.
3. En el panel del proyecto pulsa **Connect**. Copia la cadena de conexión que empieza por `postgresql://` y termina en `?sslmode=require`.
4. Guárdala en un lugar privado. Esa cadena es la llave de la base: no la compartas ni la subas a GitHub.

## 2. Crear la app en Render

1. Entra a https://render.com y elige **Sign up** con GitHub.
2. Pulsa **New +** → **Blueprint**.
3. Autoriza a Render para ver el repositorio `calidad-envases` y selecciónalo. Render lee el archivo `render.yaml` y propone el servicio `calidad-envases` en plan gratis.
4. Te pedirá el valor de **DATABASE_URL**: pega la cadena de Neon del paso 1.
5. Pulsa **Apply**. La primera publicación tarda unos 3 minutos. Cuando diga **Live**, abre la dirección `.onrender.com` que aparece arriba.

La app crea las tablas, los 7 productos, las pruebas de impacto y filtración y los 3 usuarios la primera vez que arranca.

## 3. Primer ingreso

1. Entra con `jefe` / `Calidad2026*`.
2. Ve a **Más → Usuarios** y cambia la contraseña de los tres usuarios. Crea un usuario por cada operario para que el registro de quién midió quede con su nombre.
3. En cada celular abre la dirección y usa **Más → Instalar la app** (Android) o **Compartir → Agregar a inicio** (iPhone).

## Lo que hay que saber del plan gratis

- Si nadie usa la app durante 15 minutos, Render la duerme. El siguiente que entre espera cerca de un minuto mientras despierta; después funciona normal.
- Neon gratis guarda 0,5 GB. Con mediciones de 8 puntos alcanza para varios años de lotes.
- Si la planta empieza a depender de la app en todos los turnos, el plan Starter de Render (7 USD al mes) elimina la espera del arranque. No hay que cambiar nada del código.

## Probar en el computador sin internet

Sin `DATABASE_URL` la app usa un archivo SQLite local (`data/calidad.db`):

```
npm install
npm start
```

Y abre http://localhost:3000.
