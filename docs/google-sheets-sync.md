# Sincronización con Google Sheets (Charly)

Chanki funciona primero en local: sin endpoint, las tarjetas y valoraciones permanecen en la cola y la interfaz indica **Sincronización pendiente de configurar**. La URL desplegada y el secreto son los únicos pasos que el repositorio no puede completar.

## 1. Preparar la hoja

En la pestaña **Charly**, la fila 1 debe contener estos encabezados (el script acepta diferencias razonables de espacios y mayúsculas):

```
Puesto
der die das
Palabra
Significado
Frase
Significado frase
Sabida?
Veces no sabida
Veces mala
Veces buena
Veces fácil
ID
Actualizado
```

La fila 2 sigue reservada para el resumen; las tarjetas empiezan en la fila 3. No la elimine. `Puesto` se conserva y solo se asigna el siguiente entero al crear una fila. `ID` es la clave estable.

## 2. Instalar Apps Script

1. En Sheets, abra **Extensiones → Apps Script**.
2. Sustituya el contenido de `Code.gs` por [`google-apps-script/Code.gs`](../google-apps-script/Code.gs).
3. Abra **Configuración del proyecto → Propiedades de secuencia de comandos** y cree:
   - `SPREADSHEET_ID`: el ID de su documento, no la URL completa.
   - `SHEET_NAME`: `Charly` (opcional; este es el valor predeterminado).
   - `CHANKI_SYNC_TOKEN`: un secreto largo y aleatorio.
4. Ejecute `setupChankiSheet`, revise los permisos y autorícelos. Esta función añade columnas ausentes sin borrar datos.
5. Ejecute `backfillChankiIds` para asignar UUID y fecha a filas antiguas válidas.

## 3. Desplegar como aplicación web

1. Pulse **Implementar → Nueva implementación → Aplicación web**.
2. Ejecute como **usted** y seleccione acceso para **cualquier usuario** (la autenticación propia usa el token del cuerpo JSON).
3. Autorice acceso a la hoja y copie la URL `/exec` del despliegue.
4. Cada vez que cambie el script, use **Implementar → Administrar implementaciones → Editar → Nueva versión**; guardar el editor no actualiza una implementación existente.

## 4. Configurar Chanki

Esta aplicación no tiene build: `.env.example` documenta los nombres estándar, pero GitHub Pages no procesa `.env`. Antes de cargar `js/app.js`, inyecte configuración de despliegue (por ejemplo mediante un archivo local no versionado o el sistema de secretos del hosting):

```html
<script>
  window.CHANKI_ENV = {
    VITE_GOOGLE_SHEETS_SYNC_URL: "URL_DEL_DESPLIEGUE",
    VITE_CHANKI_SYNC_TOKEN: "SECRETO_CONFIGURADO"
  };
</script>
```

Las variables son `VITE_GOOGLE_SHEETS_SYNC_URL` y `VITE_CHANKI_SYNC_TOKEN`. No confirme el archivo que contiene valores, no muestre el token y no lo comparta. El cliente lo envía en el JSON para evitar el preflight problemático de Apps Script.

## 5. Verificar

1. Abra **Alemán · 1000 palabras** y pulse **Sincronizar ahora**.
2. Confirme el estado **Sincronizado** y la fecha.
3. Cree una tarjeta en Chanki, sincronice y compruebe la nueva fila, UUID y `Puesto` en Charly.
4. Añada una fila válida en Charly, sincronice y compruebe que aparece localmente.
5. Valore una tarjeta y verifique que solo aumenta el contador correspondiente; al llegar a diez fáciles, `Sabida?` debe ser verdadero.

## Recuperación básica

- **Pendiente de configurar:** compruebe que ambos valores de entorno están disponibles antes de cargar la app.
- **No autorizado:** vuelva a copiar exactamente el mismo token en Script Properties y Chanki, sin registrarlo en consola.
- **Error temporal:** no borre almacenamiento; la cola sobrevive a recargas y se reintentará al recuperar conexión o al pulsar sincronizar.
- **Cambios de código no visibles:** cree una nueva versión del despliegue y recargue la PWA; el service worker actualizará la caché.
- **Conflicto:** conserve ambas fuentes y compare `Actualizado`; Chanki nunca reduce contadores durante la fusión y no elimina tarjetas por filas ausentes.
