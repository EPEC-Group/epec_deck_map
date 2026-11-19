import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import DeckGL from '@deck.gl/react';
import { DataFilterExtension } from '@deck.gl/extensions';
import { IconLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
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

const DEFAULT_CHEVRONS = { interval: 80, size: 6, color: [255, 255, 255, 255], clearance: 10, maxTurn: 150, speed: 0, merge: 0 };
const CHEVRON_ICON_PX = 64;
const CHEVRON_MAPPING = {
    chevron: { x: 0, y: 0, width: CHEVRON_ICON_PX, height: CHEVRON_ICON_PX, anchorX: 32, anchorY: 32, mask: true },
};
let chevronAtlas = null;

function getChevronAtlas() {
    if (!chevronAtlas) {
        const canvas = document.createElement('canvas');
        canvas.width = CHEVRON_ICON_PX;
        canvas.height = CHEVRON_ICON_PX;
        const ctx = canvas.getContext('2d');
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 16;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(14, 8);
        ctx.lineTo(50, 32);
        ctx.lineTo(14, 56);
        ctx.stroke();
        // Not a data: URL, which deck.gl fetches and the portal CSP blocks.
        chevronAtlas = canvas;
    }
    return chevronAtlas;
}

function toWorld([lng, lat]) {
    const phi = lat * Math.PI / 180;
    return [512 * (lng + 180) / 360, 512 * (0.5 + Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI))];
}

function fromWorld(x, y) {
    const lat = 2 * Math.atan(Math.exp((y / 512 - 0.5) * 2 * Math.PI)) - Math.PI / 2;
    return [x / 512 * 360 - 180, lat * 180 / Math.PI];
}

/** Per-row world geometry for a spec with `chevrons`, or null. */
function chevronTracks(spec) {
    const { chevrons, _accessors = {}, data, id } = spec;
    const { getPath, getDirection } = _accessors;
    if (!chevrons || !data || !getPath || !getDirection) return null;
    const opts = { ...DEFAULT_CHEVRONS, ...chevrons };
    const rows = [];
    for (const row of data) {
        const dir = Number(row[getDirection]);
        const path = row[getPath];
        if ((dir !== 1 && dir !== -1) || !path || path.length < 2) continue;
        const xy = path.map(toWorld);
        const cum = [0];
        for (let i = 1; i < xy.length; i++) {
            cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
        }
        const turn = xy.map((p, i) => {
            if (i === 0 || i === xy.length - 1) return 0;
            const ax = p[0] - xy[i - 1][0];
            const ay = p[1] - xy[i - 1][1];
            const bx = xy[i + 1][0] - p[0];
            const by = xy[i + 1][1] - p[1];
            return Math.atan2(ax * by - ay * bx, ax * bx + ay * by) * 180 / Math.PI;
        });
        const xs = xy.map(p => p[0]);
        const ys = xy.map(p => p[1]);
        rows.push({
            xy, cum, turn, dir,
            box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
        });
    }
    rows.sort((p, q) => q.cum[q.cum.length - 1] - p.cum[p.cum.length - 1]);
    return { id: `${id}-chevrons`, spec, opts, rows };
}

/** Screen-px grid of in-view segments, sampled every merge / 2 px; cells 2 * merge px. */
function mergeGrid(rows, view, scale, merge) {
    const cells = Object.create(null);
    const cell = 2 * merge;
    rows.forEach(({ xy, box }, i) => {
        if (outside(box, view)) return;
        for (let b = 1; b < xy.length; b++) {
            const a = b - 1;
            const seg = [
                Math.min(xy[a][0], xy[b][0]), Math.min(xy[a][1], xy[b][1]),
                Math.max(xy[a][0], xy[b][0]), Math.max(xy[a][1], xy[b][1]),
            ];
            if (outside(seg, view)) continue;
            const x0 = xy[a][0] * scale;
            const y0 = xy[a][1] * scale;
            const dx = xy[b][0] * scale - x0;
            const dy = xy[b][1] * scale - y0;
            const n = Math.ceil(Math.hypot(dx, dy) / (merge / 2));
            let last = null;
            for (let k = 0; k <= n; k++) {
                const key = `${Math.floor((x0 + dx * k / n) / cell)},${Math.floor((y0 + dy * k / n) / cell)}`;
                if (key === last) continue;
                last = key;
                (cells[key] || (cells[key] = [])).push(i, a);
            }
        }
    });
    return cells;
}

/** True when a row before `i` runs within `merge` px of (px, py) heading the same way. */
function covered(cells, rows, i, px, py, hx, hy, scale, merge) {
    const cell = 2 * merge;
    const cx = Math.floor(px / cell);
    const cy = Math.floor(py / cell);
    for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
            const list = cells[`${cx + ox},${cy + oy}`];
            if (!list) continue;
            for (let k = 0; k < list.length; k += 2) {
                const j = list[k];
                if (j >= i) continue;
                const { xy, dir } = rows[j];
                const a = list[k + 1];
                const ax = xy[a][0] * scale;
                const ay = xy[a][1] * scale;
                const sx = xy[a + 1][0] * scale - ax;
                const sy = xy[a + 1][1] * scale - ay;
                const len2 = sx * sx + sy * sy;
                if (!(len2 > 0)) continue;
                const t = Math.max(0, Math.min(1, ((px - ax) * sx + (py - ay) * sy) / len2));
                if (Math.hypot(ax + t * sx - px, ay + t * sy - py) >= merge) continue;
                if ((dir * (sx * hx + sy * hy)) / Math.sqrt(len2) > 0.7) return true;
            }
        }
    }
    return false;
}

/** Rotation easing the heading through bends within `clearance` px of `at`, or null past `maxTurn`. */
function bendRotation({ cum, turn }, a, at, scale, { clearance, maxTurn }) {
    let rot = 0;
    const ease = (k) => {
        if (Math.abs(turn[k]) > maxTurn) return false;
        rot += turn[k] * ((at - cum[k] * scale) / (2 * clearance) + 0.5 - (k <= a ? 1 : 0));
        return true;
    };
    for (let k = a; k > 0 && at - cum[k] * scale < clearance; k--) if (!ease(k)) return null;
    for (let k = a + 1; k < turn.length - 1 && cum[k] * scale - at < clearance; k++) if (!ease(k)) return null;
    return rot;
}

const outside = (box, v) => box[2] < v[0] || box[0] > v[2] || box[3] < v[1] || box[1] > v[3];

/** Chevrons inside world rect `view`, every `interval` px, shifted `travel` px along the flow. */
function chevronLayer({ id, spec, opts, rows }, zoom, view, travel) {
    const { interval, size, color, merge } = opts;
    const scale = 2 ** zoom;
    const cells = merge > 0 ? mergeGrid(rows, view, scale, merge) : null;
    const marks = [];
    rows.forEach((row, i) => {
        const { xy, cum, dir, box } = row;
        if (outside(box, view)) return;
        const length = cum[cum.length - 1] * scale;
        if (length < 2 * size) return;
        const base = ((((length % interval) / 2 + dir * travel) % interval) + interval) % interval;
        for (let b = 1; b < xy.length; b++) {
            const a = b - 1;
            const seg = [
                Math.min(xy[a][0], xy[b][0]), Math.min(xy[a][1], xy[b][1]),
                Math.max(xy[a][0], xy[b][0]), Math.max(xy[a][1], xy[b][1]),
            ];
            const s0 = cum[a] * scale;
            const s1 = cum[b] * scale;
            if (!(s1 > s0) || outside(seg, view)) continue;
            const dx = xy[b][0] - xy[a][0];
            const dy = xy[b][1] - xy[a][1];
            const angle = Math.atan2(dir * dy, dir * dx) * 180 / Math.PI;
            const hx = dir * dx * scale / (s1 - s0);
            const hy = dir * dy * scale / (s1 - s0);
            for (let at = base + Math.ceil((s0 - base) / interval) * interval; at < s1; at += interval) {
                const rot = bendRotation(row, a, at, scale, opts);
                if (rot === null) continue;
                const f = (at - s0) / (s1 - s0);
                const wx = xy[a][0] + f * dx;
                const wy = xy[a][1] + f * dy;
                if (cells && covered(cells, rows, i, wx * scale, wy * scale, hx, hy, scale, merge)) continue;
                marks.push({ position: fromWorld(wx, wy), angle: angle + rot });
            }
        }
    });
    return new IconLayer({
        id,
        data: marks,
        iconAtlas: getChevronAtlas(),
        iconMapping: CHEVRON_MAPPING,
        getIcon: () => 'chevron',
        getPosition: d => d.position,
        getAngle: d => d.angle,
        getColor: color,
        getSize: size,
        sizeUnits: 'pixels',
        billboard: false,
        pickable: false,
        visible: spec.visible !== false && inZoomRange(spec, zoom),
    });
}

function rowPulseSpacing(span, trail, pulseSpacing) {
    const fit = Math.max(span, trail / 2);
    return fit >= pulseSpacing ? pulseSpacing : pulseSpacing / Math.ceil(pulseSpacing / fit);
}

function expandPulses(spec) {
    const { pulseSpacing, _accessors = {}, data } = spec;
    const key = _accessors.getTimestamps;
    if (!(pulseSpacing > 0) || !key || !data) return spec;
    const trail = spec.trailLength != null ? spec.trailLength : DEFAULT_TRAIL_LENGTH;
    const cycle = spec.loopLength != null ? Number(spec.loopLength) : pulseSpacing;
    const rows = [];
    for (const row of data) {
        const ts = row[key];
        if (!ts || ts.length === 0) continue;
        const lo = Math.min(ts[0], ts[ts.length - 1]);
        const hi = Math.max(ts[0], ts[ts.length - 1]);
        const gap = rowPulseSpacing(hi - lo, trail, pulseSpacing);
        for (let k = Math.floor((lo - cycle) / gap); k <= Math.ceil((hi + trail) / gap); k++) {
            rows.push(k === 0 ? row : { ...row, [key]: ts.map(t => t - k * gap) });
        }
    }
    return { ...spec, data: rows };
}

const FILTER_EXTENSIONS = [new DataFilterExtension({ filterSize: 1 })];
const REPORT_INTERVAL_MS = 250;
const ECHO_MS = 5000;

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

function buildLayer(spec, zoom, currentTime, filter) {
    const {
        _type, _accessors = {}, loopLength, minZoom, maxZoom,
        pulseSpacing, speedZoom, speedZoomStrength, chevrons, ...rest
    } = spec;
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
        if (propName === 'getDirection') continue;
        props[propName] = (d) => d[dataKey];
        updateTriggers[propName] = dataKey;
    }
    props.updateTriggers = updateTriggers;

    // float32 attribute, so times are relative to the domain start.
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

// Inclusive float32 bounds; the nudge makes the window (lo, hi].
const nudge = (v) => v + (Math.abs(v) + 1) * 2 ** -20;

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
    timeFilter,
    setProps,
}) {
    const initialViewState = viewState || {
        latitude: -25.5,
        longitude: 134.5,
        zoom: 4,
        pitch: 0,
    };

    const zoomRef = useRef(initialViewState.zoom);
    const viewRef = useRef(initialViewState);
    const viewVersion = useRef(0);
    const containerRef = useRef(null);
    const viewKeyRef = useRef(null);
    const viewKey = JSON.stringify(initialViewState);
    if (viewKeyRef.current !== viewKey) {
        viewKeyRef.current = viewKey;
        zoomRef.current = initialViewState.zoom;
        viewRef.current = initialViewState;
    }
    const gateKey = zoomGateKey(layers, zoomRef.current);
    const layersRef = useRef(layers);
    const gateKeyRef = useRef(gateKey);
    layersRef.current = layers;
    gateKeyRef.current = gateKey;
    const [, forceRender] = useReducer(n => n + 1, 0);

    const handleViewStateChange = useCallback(({ viewState: vs }) => {
        zoomRef.current = vs.zoom;
        viewRef.current = vs;
        viewVersion.current += 1;
        if (zoomGateKey(layersRef.current, vs.zoom) !== gateKeyRef.current) {
            forceRender();
        }
    }, []);

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

    const otherLayers = useMemo(
        () => otherSpecs.map(s => buildLayer(s, zoomRef.current, undefined, filter)),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [otherSpecs, gateKey, filter],
    );
    const chevronSets = useMemo(() => otherSpecs.map(chevronTracks), [otherSpecs]);
    const [chevronClock, setChevronClock] = useState(0);
    useEffect(() => {
        if (!chevronSets.some(Boolean)) return undefined;
        const moving = chevronSets.some(c => c && c.opts.speed > 0);
        let rafId = null;
        let last = 0;
        let seen = -1;
        const tick = (ts) => {
            rafId = requestAnimationFrame(tick);
            if (ts - last < FRAME_INTERVAL_MS) return;
            last = ts;
            if (moving || seen !== viewVersion.current) {
                seen = viewVersion.current;
                setChevronClock(ts);
            }
        };
        const start = () => { if (rafId == null) rafId = requestAnimationFrame(tick); };
        const stop = () => { if (rafId != null) cancelAnimationFrame(rafId); rafId = null; };
        const onVisibility = () => (document.hidden ? stop() : start());
        document.addEventListener('visibilitychange', onVisibility);
        if (!document.hidden) start();
        return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            stop();
        };
    }, [chevronSets]);
    const chevronLayers = useMemo(() => {
        const { longitude, latitude, zoom } = viewRef.current;
        const el = containerRef.current;
        const r = Math.hypot(el ? el.clientWidth : 2000, el ? el.clientHeight : 2000) / 2 / 2 ** zoom;
        const [cx, cy] = toWorld([longitude, latitude]);
        const view = [cx - r, cy - r, cx + r, cy + r];
        return chevronSets.map(c => c && chevronLayer(c, zoom, view, chevronClock / 1000 * c.opts.speed));
    }, [chevronSets, chevronClock]);

    // A single shared cycle length for all pulses: the max loopLength across
    // trips specs (falling back to the default). currentTime sweeps 0..loopLength.
    const loopLength = useMemo(() => {
        let maxLen = 0;
        for (const s of tripsSpecs) {
            const v = Number(s.loopLength != null ? s.loopLength : s.pulseSpacing);
            if (Number.isFinite(v) && v > maxLen) maxLen = v;
        }
        return maxLen > 0 ? maxLen : DEFAULT_LOOP_LENGTH;
    }, [tripsSpecs]);

    // Advanced by the rAF loop below; only meaningful when trips layers exist.
    const [currentTime, setCurrentTime] = useState(0);

    const [speedZoom, speedZoomStrength] = useMemo(() => {
        const s = tripsSpecs.find(t => t.speedZoom != null);
        if (!s) return [null, 1];
        const k = Number(s.speedZoomStrength);
        return [Number(s.speedZoom), Number.isFinite(k) ? k : 1];
    }, [tripsSpecs]);

    // Animation loop — runs only while there is at least one TripsLayer spec and
    // the tab is visible. Throttled to ~30fps; pauses on visibilitychange.
    useEffect(() => {
        if (tripsSpecs.length === 0) {
            return undefined;  // no trips layers → no loop at all
        }

        let rafId = null;
        let prevTs = null;
        let lastFrameTs = 0;
        let time = 0;

        const tick = (ts) => {
            rafId = requestAnimationFrame(tick);
            if (ts - lastFrameTs < FRAME_INTERVAL_MS) return;  // throttle
            lastFrameTs = ts;
            const rate = speedZoom == null ? 1 : 2 ** (-speedZoomStrength * Math.max(0, zoomRef.current - speedZoom));
            if (prevTs != null) {
                time = (time + (ts - prevTs) * rate * loopLength / CYCLE_DURATION_MS) % loopLength;
            }
            prevTs = ts;
            setCurrentTime(time);
        };

        const start = () => {
            if (rafId == null) {
                prevTs = null;
                time = 0;
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
    }, [tripsSpecs, loopLength, speedZoom, speedZoomStrength]);

    // Trips layers rebuilt each frame with the current time; drawn on top of the
    // static layers. deck.gl diffs efficiently, so only these update per frame.
    const pulseSpecs = useMemo(() => tripsSpecs.map(expandPulses), [tripsSpecs]);
    const tripsLayers = useMemo(
        () => pulseSpecs.map(s => buildLayer(s, zoomRef.current, currentTime, filter)).filter(Boolean),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [pulseSpecs, currentTime, gateKey, filter],
    );

    const deckLayers = useMemo(
        () => [...otherLayers.flatMap((l, i) => [l, chevronLayers[i]]).filter(Boolean), ...tripsLayers],
        [otherLayers, chevronLayers, tripsLayers],
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
            ref={containerRef}
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
    /** {domain: [t0, t1], step, window, current, playing, speed, loop} */
    timeFilter: PropTypes.shape({
        domain: PropTypes.arrayOf(PropTypes.number).isRequired,
        step: PropTypes.number,
        window: PropTypes.number,
        current: PropTypes.number,
        playing: PropTypes.bool,
        speed: PropTypes.number,
        loop: PropTypes.bool,
    }),
    /** Output-only. Playback position while playing. */
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
