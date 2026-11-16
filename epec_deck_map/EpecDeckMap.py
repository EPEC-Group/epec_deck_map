# Hand-written Dash component class for EpecDeckMap.
# Matches the props defined in EpecDeckMap.react.js.
# Generated components from `dash cc` follow the same pattern.

from dash.development.base_component import Component, _explicitize_args


class EpecDeckMap(Component):
    """EpecDeckMap — custom deck.gl wrapper for MM Client Portal.

    Renders PathLayer / ScatterplotLayer / TextLayer directly from Python
    layer-spec dicts.  No @deck.gl/json middleman; no @@= corruption.

    Props
    -----
    id : str
        Dash component id.
    layers : list
        Layer spec dicts.  Each dict must have ``_type`` (the deck.gl class
        name), ``_accessors`` (mapping camelCase prop → snake_case data key),
        and any additional static props understood by that layer class.
    viewState : dict
        Initial camera ``{latitude, longitude, zoom, pitch}``.  Used once on
        mount; user pan/zoom is managed internally by deck.gl.
    mapStyle : str | dict
        MapLibre style: a style URL (e.g. Carto GL JSON) or a full style JSON
        dict.
    mapSources : dict
        Extra MapLibre sources added on top of the style, ``{source_id:
        source_json}`` (raster/WMS ``tiles``, vector, ``geojson``, ...).
        Re-added after every style change.
    mapLayers : list
        Extra MapLibre layer JSON dicts, drawn in order above the style's
        layers.  An optional ``beforeId`` names a basemap layer to insert
        beneath; it is ignored when the style has no such layer.
    interleaved : bool
        Render deck.gl inside MapLibre's GL context (default False).  A deck
        layer spec may then carry ``beforeId`` to draw beneath that basemap
        layer, e.g. below the labels.  Toggling it remounts the map.
    pickingRadius : int
        Picking radius in pixels (default 5).  Replaces the fat invisible
        PathLayer workaround from dash-deck.
    tooltip : dict
        ``{"style": {...}}`` — style applied to the tooltip container.  The
        ``html`` template key is ignored; each data row supplies its own
        pre-rendered HTML in its ``tooltip`` field.
    clickInfo : dict
        Output-only.  Set when user clicks a pickable feature:
        ``{"object": <data row>, "coordinate": [lon, lat], "layerId": str}``.
    """

    _prop_names = [
        'id',
        'layers',
        'viewState',
        'mapStyle',
        'mapSources',
        'mapLayers',
        'interleaved',
        'pickingRadius',
        'tooltip',
        'clickInfo',
    ]
    _type = 'EpecDeckMap'
    _namespace = 'epec_deck_map'
    _valid_wildcard_attributes = []
    available_properties = _prop_names
    available_wildcard_properties = []

    # Tell Dash where the JS bundle lives inside this package.
    _js_dist = [
        {
            'relative_package_path': 'epec_deck_map.min.js',
            'namespace': 'epec_deck_map',
        }
    ]
    _css_dist = []  # CSS is injected inline by style-loader in the JS bundle

    @_explicitize_args
    def __init__(
        self,
        id=Component.UNDEFINED,
        layers=Component.UNDEFINED,
        viewState=Component.UNDEFINED,
        mapStyle=Component.UNDEFINED,
        mapSources=Component.UNDEFINED,
        mapLayers=Component.UNDEFINED,
        interleaved=Component.UNDEFINED,
        pickingRadius=Component.UNDEFINED,
        tooltip=Component.UNDEFINED,
        clickInfo=Component.UNDEFINED,
        **kwargs
    ):
        self._prop_names = EpecDeckMap._prop_names
        self._type = EpecDeckMap._type
        self._namespace = EpecDeckMap._namespace
        self._valid_wildcard_attributes = []
        self.available_properties = EpecDeckMap._prop_names
        self.available_wildcard_properties = []

        _explicit_args = kwargs.pop('_explicit_args')
        _locals = locals()
        _locals.update(kwargs)
        args = {k: _locals[k] for k in _explicit_args if k != 'kwargs'}

        super(EpecDeckMap, self).__init__(**args)