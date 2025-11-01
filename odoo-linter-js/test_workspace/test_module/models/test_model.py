# This file is not imported in models/__init__.py, so the linter should flag it.

from odoo import models

class TestModel(models.Model):
    _name = 'test.model'
