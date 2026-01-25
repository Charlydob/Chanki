# CHANKI

Web app tipo Anki enfocada a iOS PWA. Usa Firebase Realtime Database sin autenticación y está lista para deploy a GitHub Pages.

## Requisitos

- Node.js 18+

## Arranque rápido

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Deploy a GitHub Pages

El workflow `.github/workflows/deploy.yml` compila y publica en GitHub Pages usando `actions/deploy-pages`.
Asegúrate de tener activado GitHub Pages en el repo y que el branch principal sea `main`.

## Firebase databaseURL

Si el Database URL por defecto falla, agrega el override en un archivo `.env`:

```
VITE_FIREBASE_DATABASE_URL=https://TU-PROYECTO.firebaseio.com
```

También puedes guardarlo desde Ajustes en la app (se guarda en localStorage).

## Formato de importación

**Formato A** (rápido):

```
front :: back
```

Para escribir `::` en el texto usa `\::`.

**Formato B** (recomendado):

```
FOLDER: Alemán/Verbos/Separable
TAGS: a1, separable, daily
FRONT: ...
BACK: ...
---
FRONT: ...
BACK: ...
```
