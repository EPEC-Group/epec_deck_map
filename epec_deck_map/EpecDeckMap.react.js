import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import DeckGL from '@deck.gl/react';
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { Map, useControl, useMap } from 'react-map-gl/maplibre';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

// ---------------------------------------------------------------------------
// Layer registry — add new deck.gl layer types here as needed.
// ---------------------------------------------------------------------------
const LAYER_MAP = {
    PathLayer,
    ScatterplotLayer,
    TextLayer,
    TripsLayer,
};

// ---------------------------------------------------------------------------
// Trips animation constants.
//   - currentTime sweeps 0..loopLength once every CYCLE_DURATION_MS (wall time),
//     so the visual pace stays constant regardless of loopLength magnitude.
//   - loopLength / trailLength come from the layer spec (Python-tunable); the
//     defaults below match normalised 0..1 timestamps.
// ---------------------------------------------------------------------------
const FRAME_INTERVAL_MS = 1000 / 30;   // throttle the rAF loop to ~30fps
const CYCLE_DURATION_MS = 4000;        // one full 0..loopLength cycle every 4s
const DEFAULT_LOOP_LENGTH = 1.0;
const DEFAULT_TRAIL_LENGTH = 0.3;

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
 *     minZoom: 7,
 *     maxZoom: 10,
 *     ...
 *   }
 *
 * Workaround #1 retired: characterSet (and any other non-accessor prop) passes through
 *   the `rest` spread untouched — no post-serialisation injection needed.
 *
 * Workaround #3 retired: clickInfo.object is the exact data-row dict; keys are always
 *   whatever Python put in the data list (snake_case). No camelCase conversion happens.
 */
function inZoomRange(spec, zoom) {
    return (spec.minZoom == null || zoom >= spec.minZoom)
        && (spec.maxZoom == null || zoom < spec.maxZoom);
}

function zoomGateKey(specs, zoom) {
    let key = '';
    for (const s of (specs || [])) {
        if (s && (s.minZoom != null || s.maxZoom != null)) {
            key += inZoomRange(s, zoom) ? '1' : '0';
        }
    }
    return key;
}

function buildLayer(spec, zoom, currentTime) {
    const { _type, _accessors = {}, loopLength, minZoom, maxZoom, ...rest } = spec;
    const LayerClass = LAYER_MAP[_type];
    if (!LayerClass) {
        console.warn(`EpecDeckMap: unknown layer type "${_type}" — skipping`);
        return null;
    }

    // Start with all static props (data, id, widthScale, characterSet, …)
    const props = { ...rest };
    props.visible = rest.visible !== false && inZoomRange(spec, zoom);

    // TripsLayer is the only animated layer: inject the per-frame currentTime and
    // fall back to a sane trailLength if Python did not supply one.
    if (_type === 'TripsLayer') {
        props.currentTime = currentTime;
        if (props.trailLength == null) {
            props.trailLength = DEFAULT_TRAIL_LENGTH;
        }
    }

    // Convert each _accessors entry into a real accessor function.
    // e.g. { "getPath": "path" } → getPath: d => d["path"]
    const updateTriggers = { ...rest.updateTriggers };
    for (const [propName, dataKey] of Object.entries(_accessors)) {
        props[propName] = (d) => d[dataKey];
        updateTriggers[propName] = dataKey;
    }
    props.updateTriggers = updateTriggers;

    return new LayerClass(props);
}

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

function BasemapOverlays({ sources, layers }) {
    const { current } = useMap();
    useEffect(() => {
        const map = current && current.getMap();
        if (!map) return undefined;
        const addedSources = new Set();
        const addedLayers = new Set();
        const failed = new Set();
        const add = (key, exists, fn) => {
            if (failed.has(key) || exists()) return false;
            try {
                fn();
            } catch (err) {
                console.warn(`EpecDeckMap: ${key}: ${err.message}`);
            }
            if (exists()) return true;
            failed.add(key);
            return false;
        };
        const apply = () => {
            // style.loaded() also waits on tiles.
            if (!map.style || !map.style._loaded) return;
            for (const [sid, spec] of Object.entries(sources)) {
                if (add(`source ${sid}`, () => map.getSource(sid), () => map.addSource(sid, spec))) {
                    addedSources.add(sid);
                }
            }
            for (const { beforeId, ...layer } of layers) {
                const before = beforeId && map.getLayer(beforeId) ? beforeId : undefined;
                if (add(`layer ${layer.id}`, () => map.getLayer(layer.id), () => map.addLayer(layer, before))) {
                    addedLayers.add(layer.id);
                }
            }
        };
        apply();
        map.on('styledata', apply);
        return () => {
            map.off('styledata', apply);
            if (!map.style) return;
            for (const lid of addedLayers) if (map.getLayer(lid)) map.removeLayer(lid);
            for (const sid of addedSources) if (map.getSource(sid)) map.removeSource(sid);
        };
    }, [current, sources, layers]);
    return null;
}

function DeckOverlay(props) {
    const overlay = useControl(() => new MapboxOverlay(props));
    overlay.setProps(props);
    return null;
}

// ---------------------------------------------------------------------------
// EpecDeckMap component
// ---------------------------------------------------------------------------
function EpecDeckMap({
    id,
    layers,
    viewState,
    mapStyle,
    mapSources,
    mapLayers,
    interleaved,
    pickingRadius,
    tooltip,
    setProps,
}) {
    const initialViewState = viewState || {
        latitude: -25.5,
        longitude: 134.5,
        zoom: 4,
        pitch: 0,
    };

    const zoomRef = useRef(initialViewState.zoom);
    const viewKeyRef = useRef(null);
    const viewKey = JSON.stringify(initialViewState);
    if (viewKeyRef.current !== viewKey) {
        viewKeyRef.current = viewKey;
        zoomRef.current = initialViewState.zoom;
    }
    const gateKey = zoomGateKey(layers, zoomRef.current);
    const layersRef = useRef(layers);
    const gateKeyRef = useRef(gateKey);
    layersRef.current = layers;
    gateKeyRef.current = gateKey;
    const [, forceRender] = useReducer(n => n + 1, 0);

    const handleViewStateChange = useCallback(({ viewState: vs }) => {
        zoomRef.current = vs.zoom;
        if (zoomGateKey(layersRef.current, vs.zoom) !== gateKeyRef.current) {
            forceRender();
        }
    }, []);

    // Split specs into animated (TripsLayer) and everything else. Non-trips
    // layers are memoised and never rebuilt per frame; only the trips layers
    // are rebuilt each frame with an updated currentTime.
    const { tripsSpecs, otherSpecs } = useMemo(() => {
        const trips = [];
        const others = [];
        for (const s of (layers || [])) {
            if (s && s._type === 'TripsLayer') {
                trips.push(s);
            } else {
                others.push(s);
            }
        }
        return { tripsSpecs: trips, otherSpecs: others };
    }, [layers]);

    // Static layers — rebuilt only when their specs change (NOT each frame).
    const otherLayers = useMemo(
        () => otherSpecs.map(s => buildLayer(s, zoomRef.current)).filter(Boolean),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [otherSpecs, gateKey],
    );

    // A single shared cycle length for all pulses: the max loopLength across
    // trips specs (falling back to the default). currentTime sweeps 0..loopLength.
    const loopLength = useMemo(() => {
        let maxLen = 0;
        for (const s of tripsSpecs) {
            const v = Number(s.loopLength);
            if (Number.isFinite(v) && v > maxLen) maxLen = v;
        }
        return maxLen > 0 ? maxLen : DEFAULT_LOOP_LENGTH;
    }, [tripsSpecs]);

    // Advanced by the rAF loop below; only meaningful when trips layers exist.
    const [currentTime, setCurrentTime] = useState(0);

    // Animation loop — runs only while there is at least one TripsLayer spec and
    // the tab is visible. Throttled to ~30fps; pauses on visibilitychange.
    useEffect(() => {
        if (tripsSpecs.length === 0) {
            return undefined;  // no trips layers → no loop at all
        }

        let rafId = null;
        let startTs = null;
        let lastFrameTs = 0;

        const tick = (ts) => {
            rafId = requestAnimationFrame(tick);
            if (ts - lastFrameTs < FRAME_INTERVAL_MS) return;  // throttle
            lastFrameTs = ts;
            if (startTs == null) startTs = ts;
            const phase = ((ts - startTs) % CYCLE_DURATION_MS) / CYCLE_DURATION_MS;
            setCurrentTime(phase * loopLength);
        };

        const start = () => {
            if (rafId == null) {
                startTs = null;
                lastFrameTs = 0;
                rafId = requestAnimationFrame(tick);
            }
        };
        const stop = () => {
            if (rafId != null) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
        };

        const onVisibility = () => {
            if (document.hidden) stop();
            else start();
        };

        document.addEventListener('visibilitychange', onVisibility);
        if (!document.hidden) start();

        return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            stop();
        };
    }, [tripsSpecs, loopLength]);

    // Trips layers rebuilt each frame with the current time; drawn on top of the
    // static layers. deck.gl diffs efficiently, so only these update per frame.
    const tripsLayers = useMemo(
        () => tripsSpecs.map(s => buildLayer(s, zoomRef.current, currentTime)).filter(Boolean),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [tripsSpecs, currentTime, gateKey],
    );

    const deckLayers = useMemo(
        () => [...otherLayers, ...tripsLayers],
        [otherLayers, tripsLayers],
    );

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

    const overlaySources = useMemo(
        () => (isPlainObject(mapSources)
            ? Object.fromEntries(Object.entries(mapSources).filter(([, s]) => isPlainObject(s)))
            : {}),
        [mapSources],
    );
    const overlayLayers = useMemo(
        () => (Array.isArray(mapLayers)
            ? mapLayers.filter(l => isPlainObject(l) && typeof l.id === 'string')
            : []),
        [mapLayers],
    );
    const style = isPlainObject(mapStyle) || typeof mapStyle === 'string' ? mapStyle : undefined;
    const overlays = <BasemapOverlays sources={overlaySources} layers={overlayLayers} />;
    const radius = pickingRadius != null ? pickingRadius : 5;

    return (
        <div
            id={id}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
        >
            {interleaved ? (
                <Map
                    initialViewState={initialViewState}
                    mapStyle={style}
                    mapLib={maplibregl}
                    style={{ width: '100%', height: '100%' }}
                    onMove={handleViewStateChange}
                >
                    {overlays}
                    <DeckOverlay
                        interleaved
                        layers={deckLayers}
                        pickingRadius={radius}
                        onClick={handleClick}
                        getTooltip={getTooltip}
                    />
                </Map>
            ) : (
                <DeckGL
                    initialViewState={initialViewState}
                    controller={true}
                    onViewStateChange={handleViewStateChange}
                    layers={deckLayers}
                    pickingRadius={radius}
                    onClick={handleClick}
                    getTooltip={getTooltip}
                >
                    {/* maplibre-gl basemap — no Mapbox token required for Carto tiles */}
                    <Map mapStyle={style} mapLib={maplibregl}>{overlays}</Map>
                </DeckGL>
            )}
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
    /** MapLibre style: a style URL or a full style JSON object */
    mapStyle: PropTypes.oneOfType([PropTypes.string, PropTypes.object]),
    /** Extra MapLibre sources: {sourceId: source JSON} */
    mapSources: PropTypes.object,
    /** Extra MapLibre layer dicts; optional `beforeId` */
    mapLayers: PropTypes.array,
    /** Render deck.gl inside MapLibre, so a layer spec's `beforeId` works */
    interleaved: PropTypes.bool,
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
