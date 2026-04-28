# epec_deck_map

A custom [Dash](https://dash.plotly.com/) component that wraps [deck.gl](https://deck.gl/). It constructs PathLayer, ScatterplotLayer, TextLayer, and other deck.gl layer classes directly from Python layer-spec dicts — no `@deck.gl/json` middleman, so the `@@=` accessor-string corruption that affects `dash-deck` is avoided entirely. Picking, tooltips, and click callbacks are all handled inside the React component and surfaced through standard Dash prop callbacks.

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

## Rebuilding the bundle

Node 18 or later is required.

```bash
npm install
npm run build
```

This writes `epec_deck_map/epec_deck_map.min.js`. The compiled bundle is committed to the repository because `pip install` from a git URL does not run `npm build` — without the pre-built file in the repo, the component would have no JavaScript.
