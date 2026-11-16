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
        A TripsLayer spec may add ``arrowheads: {"size": px, "spacing": px,
        "color": [r, g, b, a]}`` (all optional; defaults 8, 150, the pulse
        colour): arrowheads ride each pulse head pointing in the direction of
        travel (increasing timestamp) and repeat about ``spacing`` screen
        pixels apart on long lines. Not pickable.
        A TripsLayer spec may also set ``pulseSpacing`` (timestamp units, e.g.
        km): each row then carries a pulse every ``pulseSpacing`` along it, all
        at one speed, and ``loopLength`` defaults to ``pulseSpacing`` (keep them
        equal so pulses hand over seamlessly at the cycle wrap).
        ``speedZoom`` (number) slows the clock when zoomed in past that zoom:
        it runs at 2 ** (-speedZoomStrength * max(0, zoom - speedZoom)) times
        its normal rate, so at or below ``speedZoom`` a cycle takes 4 s.
        ``speedZoomStrength`` defaults to 1, which keeps on-screen speed
        constant beyond ``speedZoom``; smaller values only damp the speed-up.
        The first trips spec that sets ``speedZoom`` drives the shared clock.
    viewState : dict
        Initial camera ``{latitude, longitude, zoom, pitch}``.  Used once on
        mount; user pan/zoom is managed internally by deck.gl.
    mapStyle : str
        Basemap tile URL (Carto GL JSON style or Mapbox URL).
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