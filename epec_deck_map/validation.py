"""Layer spec validation against the deck.gl props dumped by scripts/gen-layer-props.mjs."""

import json
from difflib import get_close_matches
from pathlib import Path

_PROPS = json.loads(Path(__file__).with_name("layer_props.json").read_text(encoding="utf-8"))

# Spec keys the component reads itself and strips before building the deck.gl layer.
SPEC_KEYS = frozenset({"_type", "_accessors", "loopLength"})

# Extension props are accepted on every layer, so a spec never has to name its extensions here.
_EXT_PROPS = frozenset(p for e in _PROPS["extensions"].values() for p in e["props"])
_EXT_ACCESSORS = frozenset(a for e in _PROPS["extensions"].values() for a in e["accessors"])

_KEYS = {t: SPEC_KEYS | _EXT_PROPS | set(d["props"]) for t, d in _PROPS["layers"].items()}
_ACCESSORS = {t: _EXT_ACCESSORS | set(d["accessors"]) for t, d in _PROPS["layers"].items()}


def _hint(name, choices):
    match = get_close_matches(str(name), choices, n=1)
    return f"; did you mean {match[0]!r}?" if match else ""


def _check(spec, i):
    if not isinstance(spec, dict):
        raise ValueError(f"layers[{i}]: expected a dict, got {type(spec).__name__}")
    label = f"layer {spec['id']!r}" if "id" in spec else f"layers[{i}]"
    t = spec.get("_type")
    if t not in _KEYS:
        raise ValueError(f"{label}: unknown _type {t!r}{_hint(t, _KEYS)}")
    keys = _KEYS[t]
    for k in spec:
        if k not in keys:
            raise ValueError(f"{label} ({t}): unknown prop {k!r}{_hint(k, keys)}")
    accessors = spec.get("_accessors", {})
    if not isinstance(accessors, dict):
        raise ValueError(f"{label} ({t}): _accessors must be a dict, got {type(accessors).__name__}")
    for k, v in accessors.items():
        if k not in _ACCESSORS[t]:
            raise ValueError(f"{label} ({t}): unknown accessor {k!r}{_hint(k, _ACCESSORS[t])}")
        if not isinstance(v, str):
            raise ValueError(f"{label} ({t}): accessor {k!r} must name a data key (str), got {type(v).__name__}")


def validate_layers(layers):
    """Raise ValueError on an unknown _type, prop or accessor in any spec; return layers unchanged."""
    for i, spec in enumerate(layers):
        _check(spec, i)
    return layers
