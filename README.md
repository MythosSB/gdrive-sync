# GDrive Sync

Plugin de Obsidian para sincronizar una bóveda con Google Drive. Funciona en escritorio y en Android.

## Características

- Sincronización en ambos sentidos: subir, descargar y borrar (a la papelera).
- Conflictos sin pérdidas: si editas lo mismo en dos dispositivos, se conservan ambas versiones.
- Sincronización automática: al abrir, al volver a la app, periódica y poco después de editar.
- Aviso al cerrar con cambios sin sincronizar (escritorio).
- Permiso mínimo de Google (`drive.file`): el plugin solo ve los archivos que él mismo crea.
- Sin servidores intermedios: usas tu propio proyecto de Google Cloud.

## Cómo funciona

La bóveda se guarda en una carpeta de tu Drive con la misma estructura. En cada sincronización el plugin compara el contenido (hash MD5) de cada archivo con el de la última sincronización y decide si hay que subirlo, bajarlo o resolver un conflicto. Los borrados van a la papelera (la de Drive y la de Obsidian), nunca son definitivos. Si el plan incluye muchos borrados, la sincronización se detiene y pide confirmación.

## Requisitos

- Una cuenta de Google.
- Un proyecto propio en Google Cloud (gratuito, no requiere facturación).
- Obsidian 1.6.6 o superior.

## Configuración de Google Cloud

1. En console.cloud.google.com crea un proyecto y habilita **Google Drive API**.
2. En **Google Auth Platform** configura la pantalla de consentimiento (tipo **Externo**) y añade el permiso `drive.file` en **Acceso a los datos**.
3. En **Público**, añade tu cuenta como **usuario de prueba**.
4. En **Clientes**, crea un cliente de tipo **TVs y dispositivos de entrada limitada**. Guarda el ID de cliente y el secreto.

## Instalación

Con [BRAT](https://github.com/TfTHacker/obsidian42-brat): añade el repositorio `USUARIO/gdrive-sync` como plugin beta.

O manualmente: copia `main.js`, `manifest.json` y `styles.css` de la última release a `.obsidian/plugins/gdrive-sync/` dentro de tu bóveda.

## Uso

1. Activa el plugin y, en sus ajustes, pega el ID y el secreto del cliente.
2. Pulsa **Connect** e inicia sesión con el código que se muestra.
3. En cada dispositivo, usa el mismo **Drive folder name** para la misma bóveda.
4. Activa **Detectar todas las extensiones de archivo** en Obsidian (Ajustes, Archivos y enlaces) si quieres sincronizar archivos como `.txt`.
5. Comandos: **Sync now** y **Sync: preview changes (dry run)**, que muestra lo que haría sin tocar nada.

## Seguridad y privacidad

- Los datos van directamente entre tu dispositivo y Google. No hay servidor intermedio.
- `data.json` guarda en texto plano tu secreto de cliente y tu token de acceso, como hacen los plugins de Obsidian. No lo compartas ni lo subas a ningún repositorio.
- Si pierdes un dispositivo, revoca el acceso en tu cuenta de Google (Seguridad, apps de terceros con acceso a la cuenta).
- Los archivos no se cifran en Drive.

## Limitaciones

- Con la app de Google Cloud en modo "Prueba", el token puede caducar cada 7 días y habrá que pulsar **Reconnect**.
- Solo se sincronizan los archivos que Obsidian detecta; las carpetas y archivos ocultos (que empiezan con `.`), incluida `.obsidian`, se omiten.
- Los archivos mayores que el límite configurado (50 MB por defecto) se omiten.
- Android suspende la app en segundo plano: la sincronización ocurre al abrir, al volver a la app y mientras está abierta.
- Android no admite algunos caracteres en nombres de archivo (`: * ? " < > |`); esos archivos darán error en el móvil.
- No uses otro método de sincronización sobre la misma bóveda a la vez.

## Desarrollo

    npm install
    npm run dev      # compila al guardar
    npm run build    # comprobación de tipos y versión de producción

## Licencia

MIT