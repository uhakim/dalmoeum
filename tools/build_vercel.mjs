// Dependency-free static build. Only this allowlist is published by Vercel.
import {copyFile, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url),output=new URL('dist/',root);
const files=['index.html','teacher.html','reports.html','style.css','classroom.css',
  'app.js','classroom.js','teacher.js','reports.js','moon.js','cloud.js'];
const config=JSON.parse(await readFile(new URL('deployment-config.json',root),'utf8'));
const url=new URL(config.supabaseUrl);
if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Invalid Supabase project URL');
await mkdir(output,{recursive:true});
const allowed=new Set([...files,'cloud-config.js','_headers']);
for(const entry of await readdir(output,{withFileTypes:true})){
  if(!entry.isFile()||!allowed.has(entry.name))throw Error('Unexpected file in dist: '+entry.name);
}
for(const name of files)await copyFile(new URL(name,root),new URL(name,output));
await writeFile(new URL('cloud-config.js',output),'window.DAL_CONFIG = '+JSON.stringify({supabaseUrl:url.origin})+';\n');
console.log('Static site built: '+fileURLToPath(output));
