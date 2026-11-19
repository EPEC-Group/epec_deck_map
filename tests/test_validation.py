import json
import re
import unittest
from pathlib import Path

from epec_deck_map import EpecDeckMap, validate_layers
from epec_deck_map.validation import SPEC_KEYS, _PROPS

ROOT = Path(__file__).resolve().parents[1]

PORTAL_LAYERS = [
    {"_type": "PathLayer", "id": "lines", "data": [{"path": [[0, 0], [1, 1]]}],
     "_accessors": {"getPath": "path", "getColor": "color", "getWidth": "width"},
     "widthUnits": "pixels", "widthMinPixels": 1, "pickable": True, "autoHighlight": True,
     "updateTriggers": {"getColor": 1}},
    {"_type": "ScatterplotLayer", "id": "subs", "data": [],
     "_accessors": {"getPosition": "coordinates", "getRadius": "radius", "getFillColor": "color"},
     "radiusUnits": "pixels", "stroked": True, "getLineColor": [0, 0, 0], "visible": True},
    {"_type": "TextLayer", "id": "labels", "data": [],
     "_accessors": {"getPosition": "coordinates", "getText": "label"},
     "getTextAnchor": "middle", "characterSet": ["a", "b"], "getSize": 12, "background": True},
    {"_type": "TripsLayer", "id": "flow", "data": [],
     "_accessors": {"getPath": "path", "getTimestamps": "timestamps", "getColor": "color"},
     "loopLength": 1.0, "trailLength": 0.3, "fadeTrail": True, "widthUnits": "pixels"},
]


class ValidateLayers(unittest.TestCase):
    def assertRejects(self, spec, *fragments):
        with self.assertRaises(ValueError) as cm:
            validate_layers([spec])
        for f in fragments:
            self.assertIn(f, str(cm.exception))

    def test_portal_specs_pass(self):
        self.assertIs(validate_layers(PORTAL_LAYERS), PORTAL_LAYERS)
        EpecDeckMap(id="map", layers=PORTAL_LAYERS)

    def test_static_prop_typo(self):
        self.assertRejects({**PORTAL_LAYERS[0], "widthUnit": "pixels"},
                           "'lines'", "'widthUnit'", "did you mean 'widthUnits'")

    def test_accessor_typo(self):
        spec = {**PORTAL_LAYERS[1], "_accessors": {"getFillColour": "color"}}
        self.assertRejects(spec, "'subs'", "'getFillColour'", "did you mean 'getFillColor'")

    def test_non_accessor_in_accessors(self):
        self.assertRejects({**PORTAL_LAYERS[1], "_accessors": {"pickable": "p"}}, "unknown accessor 'pickable'")

    def test_unknown_type(self):
        self.assertRejects({**PORTAL_LAYERS[0], "_type": "PathLayr"}, "'PathLayr'", "did you mean 'PathLayer'")
        self.assertRejects({"id": "x"}, "unknown _type None")

    def test_non_string_accessor_value(self):
        spec = {**PORTAL_LAYERS[0], "_accessors": {"getPath": ["path"]}}
        self.assertRejects(spec, "accessor 'getPath'", "got list")

    def test_non_dict_spec(self):
        self.assertRejects(None, "layers[0]", "got NoneType")

    def test_extension_props_accepted(self):
        validate_layers([{**PORTAL_LAYERS[0], "filterRange": [0, 1],
                          "_accessors": {"getPath": "path", "getFilterValue": "v"}}])

    def test_constructor_validates(self):
        with self.assertRaises(ValueError):
            EpecDeckMap(id="map", layers=[{**PORTAL_LAYERS[0], "widthUnit": "pixels"}])
        EpecDeckMap(id="map")


class GeneratedPropsInSync(unittest.TestCase):
    react = (ROOT / "epec_deck_map" / "EpecDeckMap.react.js").read_text(encoding="utf-8")

    def test_layer_types_match_layer_map(self):
        body = re.search(r"const LAYER_MAP = \{(.*?)\};", self.react, re.S).group(1)
        self.assertEqual(set(re.findall(r"\w+", body)), set(_PROPS["layers"]))

    def test_spec_keys_cover_stripped_keys(self):
        body = re.search(r"const \{(.*?)\.\.\.rest \} = spec;", self.react, re.S).group(1)
        self.assertLessEqual({k.split("=")[0].strip() for k in body.split(",") if k.strip()}, SPEC_KEYS)

    def test_matches_installed_deckgl(self):
        pkg = ROOT / "node_modules" / "@deck.gl" / "core" / "package.json"
        if not pkg.exists():
            self.skipTest("node_modules not installed")
        self.assertEqual(json.loads(pkg.read_text(encoding="utf-8"))["version"], _PROPS["deckgl"])


if __name__ == "__main__":
    unittest.main()
