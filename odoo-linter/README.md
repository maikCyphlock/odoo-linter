# Odoo Linter for VS Code

¡Una extensión simple pero poderosa para mejorar tu flujo de trabajo de desarrollo en Odoo!

Este linter te ayuda a detectar errores comunes y olvidos directamente en tu editor de VS Code, ahorrándote tiempo y reduciendo bugs.

## Características

El linter se ejecuta automáticamente en tus archivos Python y XML, y comprueba las siguientes reglas:

1.  **Verificación de `__init__.py`**: Si un archivo Python (como un modelo o un wizard) no está siendo importado en el `__init__.py` de su directorio, el linter mostrará una advertencia.

2.  **Verificación de `__manifest__.py`**: Si un archivo de datos (XML o CSV) no está declarado en la lista `'data'` o `'demo'` de tu `__manifest__.py`, el linter te lo notificará.

3.  **Verificación de Acceso de Modelos**: Si creas un nuevo `models.Model`, el linter comprobará si has definido sus reglas de acceso correspondientes en el archivo `security/ir.model.access.csv`.

## Instalación

Puedes instalar esta extensión fácilmente desde el archivo `.vsix` proporcionado (`odoo-linter-0.0.1.vsix`).

1.  Abre Visual Studio Code.
2.  Abre la Paleta de Comandos (`Ctrl+Shift+P` o `Cmd+Shift+P` en Mac).
3.  Escribe **"Extensions: Install from VSIX..."** y presiona Enter.
4.  Selecciona el archivo `odoo-linter-0.0.1.vsix` que te he proporcionado.
5.  ¡Listo! La extensión se instalará y activará automáticamente.

## Uso

¡No necesitas hacer nada! El linter funciona de forma automática.

Simplemente abre un proyecto de Odoo y, cuando abras o guardes un archivo, el linter lo analizará. Si encuentra algún problema, verás una línea ondulada de color amarillo debajo del código relevante. Pasa el ratón por encima para ver el mensaje de error.

---
Creado con ❤️ para desarrolladores de Odoo.
