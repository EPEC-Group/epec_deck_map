"""Pack layer columns into the compact binary data form EpecDeckMap decodes."""

import base64
import sys
from array import array

_TYPES = {
    'int8': ('b', 1), 'uint8': ('B', 1), 'int16': ('h', 2), 'uint16': ('H', 2),
    'int32': ('i', 4), 'uint32': ('I', 4), 'float32': ('f', 4), 'float64': ('d', 8),
}


def encode_array(values, dtype):
    """Encode a flat sequence of numbers as ``{"dtype", "base64"}`` (little-endian)."""
    if dtype not in _TYPES:
        raise ValueError(f'dtype {dtype!r} is not one of {sorted(_TYPES)}')
    typecode, itemsize = _TYPES[dtype]
    arr = array(typecode, values)
    if arr.itemsize != itemsize:
        raise ValueError(f'dtype {dtype!r} has no matching C type on this platform')
    if sys.byteorder == 'big':
        arr.byteswap()
    return {'dtype': dtype, 'base64': base64.b64encode(arr.tobytes()).decode('ascii')}


def _flatten(name, values):
    """Flatten numbers or equal-length number lists; return (flat, size)."""
    if not values:
        return [], 1
    if not isinstance(values[0], (list, tuple)):
        return values, 1
    size = len(values[0])
    if size == 0 or any(len(v) != size for v in values):
        raise ValueError(f'{name}: every value must have the same non-zero length')
    return [x for v in values for x in v], size


def binary_data(columns, dtypes=None, per_vertex=()):
    """Pack ``{accessor: per-object values}`` into binary layer ``data``; ``*Color`` defaults to uint8, others float32."""
    dtypes = dict(dtypes or {})
    vertex_columns = set(per_vertex) | ({'getPath'} & set(columns))
    if vertex_columns and 'getPath' not in columns:
        raise ValueError('per-vertex columns need a getPath column')
    unknown = (set(dtypes) | vertex_columns) - set(columns)
    if unknown:
        raise ValueError(f'unknown columns: {sorted(unknown)}')
    lengths = {len(v) for v in columns.values()}
    if len(lengths) > 1:
        raise ValueError(f'columns differ in length: {sorted(lengths)}')
    length = lengths.pop() if lengths else 0

    data = {'length': length, 'attributes': {}}
    if 'getPath' in columns:
        counts = [len(p) for p in columns['getPath']]
        starts, total = [], 0
        for n in counts:
            starts.append(total)
            total += n
        data['startIndices'] = encode_array(starts, 'uint32')

    for name, values in columns.items():
        if name in vertex_columns:
            if [len(v) for v in values] != counts:
                raise ValueError(f'{name}: vertex counts differ from getPath')
            values = [x for v in values for x in v]
        flat, size = _flatten(name, values)
        is_colour = name.endswith('Color')
        dtype = dtypes.get(name, 'uint8' if is_colour else 'float32')
        attr = {'value': encode_array(flat, dtype), 'size': size}
        if is_colour and dtype == 'uint8':
            attr['normalized'] = True
        data['attributes'][name] = attr
    return data
