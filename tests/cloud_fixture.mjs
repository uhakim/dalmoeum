import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {readFile} from 'node:fs/promises';
import {createHandler} from '../supabase/functions/classroom/handler.js';
import QRCode from 'qrcode';

export const password='test-only-password-28';
export async function fixture(origin='https://classroom.example',{upgrade=true,initialize=true}={}) {
  const db=new PGlite({extensions:{pgcrypto}});
  await db.exec('create role anon; create role authenticated; create role service_role;');
  await db.exec(await readFile(new URL('../supabase/migrations/202609070001_classroom.sql',import.meta.url),'utf8'));
  if(initialize)await db.query('select public.dal_initialize($1,$2,$3)',['3학년 2반',password,28]);
  if(upgrade)await db.exec(await readFile(new URL('../supabase/migrations/202609070002_four_classrooms.sql',import.meta.url),'utf8'));
  const rpc=async(action,session_token='',payload={})=>{
    const result=await db.query('select public.dal_api($1,$2,$3::jsonb) as result',[action,session_token,JSON.stringify(payload)]);
    return result.rows[0].result;
  };
  const handler=createHandler({rpc,origin,qr:value=>QRCode.toString(value,{type:'svg'})});
  const request=async(path,method='GET',body,token='',requestOrigin=origin)=>{
    const parsed=new URL(path,origin),url=new URL('https://project.supabase.co/functions/v1/classroom');
    url.searchParams.set('path',parsed.pathname);for(const [k,v] of parsed.searchParams)url.searchParams.set(k,v);
    const response=await handler(new Request(url,{method,headers:{origin:requestOrigin,'content-type':'application/json','x-dal-session':token},...(body===undefined?{}:{body:JSON.stringify(body)})}));
    const result=(response.headers.get('content-type')||'').includes('json')?await response.json():await response.text();
    return {status:response.status,body:result,headers:response.headers};
  };
  return {db,rpc,handler,request};
}
