"""Package the local-only v6 game for user-managed GitHub Pages publication."""
from pathlib import Path
import zipfile,hashlib,json,sys
project=Path(__file__).resolve().parents[1]
out=Path(sys.argv[1]).resolve()
assert json.loads((project/'package.json').read_text(encoding='utf-8'))['version']=='6.0.0'
assert (project/'index.html').is_file() and (project/'validation/browser-v6.json').is_file()
assert json.loads((project/'validation/drivers-v6.json').read_text(encoding='utf-8'))['combinations']==72
excluded={'.git','node_modules','__pycache__','.sites-workflow','.openai'}
files=[]
for p in sorted(project.rglob('*')):
 if not p.is_file():continue
 relative=p.relative_to(project)
 if any(x in excluded for x in relative.parts) or p.name.startswith('.env') or p.suffix in {'.zip','.log','.pyc'}:continue
 assert p.resolve().is_relative_to(project.resolve())
 files.append(p)
out.parent.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED,compresslevel=8) as z:
 for p in files:z.write(p,p.relative_to(project).as_posix())
with zipfile.ZipFile(out) as z:
 assert z.testzip() is None
 names=set(z.namelist())
 for required in ['index.html','.nojekyll','asset-manifest.json','assets/licenses/Kenney_CubePets/License.txt','src/drivers.js']:
  assert required in names
 assert len([n for n in names if n.startswith('assets/drivers/') and n.endswith('.glb')])==24
digest=hashlib.sha256(out.read_bytes()).hexdigest()
out.with_suffix(out.suffix+'.sha256.txt').write_text(digest+'  '+out.name+'\n',encoding='utf-8')
report={'zip':out.name,'bytes':out.stat().st_size,'files':len(files),'sha256':digest,'version':'6.0.0','models':216,'animalDrivers':24,'license':'CC0-1.0 for added Kenney animals','publishedByAgent':False}
out.with_suffix(out.suffix+'.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False))
