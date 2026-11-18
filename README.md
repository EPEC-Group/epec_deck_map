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

### Updating one layer

```python
from dash import Patch

@app.callback(Output("map", "layers"), Input("interval-slider", "value"))
def recolour_lines(t):
    p = Patch()
    p[0]["data"] = line_rows_at(t)
    return p
```

### Prop reference

See the docstring in [epec_deck_map/EpecDeckMap.py](epec_deck_map/EpecDeckMap.py) for full semantics. Key props:

| Prop | Type | Description |
|---|---|---|
| `layers` | list | Layer-spec dicts. Each must have `_type` (deck.gl class name) and `_accessors` (camelCase prop → snake_case data key). Optional `minZoom` / `maxZoom` limit a layer to a zoom range. |
| `viewState` | dict | Initial camera `{latitude, longitude, zoom, pitch}`. Managed internally after mount. |
| `mapStyle` | str or dict | MapLibre style URL or full style JSON dict. |
| `mapSources` | dict | Extra MapLibre sources `{id: source_json}`. |
| `mapLayers` | list | Extra MapLibre layer dicts; optional `beforeId`. |
| `interleaved` | bool | Render deck.gl inside MapLibre, so a layer spec's `beforeId` works (default False). |
| `pickingRadius` | int | Hit-test radius in pixels (default 5). |
| `tooltip` | dict | `{"style": {...}}` applied to the tooltip container. Each data row supplies its own HTML in its `tooltip` field. |
| `clickInfo` | dict | Output-only. Set on click: `{"object": <row>, "coordinate": [lon, lat], "layerId": str}`. |
| `timeFilter` | dict | `{"domain": [t0, t1], "step", "window", "current", "playing", "speed", "loop"}`. Shows rows with `current - window < t <= current` on layers with a `getFilterValue` accessor. |
| `filterTime` | float | Output-only. Playback position while playing. |

### Time filter and playback

```python
layer = {"_type": "ScatterplotLayer", "data": rows,
         "_accessors": {"getPosition": "pos", "getFillColor": "color", "getFilterValue": "t"}}
EpecDeckMap(id="map", layers=[layer],
            timeFilter={"domain": [t0, t1], "step": 300, "current": t0, "speed": 1200})

@app.callback(Output("slider", "value"), Input("map", "filterTime"), prevent_initial_call=True)
def follow(t):
    return t

@app.callback(Output("map", "timeFilter"), Input("slider", "value"), prevent_initial_call=True)
def scrub(t):
    p = Patch()
    p["current"] = t
    return p

@app.callback(Output("map", "timeFilter", allow_duplicate=True), Input("play", "n_clicks"),
              State("map", "timeFilter"), prevent_initial_call=True)
def toggle(_, tf):
    p = Patch()
    p["playing"] = not tf.get("playing")
    return p
```

### Flow chevrons

PathLayer: chevrons every `interval` px, pointing along the vertex order where `getDirection` is 1 and against it where -1; other rows get none.

```python
{"_accessors": {"getPath": "path", "getDirection": "dir"},
 "chevrons": {"interval": 80, "size": 6, "color": [255, 255, 255, 255],
              "clearance": 8, "maxTurn": 35}}  # px; skip within clearance of bends sharper than maxTurn degrees
```

### Constant-speed pulses

TripsLayer only. Timestamps in km along the line.

```python
{"pulseSpacing": 150, "speedZoom": 6, "speedZoomStrength": 0.5}
```

## Rebuilding the bundle

Node 18 or later is required.

```bash
npm install
npm run build
```

This writes `epec_deck_map/epec_deck_map.min.js`. The compiled bundle is committed to the repository because `pip install` from a git URL does not run `npm build` — without the pre-built file in the repo, the component would have no JavaScript.
