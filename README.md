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

### Pulse arrowheads

A `TripsLayer` spec may add `"arrowheads": {"size": 8, "spacing": 150, "color": [r, g, b, a]}` (every key optional). Arrowheads ride each pulse head pointing in the direction of travel (increasing timestamp, so a reversed timestamp array flips them with the pulse) and repeat about `spacing` screen pixels apart along long lines, moving with the pulse. Colour defaults to the pulse colour. Lines shorter on screen than two arrows, or than `"minLength"` pixels if set, get none, so short lines only gain arrows once zoomed in far enough. Arrows are not pickable.

### Constant-speed pulses

With timestamps in distance along the line (e.g. km), set `"pulseSpacing": 150` on a `TripsLayer` spec: every row carries a pulse every 150 km, all moving at one speed (150 km per 4 s cycle), and arrowheads ride every pulse. A row shorter than `pulseSpacing` gets a tighter gap (the largest whole fraction of `pulseSpacing` no longer than the row, floored at half `trailLength`), so it always carries a pulse head. `loopLength` defaults to `pulseSpacing`; leave it unset or equal so pulses hand over seamlessly at the cycle wrap. `trailLength` is in the same units.

Add `"speedZoom": 6` to slow pulses down when zoomed in past zoom 6: the clock runs at `2 ** (-speedZoomStrength * max(0, zoom - speedZoom))` times its normal rate, so a cycle takes 4 s at or below zoom 6. `"speedZoomStrength"` defaults to 1, which keeps on-screen speed constant beyond `speedZoom` (twice as long per level); a value between 0 and 1 only damps the speed-up. The first trips spec that sets `speedZoom` drives the shared clock.

## Rebuilding the bundle

Node 18 or later is required.

```bash
npm install
npm run build
```

This writes `epec_deck_map/epec_deck_map.min.js`. The compiled bundle is committed to the repository because `pip install` from a git URL does not run `npm build` — without the pre-built file in the repo, the component would have no JavaScript.
