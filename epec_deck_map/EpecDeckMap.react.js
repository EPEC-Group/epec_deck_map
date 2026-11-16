import React, { useCallback, useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import DeckGL from '@deck.gl/react';
import { IconLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';
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

const DEFAULT_ARROW_SIZE = 8;
const DEFAULT_ARROW_SPACING = 150;
const MAX_ARROWS_PER_ROW = 64;
const DEFAULT_TRIPS_COLOR = [0, 0, 0, 255];
const ARROW_ICON_PX = 64;
const ARROW_MAPPING = {
    // Anchored at the tip so the arrow ends exactly on the pulse head.
    arrow: { x: 0, y: 0, width: ARROW_ICON_PX, height: ARROW_ICON_PX, anchorX: 60, anchorY: 32, mask: true },
};
let arrowAtlas = null;

/** Lazily drawn white arrowhead pointing east, tinted per arrow via mask. */
function getArrowAtlas() {
    if (!arrowAtlas) {
        const canvas = document.createElement('canvas');
        canvas.width = ARROW_ICON_PX;
        canvas.height = ARROW_ICON_PX;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.moveTo(6, 8);
        ctx.lineTo(60, 32);
        ctx.lineTo(6, 56);
        ctx.lineTo(20, 32);
        ctx.closePath();
        ctx.fill();
        // The canvas itself, not a data: URL, which deck.gl would fetch and a strict CSP connect-src blocks.
        arrowAtlas = canvas;
    }
    return arrowAtlas;
}

/** [lng, lat] to Web Mercator world units at zoom 0 (512 wide, y north). */
function toWorld([lng, lat]) {
    const phi = lat * Math.PI / 180;
    return [512 * (lng + 180) / 360, 512 * (0.5 + Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI))];
}

/** Inverse of toWorld. */
function fromWorld(x, y) {
    const lat = 2 * Math.atan(Math.exp((y / 512 - 0.5) * 2 * Math.PI)) - Math.PI / 2;
    return [x / 512 * 360 - 180, lat * 180 / Math.PI];
}

/**
 * Per-row arrowhead geometry for a trips spec with an `arrowheads` key, or null.
 *
 * Each row gets a timestamp step that puts consecutive arrows about `spacing`
 * screen pixels apart at this zoom, snapped so loopLength is a whole number of
 * steps (the arrows then cycle seamlessly with the pulse). Rows shorter on
 * screen than two arrows get none.
 */
function arrowTracks(spec, zoom, loopLength) {
    const { arrowheads, _accessors = {}, data, id } = spec;
    if (!arrowheads) return null;
    const size = arrowheads.size || DEFAULT_ARROW_SIZE;
    const spacing = Math.max(arrowheads.spacing || DEFAULT_ARROW_SPACING, size);
    const scale = 2 ** zoom;
    const { getPath, getTimestamps, getColor } = _accessors;
    const tracks = [];
    for (const row of (data || [])) {
        const path = row[getPath];
        const ts = row[getTimestamps];
        if (!path || !ts || path.length < 2 || ts.length !== path.length) continue;
        const xy = path.map(toWorld);
        let length = 0;
        for (let i = 1; i < xy.length; i++) {
            length += Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
        }
        length *= scale;
        const span = Math.abs(ts[ts.length - 1] - ts[0]);
        if (length < 2 * size || !(span > 0)) continue;
        const n = Math.min(MAX_ARROWS_PER_ROW, Math.max(1, Math.round(loopLength * length / (span * spacing))));
        const color = arrowheads.color || (getColor ? row[getColor] : spec.getColor) || DEFAULT_TRIPS_COLOR;
        tracks.push({ xy, ts, step: loopLength / n, color });
    }
    return { id: `${id}-arrowheads`, size, tracks };
}

/** Arrowheads at every timestamp congruent to currentTime modulo each row's step. */
function arrowheadLayer({ id, size, tracks }, currentTime) {
    const arrows = [];
    for (const { xy, ts, step, color } of tracks) {
        const last = ts.length - 1;
        const rising = ts[last] >= ts[0];
        const lo = rising ? ts[0] : ts[last];
        const hi = rising ? ts[last] : ts[0];
        for (let t = lo + (((currentTime - lo) % step) + step) % step; t <= hi; t += step) {
            let a = 0;
            let b = last;
            while (b - a > 1) {
                const m = (a + b) >> 1;
                if ((ts[m] <= t) === rising) a = m; else b = m;
            }
            const f = ts[b] === ts[a] ? 0 : (t - ts[a]) / (ts[b] - ts[a]);
            const dx = xy[b][0] - xy[a][0];
            const dy = xy[b][1] - xy[a][1];
            const dir = rising ? 1 : -1;
            arrows.push({
                position: fromWorld(xy[a][0] + f * dx, xy[a][1] + f * dy),
                angle: Math.atan2(dir * dy, dir * dx) * 180 / Math.PI,
                color,
            });
        }
    }
    return new IconLayer({
        id,
        data: arrows,
        iconAtlas: getArrowAtlas(),
        iconMapping: ARROW_MAPPING,
        getIcon: () => 'arrow',
        getPosition: d => d.position,
        getAngle: d => d.angle,
        getColor: d => d.color,
        getSize: size,
        sizeUnits: 'pixels',
        billboard: false,
        pickable: false,
    });
}

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
function buildLayer(spec, currentTime) {
    // `loopLength` and `arrowheads` are read by the parent component (rAF loop,
    // arrowhead layer); strip them so they are never passed as deck.gl props.
    const { _type, _accessors = {}, loopLength, arrowheads, ...rest } = spec;
    const LayerClass = LAYER_MAP[_type];
    if (!LayerClass) {
        console.warn(`EpecDeckMap: unknown layer type "${_type}" — skipping`);
        return null;
    }

    // Start with all static props (data, id, widthScale, characterSet, …)
    const props = { ...rest };

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
        () => otherSpecs.map(s => buildLayer(s)).filter(Boolean),
        [otherSpecs],
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

    // Zoom in half-level steps; arrowhead spacing is recomputed only when it changes.
    const [zoomKey, setZoomKey] = useState(() => Math.round(((viewState && viewState.zoom) || 4) * 2) / 2);
    const onViewStateChange = useCallback(
        ({ viewState: vs }) => setZoomKey(Math.round(vs.zoom * 2) / 2),
        [],
    );
    const arrowSets = useMemo(
        () => tripsSpecs.map(s => arrowTracks(s, zoomKey, loopLength)).filter(Boolean),
        [tripsSpecs, zoomKey, loopLength],
    );

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
        () => [
            ...tripsSpecs.map(s => buildLayer(s, currentTime)).filter(Boolean),
            ...arrowSets.map(a => arrowheadLayer(a, currentTime)),
        ],
        [tripsSpecs, arrowSets, currentTime],
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
                initialViewState={initialViewState}
                controller={true}
                layers={deckLayers}
                pickingRadius={pickingRadius != null ? pickingRadius : 5}
                onClick={handleClick}
                onViewStateChange={onViewStateChange}
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
