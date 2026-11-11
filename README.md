# Finanzas Personales

App de un solo `index.html`. Se abre en el navegador y lee y escribe Cloud Firestore directo, con el SDK web de Firebase. No hay login de usuarios ni un servidor propio: la pantalla escucha `data/main` y pinta lo que hay ahí.

Proyecto Firebase: `finanzas-personales-7b3ea`.  
Deploy: Vercel, proyecto `organizador-finanzas`, [https://organizador-finanzas.vercel.app](https://organizador-finanzas.vercel.app).

La API de este repo es para el bot de Renzo (un cliente de servidor, no el navegador). Escribe en las mismas colecciones y con la misma forma de documento que la pantalla, así un gasto creado por el bot aparece en la UI igual que uno cargado a mano.

## Dónde están los datos

Todo cuelga de `data/main`:

| Colección | Qué es |
| --- | --- |
| `transactions` | Gastos, ingresos y transferencias entre USD y UYU |
| `categories` | Categorías creadas a mano. Las de fábrica no están acá |
| `debts` | Deudas |
| `subscriptions` | Débitos automáticos |
| `events` | Recordatorios del calendario (se repiten todos los meses, por día) |
| `accounts`, `assets` | Los usa la UI. Esta API no los toca |
| `settings/main` | Documento (no es una lista): categorías de fábrica ocultas y metas de ahorro. Esta API no lo toca |

Las categorías de fábrica (`comida`, `transporte`, `salud`, `casa`, `ocio`, `trabajo`, `otro`, `deuda`) viven en el código de `index.html`. Para usarlas en un movimiento alcanza con mandar ese `id` en `category`. No hace falta crearlas.

## API

Base: `https://organizador-finanzas.vercel.app/api`

Cada request lleva:

```http
Authorization: Bearer <API_TOKEN>
x-vercel-protection-bypass: <secreto de Protection Bypass for Automation>
```

El bypass lo controla Vercel antes de llegar a la función. La función no lee ese header: si falta, Vercel responde con la página de login y el código de acá ni corre. En local (`npm test`) no hace falta.

No mandes `x-vercel-set-bypass-cookie`. Ese header hace que Vercel responda con un redirect para guardar una cookie, y el bot no va a ver el JSON.

`POST` y `PATCH` van con `Content-Type: application/json`. Los montos y los días (`billingDay`, `day`) son números, no strings (`1250`, no `"1250"`), porque la UI suma con `+` y un string le rompe las cuentas.

Colecciones habilitadas: `transactions`, `debts`, `subscriptions`, `events`, `categories`. Cualquier otra ruta responde 404.

| Método | Ruta | Qué hace |
| --- | --- | --- |
| `GET` | `/api/<colección>` | Lista |
| `POST` | `/api/<colección>` | Crea. Si mandás `id` y ya existe, devuelve el documento guardado y no escribe de nuevo |
| `GET` | `/api/<colección>/<id>` | Trae uno |
| `PATCH` | `/api/<colección>/<id>` | Actualiza solo los campos que mandás |
| `DELETE` | `/api/<colección>/<id>` | Borra |

El `id` del alta va en el body, no en la URL. Un `POST /api/transactions/<id>` no crea nada.

### Idempotencia

Si el bot reintenta (Gmail, timeout, etc.) tiene que mandar el mismo `id`. La primera vez responde `201` con `"created": true`. Si ese `id` ya está en esa colección, responde `200` con `"created": false` y el documento que ya estaba, aunque el body nuevo sea distinto o esté incompleto. No se duplica y no se pisa.

El `id` es por colección. El mismo string puede existir en `transactions` y en `debts`: son documentos distintos. Si un mail genera un gasto y una deuda, usá dos ids (por ejemplo `gmail_abc` y `gmail_abc_debt`).

Caracteres del id: letras, números, `_` y `-`, de 1 a 128, empezando por letra o número. Sirve el `id` de la API de Gmail (hex o base64url). El Message-ID del encabezado (`<...@mail.gmail.com>`) no: trae `@` y puntos. Si no mandás `id`, el servidor genera uno con el mismo prefijo que la UI (`tx_`, `debt_`, `sub_`, `evt_`, `c_`) más un sufijo aleatorio.

### Fechas

La UI filtra el mes con la hora local. Una fecha `YYYY-MM-DD` se guarda como mediodía UTC (`2026-11-11T12:00:00.000Z`), así en Uruguay cae en ese mismo día. También podés mandar un ISO completo con hora. En deudas, `dueDate` es solo `YYYY-MM-DD`, igual que el input de la pantalla.

### Transacciones

`GET /api/transactions` acepta:

- `from` y `to`: un día (`2026-11-01`) o un ISO con hora. El día se corta en hora de Uruguay (UTC−3, sin horario de verano), igual que el mes de la pantalla. Con hora, se usa ese instante.
- `type`: `expense`, `income` o `transfer`
- `currency`: `USD` o `UYU`
- `limit`: 1 a 2000, por defecto 1000. Si `"truncated"` es `true`, achicá el rango de fechas: hay más movimientos que los que entraron en la página.

Gasto o ingreso, igual que `addTx()`:

```json
{
  "id": "gmail_18c3abf0e1",
  "type": "expense",
  "amount": 1250,
  "currency": "UYU",
  "category": "comida",
  "note": "Disco",
  "date": "2026-11-11"
}
```

`type` es `expense` o `income`. `category` es el id (`comida`, `deuda`, `c_...`). `note` puede ir vacío.

Transferencia entre monedas, igual que la UI:

```json
{
  "type": "transfer",
  "fromCurrency": "USD",
  "toCurrency": "UYU",
  "fromAmount": 100,
  "toAmount": 4000,
  "note": "cambio",
  "date": "2026-11-11"
}
```

La API completa `currency` y `amount` con el lado que sale, como hace la pantalla.

### Deudas

```json
{
  "id": "debt_visa",
  "entity": "Visa",
  "totalAmount": 10000,
  "currency": "UYU",
  "dueDate": "2026-12-05",
  "note": "tarjeta",
  "paid": false,
  "payments": []
}
```

`dueDate` puede ser `null`. `payments` es una lista de `{ "id", "amount", "date", "txId" }`.

El botón **Abonar** de la UI hace dos escrituras: un gasto (`type: "expense"`, `category: "deuda"`, nota `Abono · <entidad>`) y agrega ese pago en la deuda. Para que el resumen y la deuda coincidan, el bot tiene que hacer las dos cosas. Ejemplo: crear la transacción con un id fijo y después hacer `PATCH` de `payments`. Si el segundo paso falla, reintentar la transacción con el mismo id no la duplica.

`PATCH` con `{ "paid": true }` archiva la deuda y deja los pagos como estaban, igual que **Marcar saldada**.

### Suscripciones

```json
{
  "name": "Netflix",
  "icon": "🎬",
  "amount": 15,
  "currency": "USD",
  "billingDay": 4,
  "active": true
}
```

`billingDay` es el día del mes, de 1 a 31. Si no mandás `icon`, queda `📱`. `createdAt` lo pone el servidor y un `PATCH` no lo cambia. Pausar es `PATCH` con `{ "active": false }`.

### Eventos (recordatorios)

```json
{
  "name": "Sueldo",
  "type": "income",
  "day": 1,
  "amount": 50000,
  "icon": "💰"
}
```

`type` es `income` o `expense`. `day` es el día del mes. `amount` puede ser `null`. El ícono por defecto es `💰` o `💸`. No es una fecha puntual: el calendario lo repite todos los meses, como la UI.

### Categorías

`GET /api/categories` devuelve `items` (las que están en Firestore) y `defaults` (las de fábrica, que no están en Firestore).

```json
{ "name": "Mascotas", "icon": "🐾" }
```

El nombre se guarda en minúsculas. No se puede crear una con el nombre de una de fábrica. Borrar `comida` por la API responde 404: ocultar una de fábrica es un campo de `settings/main` (`hiddenDefaults`) y esta API no escribe ese documento.

## Ejemplos con curl

```bash
export API_TOKEN="..."
export VERCEL_AUTOMATION_BYPASS_SECRET="..."
BASE="https://organizador-finanzas.vercel.app"

# Alta idempotente de un gasto
curl -sS -X POST "$BASE/api/transactions" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"id":"gmail_18c3abf0e1","type":"expense","amount":1250,"currency":"UYU","category":"comida","note":"Disco","date":"2026-11-11"}'

# Listar noviembre
curl -sS "$BASE/api/transactions?from=2026-11-01&to=2026-11-30&type=expense" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET"

# Corregir la nota
curl -sS -X PATCH "$BASE/api/transactions/gmail_18c3abf0e1" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"note":"Disco Fresh"}'

# Borrar
curl -sS -X DELETE "$BASE/api/transactions/gmail_18c3abf0e1" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET"

# Deuda
curl -sS -X POST "$BASE/api/debts" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"id":"debt_visa","entity":"Visa","totalAmount":10000,"currency":"UYU","dueDate":"2026-12-05","note":"tarjeta"}'

# Suscripción, evento, categoría: mismo esquema, otra colección
curl -sS -X POST "$BASE/api/subscriptions" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"id":"sub_netflix","name":"Netflix","icon":"🎬","amount":15,"currency":"USD","billingDay":4}'
```

Respuestas de error: `{ "error": "..." }`. `401` token mal o ausente. `500` con `"API_TOKEN is not configured"` si falta la variable en el servidor. `400` body inválido. `404` no existe. `409` categoría con un nombre repetido.

## Qué hay que configurar en Vercel

La función corre en el mismo proyecto. No hace falta otro servicio. Después de mergear, Vercel publica `index.html` igual que ahora y suma `/api/*`.

Variables (Production, y Preview si el bot pega contra un preview). Settings → Environment Variables. Cuando las cargues, volvé a deployar: un deploy viejo no las ve.

| Variable | Obligatoria | Valor |
| --- | --- | --- |
| `API_TOKEN` | Sí | Un secreto largo. Generarlo con `openssl rand -base64 32`. El bot lo manda como `Authorization: Bearer ...` |
| `FIREBASE_PROJECT_ID` | Sí | `finanzas-personales-7b3ea` |
| `FIREBASE_CLIENT_EMAIL` | Sí | `client_email` del JSON de la cuenta de servicio |
| `FIREBASE_PRIVATE_KEY` | Sí | `private_key` del JSON. Puede ir con saltos de línea reales o con `\n` como viene en el archivo |

No subas el JSON ni estas variables al repo. `.gitignore` ya ignora `.env` y los nombres típicos de esa clave.

Para probar contra el emulador en tu máquina, y solo ahí: `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`. En Vercel no la definas. Con el emulador no hace falta la clave privada; el `project id` sí.

### Cuenta de servicio (Firebase Console)

La UI sigue usando la config web que ya está en `index.html`. La API usa el Admin SDK, que no pasa por las reglas de seguridad, así que necesita una cuenta de servicio.

1. Entrá a [Cuentas de servicio del proyecto](https://console.firebase.google.com/project/finanzas-personales-7b3ea/settings/serviceaccounts/adminsdk).
2. En **Firebase Admin SDK**, quedate en Node.js.
3. **Generar nueva clave privada** y confirmá. Se baja un JSON.
4. Guardá ese archivo fuera del repo (por ejemplo en un gestor de contraseñas). Si se filtra, borrala en la misma pantalla y generá otra.
5. Del JSON:
   - `project_id` → `FIREBASE_PROJECT_ID`
   - `client_email` → `FIREBASE_CLIENT_EMAIL`
   - `private_key` → `FIREBASE_PRIVATE_KEY`
6. En Vercel, al pegar la clave, dejala entre comillas o sin ellas. Si el valor trae `\n`, no hace falta convertirlos a mano: la función los pasa a saltos de línea. Un PEM pegado en varias líneas también sirve.
7. La cuenta `firebase-adminsdk-...@finanzas-personales-7b3ea.iam.gserviceaccount.com` que genera esa pantalla ya puede leer y escribir Firestore. No hace falta otro rol.
8. Redeploy del proyecto `organizador-finanzas`.

La base es la de siempre (la default). Es la misma que abre `firebase.firestore()` en la UI.

## Deployment Protection

El dominio `organizador-finanzas.vercel.app` está detrás de Vercel Authentication. Sin un bypass, un `curl` del bot recibe el login de Vercel y no llega a `/api`. Este cambio no toca esa configuración.

Opciones, de la más cerrada a la más abierta:

1. **Protection Bypass for Automation (la que hay que usar).** En el proyecto de Vercel: Settings → Deployment Protection → Protection Bypass for Automation → Create. Ponéle un nombre tipo `bot-finanzas`. Vercel muestra el secreto una vez y puede guardarlo como `VERCEL_AUTOMATION_BYPASS_SECRET`. El bot manda `x-vercel-protection-bypass: <ese secreto>` en cada request. Así la página sigue pidiendo login y el bot entra igual. El secreto abre el deployment entero (HTML y API): tratalo como una contraseña, distinto del `API_TOKEN`. No lo pongas en el navegador ni en la URL. El query `?x-vercel-protection-bypass=` también funciona, pero queda en logs; para el bot usá el header.
2. **Standard Protection.** Solo protege previews. Producción quedaría pública: cualquiera abre la UI, y la API queda cuidada nada más que por `API_TOKEN`. Tiene sentido solo si ya no te importa que la página pida el login de Vercel.
3. **Sacar Deployment Protection.** La página y la API quedan en internet. La API sigue exigiendo el bearer. La UI no tiene login propio.

No hace falta redeploy solo por crear el bypass: el header se valida en el borde. Sí hace falta redeploy cuando cambian `API_TOKEN` o las variables de Firebase.

## Reglas de Firestore

Las reglas no están en este repo y este PR no las cambia ni agrega login a la UI.

Hoy la pantalla entra sin autenticación de Firebase. Si las reglas están abiertas (`allow read, write: if true`), cualquiera que lea la config web de `index.html` puede leer y escribir la base, aunque Vercel Authentication le impida abrir el sitio. El Admin SDK de la API ignora las reglas: cerrarlas no le saca acceso al bot.

No pongas `allow read, write: if false`. La UI dejaría de cargar.

Para cerrar un poco sin romper la pantalla (hay que hacerlo a mano en Firebase Console, no está en este PR):

1. En Authentication, activá el proveedor **Anónimo**.
2. En la UI, cargá `firebase-auth-compat.js` (hoy solo están app y firestore) y, antes de los listeners, llamá `firebase.auth().signInAnonymously()`. Sigue sin haber pantalla de login.
3. Reglas de ejemplo, solo para la ruta que usa la app:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /data/main/{document=**} {
      allow read, write: if request.auth != null;
    }
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

Eso corta los scripts que pegan directo a la API REST de Firestore con la apiKey, y la UI sigue andando porque entra anónima. No es una contraseña: alguien puede pedir un usuario anónimo con la misma apiKey. Para subir un escalón, más adelante se puede sumar App Check (reCAPTCHA) en la pantalla y exigirlo en Firestore. Eso también cambia la UI, y no es este PR.

La API no se entera de ese cambio: el Admin SDK no usa esas reglas. Cuando la UI mande auth, probá la pantalla (cargar, agregar un gasto, ver que aparece) antes de dejar las reglas nuevas.

Más adelante se podría negar la escritura desde el cliente y pasar la UI por esta API. Eso sí cambia la pantalla, y no es este PR.

## Probar en local

```bash
npm install
npm test
```

Los tests usan una base en memoria con la misma interfaz que el Admin SDK (leer, escribir, transacción, filtro por fecha). No pegan a Firebase y no necesitan claves. Cubren el token, el alta idempotente, el rango de fechas y la forma de cada documento.

`index.html` no se toca para que la UI siga igual.
