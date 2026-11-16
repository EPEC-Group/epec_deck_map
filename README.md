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

### Binary layer data

For large layers, `binary_data` packs columns into base64 typed arrays that the component decodes straight into deck.gl's binary attributes, skipping per-row JSON. Name each column by its deck.gl accessor; no `_accessors` entry is needed for it. `_objects` (optional) supplies the row dicts used for tooltips and `clickInfo`, indexed like the objects.

```python
from epec_deck_map import binary_data

lines = {
    "_type": "PathLayer",
    "id": "lines",
    "data": binary_data({
        "getPath": [line.coords for line in lines_in],      # [[lon, lat], ...] per line
        "getColor": [line.rgba for line in lines_in],       # [r, g, b, a] per line
        "getWidth": [line.width for line in lines_in],
    }),
    "_objects": [{"name": line.name, "tooltip": line.html} for line in lines_in],
    "pickable": True,
    "widthUnits": "pixels",
}
```

- Values are numbers or fixed-length lists (plain Python; call `.tolist()` on numpy arrays).
- `getPath` holds one position per vertex; other path columns hold one value per path, or one per vertex if named in `per_vertex=` (for example TripsLayer `getTimestamps`).
- `*Color` columns default to normalised `uint8`, everything else to `float32` (about 1.5 m of longitude). Pass `dtypes={"getPath": "float64"}` for full precision.
- Binary data that fails validation (unknown dtype, length mismatch, bad `startIndices`) skips the layer and logs a console error.

### Prop reference

See the docstring in [epec_deck_map/EpecDeckMap.py](epec_deck_map/EpecDeckMap.py) for full semantics. Key props:

| Prop | Type | Description |
|---|---|---|
| `layers` | list | Layer-spec dicts. Each must have `_type` (deck.gl class name) and `_accessors` (camelCase prop → snake_case data key). `data` may be binary (see above). |
| `viewState` | dict | Initial camera `{latitude, longitude, zoom, pitch}`. Managed internally after mount. |
| `mapStyle` | str | Basemap tile URL (Carto GL JSON style or Mapbox URL). |
| `pickingRadius` | int | Hit-test radius in pixels (default 5). |
| `tooltip` | dict | `{"style": {...}}` applied to the tooltip container. Each data row supplies its own HTML in its `tooltip` field. |
| `clickInfo` | dict | Output-only. Set on click: `{"object": <row>, "index": int, "coordinate": [lon, lat], "layerId": str}`. On a binary layer `object` is `_objects[index]`, or `None` without `_objects`. |

## Rebuilding the bundle

Node 18 or later is required.

```bash
npm install
npm run build
```

This writes `epec_deck_map/epec_deck_map.min.js`. The compiled bundle is committed to the repository because `pip install` from a git URL does not run `npm build` — without the pre-built file in the repo, the component would have no JavaScript.
