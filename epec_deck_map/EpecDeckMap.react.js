import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import PropTypes from 'prop-types';
import DeckGL from '@deck.gl/react';
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { Map } from 'react-map-gl/maplibre';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

// ---------------------------------------------------------------------------
// Layer registry — add new deck.gl layer types here as needed.
// ---------------------------------------------------------------------------
const LAYER_MAP = {
    PathLayer,
    ScatterplotLayer,
    TextLayer,
};

/**
 * Convert a layer spec dict (from Python) into a real deck.gl Layer instance.
 *
 * Spec format:
 *   {
 *     _type:     "PathLayer" | "ScatterplotLayer" | "TextLayer",
 *     id:        string,
 *     data:      [...],          // list of data-row dicts
 *     _accessors: {              // camelCase prop name → snake_case data key
 *       "getPath": "path",
 *       "getFillColor": "fill_color",
 *       ...
 *     },
 *     // Everything else is a static prop passed straight through:
 *     widthScale: 4,
 *     pickable: true,
 *     getTextAnchor: "middle",   // constant string, NOT a data accessor
 *     characterSet: [...],       // no @@= corruption possible here
 *     ...
 *   }
 *
 * Workaround #1 retired: characterSet (and any other non-accessor prop) passes through
 *   the `rest` spread untouched — no post-serialisation injection needed.
 *
 * Workaround #3 retired: clickInfo.object is the exact data-row dict; keys are always
 *   whatever Python put in the data list (snake_case). No camelCase conversion happens.
 */
function buildLayer(spec) {
    const { _type, _accessors = {}, ...rest } = spec;
    const LayerClass = LAYER_MAP[_type];
    if (!LayerClass) {
        console.warn(`EpecDeckMap: unknown layer type "${_type}" — skipping`);
        return null;
    }

    // Start with all static props (data, id, widthScale, characterSet, …)
    const props = { ...rest };

    // Convert each _accessors entry into a real accessor function.
    // e.g. { "getPath": "path" } → getPath: d => d["path"]
    for (const [propName, dataKey] of Object.entries(_accessors)) {
        props[propName] = (d) => d[dataKey];
    }

    return new LayerClass(props);
}

// ---------------------------------------------------------------------------
// EpecDeckMap component
// ---------------------------------------------------------------------------
function EpecDeckMap({
    id,
    layers,
    viewState,
    mapStyle,
    pickingRadius,
    tooltip,
    setProps,
}) {
    // Layers — rebuilt only when the `layers` prop changes.
    const deckLayers = useMemo(
        () => (layers || []).map(s => buildLayer(s)).filter(Boolean),
        [layers],
    );

    // ---------------------------------------------------------------------------
    // Browser-zoom (Ctrl +/-) realignment.
    //
    // On browser zoom, devicePixelRatio changes. The maplibre basemap re-anchors
    // its projection to the new DPR; deck.gl's projection matrix stays anchored
    // to the DPR at mount time, producing a SE-shifted layer offset (same size,
    // wrong origin). Calling deck._onResize() does not fix this — the buffer
    // dimensions already match what it would recompute.
    //
    // The reliable fix is to remount <DeckGL> when DPR changes, by keying it
    // on the current DPR. Trade-off: any user pan/zoom state is reset to
    // initialViewState on Ctrl +/-. Acceptable for current scope.
    // ---------------------------------------------------------------------------
    const deckRef = useRef(null);
    const [dprKey, setDprKey] = React.useState(window.devicePixelRatio);

    useEffect(() => {
        const handleResize = () => {
            const dpr = window.devicePixelRatio;
            setDprKey(prev => (prev !== dpr ? dpr : prev));
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    // Click handler: emit clickInfo via setProps.
    // Workaround #2 retired: pickingRadius on the DeckGL instance (not an invisible fat layer)
    //   handles the picking catchment radius.
    const handleClick = useCallback(
        (info) => {
            if (!info || !info.object) return;
            setProps &&
                setProps({
                    clickInfo: {
                        object: info.object,            // exact data-row dict from Python
                        coordinate: info.coordinate,    // [lon, lat]
                        layerId: info.layer ? info.layer.id : null,
                    },
                });
        },
        [setProps],
    );

    // Resolve tooltip style from the Python prop (html template is ignored;
    // each data row already carries pre-rendered HTML in its `tooltip` field).
    const tooltipStyle = tooltip && tooltip.style ? tooltip.style : {};
    const getTooltip = useCallback(
        ({ object }) => {
            if (!object || !object.tooltip) return null;
            return { html: object.tooltip, style: tooltipStyle };
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [tooltip],
    );

    const initialViewState = viewState || {
        latitude: -25.5,
        longitude: 134.5,
        zoom: 4,
        pitch: 0,
    };

    return (
        <div
            id={id}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
        >
            <DeckGL
                key={dprKey} // see DPR realignment workaround above
                ref={deckRef}
                initialViewState={initialViewState}
                controller={true}
                layers={deckLayers}
                pickingRadius={pickingRadius != null ? pickingRadius : 5}
                onClick={handleClick}
                getTooltip={getTooltip}
            >
                {/* maplibre-gl basemap — no Mapbox token required for Carto tiles */}
                <Map mapStyle={mapStyle} mapLib={maplibregl} />
            </DeckGL>
        </div>
    );
}

EpecDeckMap.propTypes = {
    /** Dash component id */
    id: PropTypes.string,
    /** List of layer spec dicts (see buildLayer above for format) */
    layers: PropTypes.array,
    /** Initial camera position {latitude, longitude, zoom, pitch} */
    viewState: PropTypes.object,
    /** Basemap tile URL (Carto, Mapbox, etc.) */
    mapStyle: PropTypes.string,
    /** Picking radius in pixels — replaces the fat invisible PathLayer workaround */
    pickingRadius: PropTypes.number,
    /**
     * Tooltip config. Only `style` is used; `html` is ignored because each
     * data row carries its own pre-rendered HTML in its `tooltip` field.
     */
    tooltip: PropTypes.object,
    /**
     * Output-only prop. Set by the component when the user clicks a pickable
     * feature: { object: <data row dict>, coordinate: [lon, lat], layerId: string }
     */
    clickInfo: PropTypes.object,
    /** Injected by Dash to propagate prop updates back to Python */
    setProps: PropTypes.func,
};

EpecDeckMap.defaultProps = {
    layers: [],
    pickingRadius: 5,
};

export { EpecDeckMap };
export default EpecDeckMap;
