# epec_deck_map

A custom [Dash](https://dash.plotly.com/) component that wraps [deck.gl](https://deck.gl/) for the EPEC MM Client Portal. It constructs PathLayer, ScatterplotLayer, TextLayer, and other deck.gl layer classes directly from Python layer-spec dicts — no `@deck.gl/json` middleman, so the `@@=` accessor-string corruption that affects `dash-deck` is avoided entirely. Picking, tooltips, and click callbacks are all handled inside the React component and surfaced through standard Dash prop callbacks.

## Install

```bash
pip install git+https://github.com/EPEC-Group/epec_deck_map.git@v0.1.0
```

## Usage

```python
import dash
from dash import html, Input, Output
from epec_deck_map import EpecDeckMap

CARTO_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"

layers = [
    {
        "_type": "ScatterplotLayer",
        "_accessors": {"getPosition": "coordinates", "getRadius": "radius", "getFillColor": "color"},
        "pickable": True,
        "radiusUnits": "pixels",
    },
    {
        "_type": "PathLayer",
        "_accessors": {"getPath": "path", "getColor": "color", "getWidth": "width"},
        "pickable": True,
        "widthUnits": "pixels",
    },
]

view_state = {"latitude": 39.5, "longitude": -98.35, "zoom": 4, "pitch": 0}

app = dash.Dash(__name__)
app.layout = html.Div([
    EpecDeckMap(
        id="map",
        layers=layers,
        viewState=view_state,
        mapStyle=CARTO_STYLE,
        tooltip={"style": {"background": "rgba(0,0,0,0.7)", "color": "white", "padding": "4px 8px"}},
        pickingRadius=8,
    )
], style={"height": "100vh"})

@app.callback(Output("map", "layers"), Input("some-store", "data"))
def update_layers(data):
    # Attach live data rows to each layer spec; each row may include
    # a pre-rendered "tooltip" HTML string consumed by the component.
    ...

if __name__ == "__main__":
    app.run(debug=True)
```

### Prop reference

See the docstring in [epec_deck_map/EpecDeckMap.py](epec_deck_map/EpecDeckMap.py) for full semantics. Key props:

| Prop | Type | Description |
|---|---|---|
| `layers` | list | Layer-spec dicts. Each must have `_type` (deck.gl class name) and `_accessors` (camelCase prop → snake_case data key). |
| `viewState` | dict | Initial camera `{latitude, longitude, zoom, pitch}`. Managed internally after mount. |
| `mapStyle` | str | Basemap tile URL (Carto GL JSON style or Mapbox URL). |
| `pickingRadius` | int | Hit-test radius in pixels (default 5). |
| `tooltip` | dict | `{"style": {...}}` applied to the tooltip container. Each data row supplies its own HTML in its `tooltip` field. |
| `clickInfo` | dict | Output-only. Set on click: `{"object": <row>, "coordinate": [lon, lat], "layerId": str}`. |

### Spec validation

`EpecDeckMap(layers=...)` validates every spec and raises `ValueError` on an unknown `_type`, an unknown static prop, an unknown accessor in `_accessors` or a non-string accessor value, naming the layer and the closest valid name (`layer 'lines' (PathLayer): unknown prop 'widthUnit'; did you mean 'widthUnits'?`). Only spec keys are checked, never data rows. A callback that returns `layers` bypasses `__init__`, so wrap its return value:

```python
from epec_deck_map import validate_layers

return validate_layers(layers)
```

Valid names come from `epec_deck_map/layer_props.json`, generated from the installed deck.gl layer and extension classes by `npm run gen:props` (also run by `npm run build`); props of any `@deck.gl/extensions` extension are accepted on every layer. When adding a layer type, add it to `LAYERS` in `scripts/gen-layer-props.mjs` as well as `LAYER_MAP`; when the component starts reading a new spec key of its own, add it to `SPEC_KEYS` in `epec_deck_map/validation.py`. `python -m pytest tests` checks the layer types against `LAYER_MAP` and `SPEC_KEYS` against the keys `buildLayer` strips.

## Rebuilding the bundle

Node 18 or later is required.

```bash
npm install
npm run build
```

This regenerates `epec_deck_map/layer_props.json` and writes `epec_deck_map/epec_deck_map.min.js`. The compiled bundle is committed to the repository because `pip install` from a git URL does not run `npm build` — without the pre-built file in the repo, the component would have no JavaScript.
