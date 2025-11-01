# Changelog

## [0.0.3] - 2025-10-31

### Fixed
- Mejoradas las validaciones de vistas para distinguir entre vistas nuevas y heredadas
- Las vistas heredadas (con `inherit_id`) ya no requieren el campo `model`
- Validaciones de seguridad más inteligentes (solo para directorios relevantes)
- Reducidos falsos positivos en validaciones de menuitems

### Added
- **Validaciones XML mejoradas**:
  - Verificación de estructura básica de XML (declaración XML, encoding UTF-8)
  - Validación de elementos raíz `<odoo>` o `<openerp>`
  - Detección de IDs duplicados en el mismo archivo
  - Validación de referencias a modelos (deben seguir la convención `modulo.modelo`)

- **Validaciones de Vistas (ir.ui.view)**:
  - Verificación de atributos requeridos (id, name, model, arch)
  - Validación de estructura de registros de vista
  - Comprobación de campos obligatorios en vistas

- **Validaciones de Menús (menuitem)**:
  - Verificación de atributos requeridos (id, name)
  - Validación de que tenga al menos action o parent
  - Comprobación de referencias a acciones existentes

- **Validaciones de Acciones (ir.actions.act_window)**:
  - Verificación de campos requeridos (name, res_model, view_mode)
  - Validación de referencias a modelos

- **Validaciones de Seguridad**:
  - Detección de módulos con modelos pero sin directorio `security/`
  - Verificación de existencia de `ir.model.access.csv` cuando hay modelos
  - Validación de reglas de acceso para modelos

- **Mejoras en el Linter**:
  - Análisis en tiempo real al cambiar de pestaña
  - Mejores mensajes de error con rangos específicos
  - Soporte para validación tanto en archivos Python como XML

## [0.0.2] - 2025-10-31

### Added
- Versión inicial del linter con validaciones básicas para:
  - Estructura de módulos Odoo
  - Validación de modelos Python
  - Verificación de importaciones en `__init__.py`
  - Validación de archivos en manifest

---

*Nota: Este archivo se genera automáticamente. No edites manualmente.*
