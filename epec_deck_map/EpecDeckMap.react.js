import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import DeckGL from '@deck.gl/react';
import { DataFilterExtension } from '@deck.gl/extensions';
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
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

// Time filter: one shared extension instance so layer diffs never see a new one.
const FILTER_EXTENSIONS = [new DataFilterExtension({ filterSize: 1 })];
const REPORT_INTERVAL_MS = 250;   // filterTime reaches Dash at most 4 times a second
const ECHO_MS = 5000;             // a `current` equal to a value reported this recently is an echo

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
function buildLayer(spec, currentTime, filter) {
    // `loopLength` is an animation control read by the parent component (see the
    // rAF loop below); strip it so it is never passed as an unknown deck.gl prop.
    const { _type, _accessors = {}, loopLength, ...rest } = spec;
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

    // GPU time filter. Values are uploaded relative to the domain start because
    // the filter attribute is float32; only filterRange changes per step.
    if (_accessors.getFilterValue) {
        const key = _accessors.getFilterValue;
        const t0 = filter ? filter.t0 : 0;
        props.getFilterValue = (d) => d[key] - t0;
        props.extensions = FILTER_EXTENSIONS;
        props.filterEnabled = Boolean(filter);
        props.filterRange = filter ? filter.range : [0, 0];
        props.updateTriggers = { ...props.updateTriggers, getFilterValue: t0 };
    }

    return new LayerClass(props);
}

// Shader bounds are inclusive and float32; nudging both up by ~8 ulp makes the
// window exactly (lo, hi] for row times that are themselves exact.
const nudge = (v) => v + (Math.abs(v) + 1) * 2 ** -20;

/**
 * Client-side playback of `timeFilter`; returns the GPU filter for layers that
 * declare `getFilterValue`, or null when no time filter is set.
 */
function useTimeFilter(timeFilter, setProps) {
    const tf = timeFilter || null;
    const [t0, t1] = tf && Array.isArray(tf.domain) ? tf.domain.map(Number) : [0, 0];
    const step = tf && tf.step > 0 ? Number(tf.step) : null;
    const win = tf && tf.window != null ? Number(tf.window) : (step || t1 - t0);
    const speed = tf && tf.speed > 0 ? Number(tf.speed) : (step || (t1 - t0) / 10);
    const playing = Boolean(tf && tf.playing);
    const loop = Boolean(tf && tf.loop);
    const cur = tf && tf.current != null ? Number(tf.current) : null;

    const snap = useCallback(
        // The small bias stops accumulated float drift flooring onto the previous step.
        (p) => (step ? t0 + Math.floor((p - t0) / step + 1e-6) * step : p),
        [t0, step],
    );

    const posRef = useRef(null);
    const sentRef = useRef([]);
    const lastSentAt = useRef(-Infinity);
    const timerRef = useRef(null);
    const pendingRef = useRef(null);
    const tfRef = useRef(tf);
    tfRef.current = tf;
    const setPropsRef = useRef(setProps);
    setPropsRef.current = setProps;
    const [shown, setShown] = useState(null);

    // Only playback reports: echoing a Python seek back would race the user's next drag.
    const report = useCallback((t) => {
        pendingRef.current = t;
        if (timerRef.current != null) return;
        const wait = REPORT_INTERVAL_MS - (performance.now() - lastSentAt.current);
        timerRef.current = setTimeout(() => {
            timerRef.current = null;
            lastSentAt.current = performance.now();
            sentRef.current.push({ t: pendingRef.current, at: lastSentAt.current });
            setPropsRef.current && setPropsRef.current({ filterTime: pendingRef.current });
        }, Math.max(wait, 0));
    }, []);
    useEffect(() => () => clearTimeout(timerRef.current), []);

    // Seek when Python sets a new `current`, unless it is our own report echoed back.
    // A new domain is a new block of data, so its `current` is never an echo.
    const domainRef = useRef(null);
    useEffect(() => {
        if (!tf) return;
        if (domainRef.current !== `${t0},${t1}`) sentRef.current = [];
        domainRef.current = `${t0},${t1}`;
        const now = performance.now();
        sentRef.current = sentRef.current.filter(r => now - r.at < ECHO_MS);
        const echo = sentRef.current.some(r => r.t === cur);
        let p = posRef.current;
        if (p == null || (cur != null && !echo)) {
            p = cur != null ? cur : t0;
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
        p = Math.min(Math.max(p, t0), t1);
        posRef.current = p;
        setShown(snap(p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tf != null, cur, t0, t1, snap]);

    useEffect(() => {
        if (!playing) return undefined;
        const end = t1 + (step || 0);
        if (posRef.current == null || posRef.current >= (loop ? end : t1)) posRef.current = t0;
        let prev = snap(posRef.current);
        setShown(prev);
        report(prev);

        let rafId = null;
        let lastTs = null;
        const stop = () => {
            if (rafId != null) cancelAnimationFrame(rafId);
            rafId = null;
        };
        const tick = (ts) => {
            rafId = requestAnimationFrame(tick);
            if (lastTs == null) { lastTs = ts; return; }
            if (ts - lastTs < FRAME_INTERVAL_MS) return;
            let p = posRef.current + ((ts - lastTs) / 1000) * speed;
            lastTs = ts;
            if (p >= end && loop) p = t0;
            const finished = !loop && p >= t1;
            if (finished) p = t1;
            posRef.current = p;
            const s = snap(p);
            if (s !== prev) { prev = s; setShown(s); report(s); }
            if (finished) {
                stop();
                // `current` is left as Python last set it, so this is not a seek.
                setPropsRef.current && setPropsRef.current({ timeFilter: { ...tfRef.current, playing: false } });
            }
        };
        const start = () => {
            if (rafId == null) { lastTs = null; rafId = requestAnimationFrame(tick); }
        };
        const onVisibility = () => (document.hidden ? stop() : start());
        document.addEventListener('visibilitychange', onVisibility);
        if (!document.hidden) start();
        return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            stop();
        };
    }, [playing, loop, t0, t1, step, speed, snap, report]);

    return useMemo(() => {
        if (!tf || shown == null) return null;
        const hi = shown - t0;
        return { t0, range: [nudge(hi - win), nudge(hi)] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tf != null, shown, t0, win]);
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
    timeFilter,
    setProps,
}) {
    const filter = useTimeFilter(timeFilter, setProps);

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

    // Static layers: rebuilt when their specs or the time-filter step change, never per
    // trips frame. A filter step only changes filterRange, so no attribute is recomputed.
    const otherLayers = useMemo(
        () => otherSpecs.map(s => buildLayer(s, undefined, filter)).filter(Boolean),
        [otherSpecs, filter],
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
        () => tripsSpecs.map(s => buildLayer(s, currentTime, filter)).filter(Boolean),
        [tripsSpecs, currentTime, filter],
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
    /**
     * Client-side time window over layers whose `_accessors` name a
     * `getFilterValue` column: {domain: [t0, t1], step, window, current,
     * playing, speed, loop}. Rows with current - window < t <= current are drawn.
     */
    timeFilter: PropTypes.shape({
        domain: PropTypes.arrayOf(PropTypes.number).isRequired,
        step: PropTypes.number,
        window: PropTypes.number,
        current: PropTypes.number,
        playing: PropTypes.bool,
        speed: PropTypes.number,
        loop: PropTypes.bool,
    }),
    /** Output-only. The step-snapped playback position, at most 4 Hz while playing. */
    filterTime: PropTypes.number,
    /** Injected by Dash to propagate prop updates back to Python */
    setProps: PropTypes.func,
};

EpecDeckMap.defaultProps = {
    layers: [],
    pickingRadius: 5,
};

export { EpecDeckMap };
export default EpecDeckMap;
