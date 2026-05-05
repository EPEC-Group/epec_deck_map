from .EpecDeckMap import EpecDeckMap

# Expose _js_dist at the module level so ComponentRegistry.get_resources('_js_dist')
# finds it when it does getattr(module, '_js_dist', []).  Without this, Dash never
# emits the <script> tag for the bundle and the browser reports
# "epec_deck_map was not found".
_js_dist = EpecDeckMap._js_dist
_css_dist = EpecDeckMap._css_dist

__all__ = ['EpecDeckMap']
__version__ = '0.1.1'