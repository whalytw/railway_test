// Regression evidence is bound to all shipped runtime code and local assets.
// No installation, publishing or source-library writes are performed.
import {spawn} from 'node:child_process';
import {readdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function digest(){
 const files=[];
 async function walk(dir){for(const entry of await readdir(path.join(root,dir),{withFileTypes:true})){const file=dir+'/'+entry.name;if(entry.isDirectory())await walk(file);else files.push(file);}}
 for(const dir of ['src','tests','scripts','assets','vendor'])await walk(dir);
 for(const entry of await readdir(root))if(/\.(html|css)$/.test(entry)||['package.json','asset-manifest.json','server.mjs','START_LOCAL.cmd'].includes(entry))files.push(entry);
 files.sort();const hash=createHash('sha256');for(const file of files)hash.update(file+'\0').update(await readFile(path.join(root,file))).update('\0');return{sha256:hash.digest('hex'),files:files.length};
}
const before=await digest(),started=Date.now();
const tests=(await readdir(path.join(root,'tests'))).filter(f=>f.endsWith('.test.mjs')).sort().map(f=>path.join(root,'tests',f));
const child=spawn(process.execPath,['--test','--test-reporter=spec',...tests],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';
for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output+=chunk.toString();process.stdout.write(chunk);});
let exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code??1));});
const after=await digest();if(before.sha256!==after.sha256)exitCode=1;
const count=name=>Number(output.match(new RegExp(`(?:^|\\n)[^\\n]*?\\b${name} (\\d+)\\s*(?:\\n|$)`))?.[1]||0);
const result={version:'8.0.0',command:'node scripts/verify-v8.mjs',total:count('tests'),passed:count('pass'),failed:count('fail'),exitCode,durationMs:Date.now()-started,finishedAt:new Date().toISOString(),sourceSha256:after.sha256,fingerprintedFiles:after.files,sourceUnchangedDuringTests:before.sha256===after.sha256};
if(!result.total||result.passed!==result.total||result.failed)result.exitCode=1;
await writeFile(path.join(root,'validation/automated-v8.json'),JSON.stringify(result,null,2)+'\n');await writeFile(path.join(root,'validation/test-v8.log'),output);process.exitCode=result.exitCode;
