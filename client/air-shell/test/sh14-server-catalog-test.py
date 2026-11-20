#!/usr/bin/env python3
"""New catalogue input-policy regression; no APK, SDK, network or existing tests."""
import argparse
import importlib.util
import json
from pathlib import Path
import tempfile
spec = importlib.util.spec_from_file_location('shell_build', Path(__file__).resolve().parents[1] / 'build.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
assert build.server_catalog('') == []
with tempfile.TemporaryDirectory() as temporary:
    path = Path(temporary) / 'servers.json'
    def parse(value):
        path.write_text(json.dumps(value), encoding='utf-8')
        return build.server_catalog(str(path))
    sample = [{'name': ' Community ', 'address': 'https://example.org/', 'description': ' Owner description\nwith detail '}]
    assert parse(sample) == [{'name':'Community','address':'https://example.org','description':'Owner description\nwith detail','type':'','thumbnail':'','mode':'online'}]
    query_image = parse([dict(sample[0], type='Sandbox', thumbnail='https://example.org/image.png?width=192', mode='online')])[0]
    assert query_image['type'] == 'Sandbox' and query_image['thumbnail'].endswith('?width=192')
    assert parse([dict(sample[0], thumbnail=None)])[0]['thumbnail'] == ''
    assert parse([dict(sample[0], progression={'mode':'accelerated','acceleration':2})])[0]['progression'] == {'mode':'accelerated','acceleration':2}
    assert parse([dict(sample[0], progression={'mode':'classic','acceleration':20})])[0]['progression']['acceleration'] == 1
    unicode_row = dict(sample[0], name='😀' * 32, description='😀' * 250)
    assert parse([unicode_row])[0]['name'] == unicode_row['name']
    worst = [dict(name='😀' * 32, address='https://' + ('a' * 1000) + str(i) + '.example.org',
                  description='a' + '\x00' * 498 + 'a') for i in range(50)]
    accepted = parse(worst)
    assert 100000 < len(json.dumps(accepted, ensure_ascii=False).encode('utf-8')) <= build.CATALOG_MAX_BYTES
    oversized = [dict(worst[0], address='https://' + ('a' * 6000) + str(i) + '.example.org') for i in range(50)]
    for invalid in ({}, [dict(sample[0], address='https://example.org/deployment')],
                    [dict(sample[0], address='https://user:pass@example.org')],
                    [dict(sample[0], description='x' * 501)], [dict(sample[0], name='')],
                    [dict(sample[0], address='')], sample * 51, [dict(unicode_row, name='😀' * 33)],
                    [dict(unicode_row, description='😀' * 251)], oversized,
                    [dict(sample[0], type='😀' * 21)], [dict(sample[0], mode='offline')],
                    [dict(sample[0], thumbnail='https://user:pass@example.org/image.png')],
                    [dict(sample[0], thumbnail='https://example.org/image.png#')],
                    [dict(sample[0], progression={'mode':'online'})],
                    [dict(sample[0], progression={'mode':'accelerated','acceleration':0})]):
        try:
            parse(invalid)
        except argparse.ArgumentTypeError:
            pass
        else:
            raise AssertionError('Accepted invalid catalogue')
print('Catalogue accepts owner descriptions and rejects malformed/unsafe connection suggestions')
