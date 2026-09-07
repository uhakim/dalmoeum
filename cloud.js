'use strict';
(() => {
  const base=(window.DAL_CONFIG?.supabaseUrl||'').replace(/\/$/,'');
  const enabled=!!base&&location.protocol!=='file:';
  const storageKey='dalmoeum-session:'+base;
  let token='';try{token=localStorage.getItem(storageKey)||'';}catch{}
  const nativeFetch=window.fetch.bind(window);
  async function request(path,options={}) {
    if(!enabled)return nativeFetch(path,options);
    const source=new URL(path,location.origin),url=new URL(base+'/functions/v1/classroom');
    url.searchParams.set('path',source.pathname);
    for(const [key,value] of source.searchParams)url.searchParams.set(key,value);
    const headers=new Headers(options.headers);headers.delete('X-CSRF-Token');
    if(token)headers.set('X-Dal-Session',token);
    const response=await nativeFetch(url,{...options,headers,credentials:'omit',cache:'no-store'});
    if(response.ok&&source.pathname.startsWith('/api/auth/')) {
      const data=await response.clone().json();
      if(data.token){token=data.token;try{localStorage.setItem(storageKey,token);}catch{}}
      if(source.pathname==='/api/auth/logout'){token='';try{localStorage.removeItem(storageKey);}catch{}}
    }
    return response;
  }
  window.DalCloud={enabled,fetch:request,backupExtension:enabled?'.json':'.sqlite3',
    async backup() {
      if(!enabled)return request('/api/teacher/backup',{cache:'no-store'});
      const read=async path=>{const response=await request(path);const data=await response.json();if(!response.ok)throw Error(data.error||'백업에 실패했어요.');return data;};
      const me=await read('/api/me'),roster=await read('/api/teacher/invitations'),students=[];
      for(const student of roster.students)students.push(await read('/api/teacher/students/'+student.id+'/backup'));
      return new Response(JSON.stringify({format:'dalmoeum-supabase',version:2,classId:me.classId,className:me.className,exportedAt:new Date().toISOString(),students}),{headers:{'Content-Type':'application/json'}});
    }
  };
  // Static hosts do not need extensionless route rewriting.
  if(enabled)for(const a of document.querySelectorAll('a[href="/teacher"]'))a.href='/teacher.html';
})();
