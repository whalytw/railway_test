"""Validate and package v7 for the user's own static/GitHub Pages hosting.

Usage: python scripts/package-v7.py output.zip --baseline ../rail-loop-lab-v6
No credentials, Git mutations, source downloads or publication are performed.
"""
from pathlib import Path
import argparse
import hashlib
import json
import zipfile

project = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('archive', type=Path)
parser.add_argument('--baseline', type=Path, help='Optional v6 source to prove existing GLBs are unchanged')
args = parser.parse_args()
output = args.archive.resolve()
assert not output.is_relative_to(project), 'Put the delivery ZIP outside the source tree.'
assert json.loads((project / 'package.json').read_text(encoding='utf-8'))['version'] == '7.0.0'

# Same source fingerprint as scripts/verify-v7.mjs. Documentation and captured
# images can be added after tests; runtime or test edits require verification.
fingerprint_files = []
for folder in ['src', 'tests']:
    fingerprint_files += [p.relative_to(project).as_posix() for p in (project / folder).iterdir() if p.suffix in ['.js', '.mjs']]
fingerprint_files += [p.name for p in project.iterdir() if p.is_file() and (p.suffix in ['.html', '.css'] or p.name in ['package.json', 'asset-manifest.json'])]
fingerprint_files.append('scripts/verify-v7.mjs')
fingerprint = hashlib.sha256()
for name in sorted(fingerprint_files):
    fingerprint.update(name.encode('utf-8') + b'\0')
    fingerprint.update((project / name).read_bytes())
    fingerprint.update(b'\0')
source_sha = fingerprint.hexdigest()
tests = json.loads((project / 'validation/automated-v7.json').read_text(encoding='utf-8-sig'))
assert tests['exitCode'] == 0 and tests['failed'] == 0 and tests['passed'] == tests['total'] >= 65
assert tests['sourceSha256'] == source_sha and tests['sourceUnchangedDuringTests']
browser = json.loads((project / 'validation/browser-v7.json').read_text(encoding='utf-8-sig'))
assert browser['errorsSinceFinalReload'] == 0 and browser['warningsSinceFinalReload'] == 0
assert set(browser['reviewViews']) == {'tunnel', 'river', 'farm', 'grass'} and browser['gameStarted']

unchanged = None
if args.baseline:
    baseline = args.baseline.resolve()
    models = list((baseline / 'assets').rglob('*.glb'))
    assert len(models) == 334
    for model in models:
        assert (project / model.relative_to(baseline)).read_bytes() == model.read_bytes(), str(model)
    unchanged = len(models)

excluded_dirs = {'.git', 'node_modules', '__pycache__', '.sites-workflow', '.openai'}
def included_files():
    files = []
    for p in project.rglob('*'):
        if not p.is_file():
            continue
        rel = p.relative_to(project)
        if any(part in excluded_dirs for part in rel.parts) or p.name.startswith('.env') or p.suffix in {'.zip', '.log', '.pyc', '.tmp'}:
            continue
        assert p.resolve().is_relative_to(project)
        files.append(p)
    return sorted(files, key=lambda p: p.relative_to(project).as_posix())

delivery_path = project / 'validation/delivery-v7.json'
checksum_path = project / 'CHECKSUMS.sha256'
base_count = len([p for p in included_files() if p not in [delivery_path, checksum_path]])
delivery = {'version': '7.0.0', 'files': base_count + 2, 'mainModels': 216, 'animalDrivers': 24, 'lodModels': 118,
            'unchangedLegacyGlbs': unchanged, 'sourceSha256': source_sha, 'testsPassed': tests['passed'],
            'publishedByAgent': False, 'implementedRequests': [1, 2, 3, 4], 'request5Status': 'planning only: FUTURE-TERRAINS.md'}
delivery_path.write_text(json.dumps(delivery, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
checksum_files = [p for p in included_files() if p != checksum_path]
checksum_path.write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.relative_to(project).as_posix() + '\n' for p in checksum_files), encoding='utf-8')
files = included_files()
assert len(files) == delivery['files']
output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=8) as z:
    for p in files:
        z.write(p, p.relative_to(project).as_posix())
with zipfile.ZipFile(output) as z:
    assert z.testzip() is None
    names = set(z.namelist())
    for name in ['index.html', '.nojekyll', 'landscape-review.html', 'LANDSCAPE-v7.md', 'FUTURE-TERRAINS.md', 'assets/licenses/Kenney_CubePets/License.txt']:
        assert name in names
    assert len([name for name in names if name.startswith('assets/drivers/') and name.endswith('.glb')]) == 24
    for line in z.read('CHECKSUMS.sha256').decode('utf-8').splitlines():
        expected, name = line.split('  ', 1)
        assert hashlib.sha256(z.read(name)).hexdigest() == expected, name
digest = hashlib.sha256(output.read_bytes()).hexdigest()
report = {**delivery, 'zip': output.name, 'bytes': output.stat().st_size, 'sha256': digest}
output.with_suffix(output.suffix + '.sha256.txt').write_text(digest + '  ' + output.name + '\n', encoding='utf-8')
output.with_suffix(output.suffix + '.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report, ensure_ascii=False))
