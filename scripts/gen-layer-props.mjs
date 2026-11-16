// Dumps deck.gl prop names per supported layer and extension for Python spec validation.
import {writeFileSync} from 'node:fs';
import {VERSION} from '@deck.gl/core';
import {PathLayer, ScatterplotLayer, TextLayer} from '@deck.gl/layers';
import {TripsLayer} from '@deck.gl/geo-layers';
import * as extensions from '@deck.gl/extensions';

// Keep in step with LAYER_MAP in EpecDeckMap.react.js.
const LAYERS = {PathLayer, ScatterplotLayer, TextLayer, TripsLayer};

const sorted = names => [...new Set(names)].sort();

function classProps(cls) {
    const defs = {};
    for (let c = cls; c && c !== Function.prototype; c = Object.getPrototypeOf(c)) {
        if (Object.prototype.hasOwnProperty.call(c, 'defaultProps')) {
            for (const [k, v] of Object.entries(c.defaultProps)) {
                if (!(k in defs)) defs[k] = v;
            }
        }
    }
    return defs;
}

function describe(cls) {
    const defs = classProps(cls);
    const isAccessor = v => v !== null && typeof v === 'object' && v.type === 'accessor';
    return {
        props: sorted(Object.keys(defs)),
        accessors: sorted(Object.keys(defs).filter(k => isAccessor(defs[k]))),
    };
}

const layers = {};
for (const [name, cls] of Object.entries(LAYERS)) {
    const d = describe(cls);
    d.props = sorted(['id', ...d.props]);
    layers[name] = d;
}

const exts = {};
for (const [name, cls] of Object.entries(extensions)) {
    if (typeof cls === 'function' && 'defaultProps' in cls) exts[name] = describe(cls);
}

const out = {
    deckgl: VERSION,
    layers,
    extensions: exts,
};
const file = new URL('../epec_deck_map/layer_props.json', import.meta.url);
writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
console.log(`layer_props.json: deck.gl ${out.deckgl}, ${Object.keys(layers).length} layers, ${Object.keys(exts).length} extensions`);
