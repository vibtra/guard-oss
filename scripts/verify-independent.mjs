import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, lstatSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const files=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
const errors=[];
const SCANNERS=new Set(['scripts/verify-independent.mjs']);
for(const f of files){
 const full=path.join(root,f);
 if(!existsSync(full)) { errors.push('missing tracked file: '+f);continue; }
 if(lstatSync(full).isSymbolicLink()&&!realpathSync(full).startsWith(root+path.sep))errors.push('external symlink: '+f);
 if(f.endsWith('package.json')){
  const p=JSON.parse(readFileSync(full,'utf8'));
  for(const group of ['dependencies','devDependencies','optionalDependencies'])for(const [name,value] of Object.entries(p[group]??{})){
   if(/^(file:|link:)\//.test(value)||/vibtra-app/.test(value))errors.push('external dependency: '+f+' '+name);
  }
 }
 if(/^(?:\.github\/|scripts\/|apps\/registry\/Dockerfile|pnpm-workspace)/.test(f)&&/\.(?:mjs|py|yml|yaml)$|Dockerfile$/.test(f)&&!SCANNERS.has(f)){
  if(/\/Users\/(?!ada\/)[a-z][a-z0-9._-]*\/|\/private\/tmp\/claude-|\.\.\/vibtra-app/.test(readFileSync(full,'utf8')))errors.push('old checkout path: '+f);
 }
}
if(errors.length)throw Error(errors.join('\n'));
console.log('PASS: '+files.length+' tracked files; no external source symlinks or old-checkout tooling dependencies');
