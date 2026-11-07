"""Create and verify a root-ready static-site ZIP. Usage: python script.py OUTPUT.zip"""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

sys.stdout.reconfigure(encoding="utf-8")
root = Path(__file__).resolve().parent.parent
target = Path(sys.argv[1]).resolve()
if target.suffix.lower() != ".zip":
    raise ValueError("Expected a .zip output path")
target.parent.mkdir(parents=True, exist_ok=True)
excluded = {".git", ".agents", ".codex", "node_modules", "__pycache__"}
files = sorted(p for p in root.rglob("*") if p.is_file() and not any(part in excluded for part in p.relative_to(root).parts))
with zipfile.ZipFile(target, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for p in files:
        archive.write(p, p.relative_to(root).as_posix())

with zipfile.ZipFile(target) as archive:
    assert archive.testzip() is None, "ZIP CRC error"
    names = set(archive.namelist())
    for path in ["index.html", ".nojekyll", "asset-manifest.json", "src/app.js", "src/scenery-plan.js", "vendor/GLTFLoader.js", "README.md", "SCENERY_RULES.md", "VALIDATION.md", "validation/tests-v5.txt", "validation/scenery-v5.json"]:
        assert path in names, path
    manifest = json.loads(archive.read("asset-manifest.json"))
    glbs = 0
    for info in manifest["models"].values():
        for spec in [info] + ([info["lod"]] if "lod" in info else []):
            assert spec["url"] in names, spec["url"]
            assert archive.getinfo(spec["url"]).file_size == spec["bytes"], spec["url"]
            glbs += 1
    assert glbs == 310
    assert not any(name.endswith(".blend") or name.startswith("/") or ".." in Path(name).parts for name in names)
    tests = archive.read("validation/tests-v5.txt").decode("utf-8-sig")
    assert "pass 53" in tests and "fail 0" in tests
    validation = json.loads(archive.read("validation/scenery-v5.json"))
    assert validation["checkedFiles"] == 236
    assert [r["placed"] for r in validation["results"]] == [5000, 12000, 12000, 12000]

digest = hashlib.sha256(target.read_bytes()).hexdigest()
target.with_suffix(".zip.sha256.txt").write_text(f"{digest}  {target.name}\n", encoding="utf-8")
print(json.dumps({"archive": str(target), "bytes": target.stat().st_size, "files": len(files), "modelTypes": len(manifest["models"]), "glbFiles": glbs, "crc": "passed", "sha256": digest}, ensure_ascii=False))
