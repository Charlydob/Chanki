# CHANKI

CHANKI es una web app estática tipo Anki diseñada para iOS PWA. Funciona con Firebase Realtime Database (sin Auth) y se despliega en GitHub Pages.

## Configurar databaseURL

La app intenta conectarse primero a:

```
https://anki-d6b3b-default-rtdb.firebaseio.com
```

Si no conecta, aparecerá una pantalla para pegar tu `databaseURL`. También puedes cambiarla desde **Ajustes**. Se guarda en `localStorage` con la clave `chanki_database_url`.

## Username (sin Auth)

- Al abrir la app por primera vez, introduce tu **Nombre de usuario**.
- Se guarda en `localStorage` como `chanki_username`.
- Todos los datos cuelgan de `/u/{username}`.

## Formatos de importación

**Formato A** (una tarjeta por línea):

```
front :: back
otra pregunta :: otra respuesta
```

Usa `\::` para escapar `::` dentro del texto.

**Formato B** (con carpeta y tags):

```
FOLDER: Alemán/Verbos/Separable
TAGS: a1, separable
FRONT: Ich stehe auf
BACK: Me levanto
---
FRONT: ankommen
BACK: llegar
---
```

## SRS por buckets

- **Error** → `immediate` (5 min)
- **Malo** → `lt24h` (6 horas)
- **Bueno** → `tomorrow` (24 horas)
- **Fácil** → `week` (7 días, si reps < 3) o `future` (14, 30, 60… días)

Los índices de cola se guardan con clave `dueAtPad13_cardId` y se actualizan atómicamente.

## Deploy

No hay build. GitHub Pages sirve directamente los archivos estáticos en `main`.
