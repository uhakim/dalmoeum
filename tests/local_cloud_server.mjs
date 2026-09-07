// In-memory PostgreSQL + actual Edge HTTP handler for isolated browser tests only.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fixture,password} from './cloud_fixture.mjs';
const root=new URL('../',import.meta.url);
const allowed=new Set(['index.html','teacher.html','reports.html','style.css','classroom.css','app.js','classroom.js','teacher.js','reports.js','moon.js','cloud.js']);
let handler;
const server=createServer(async(req,res)=>{
  try {
    const origin='http://127.0.0.1:'+server.address().port,url=new URL(req.url,origin);
    if(url.pathname==='/functions/v1/classroom') {
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const response=await handler(new Request(url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})}));
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
    }
    if(url.pathname==='/cloud-config.js'){res.setHeader('Content-Type','text/javascript');res.end('window.DAL_CONFIG='+JSON.stringify({supabaseUrl:origin})+';');return;}
    const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(!allowed.has(name)){res.writeHead(404);res.end('Not found');return;}
    res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');
    res.end(await readFile(new URL(name,root)));
  }catch(error){console.error(error);res.writeHead(500);res.end('Test server error');}
});
server.listen(0,'127.0.0.1',async()=>{
  const origin='http://127.0.0.1:'+server.address().port;
  const f=await fixture(origin);handler=f.handler;
  await f.db.query('select * from public.dal_initialize_four($1::text[])',[[password,password+'-2',password+'-3',password+'-4']]);
  const teacher=(await f.rpc('login_teacher','',{password})).token;
  const invitations=(await f.rpc('invitations',teacher)).students;
  console.log(JSON.stringify({origin,password,invitations}));
});
