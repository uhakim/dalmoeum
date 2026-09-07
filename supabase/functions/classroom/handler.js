import {validateState} from './validation.js';

// Dependency injection lets the same HTTP handler run in integration tests.
export function createHandler({rpc, origin, qr}) {
  const headers = {'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'content-type, x-dal-session',
    'Access-Control-Allow-Methods':'GET, POST, PUT, PATCH, OPTIONS','Cache-Control':'no-store','Vary':'Origin','X-Content-Type-Options':'nosniff'};
  return async request => {
    const json = (data, status=200) => Response.json(data,{status,headers});
    if (!origin) return json({error:'DAL_PUBLIC_ORIGIN 설정이 필요해요.'},503);
    if (request.headers.get('origin') && request.headers.get('origin') !== origin) return json({error:'허용되지 않은 접속 주소예요.'},403);
    if (request.method === 'OPTIONS') return new Response(null,{status:204,headers});
    try {
      const url = new URL(request.url), path=url.searchParams.get('path') || '', method=request.method;
      const token = request.headers.get('x-dal-session') || '';
      if (token.length > 128) return json({error:'로그인이 필요해요.'},401);
      let body = {};
      if (['POST','PUT','PATCH'].includes(method)) {
        if (!(request.headers.get('content-type')||'').includes('application/json')) return json({error:'JSON 요청이 필요해요.'},415);
        // Bound actual streamed bytes, including requests without Content-Length.
        const reader=request.body?.getReader(); const chunks=[]; let size=0;
        if (reader) { while (true) {const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>6*1024*1024){await reader.cancel();return json({error:'요청 용량이 너무 커요.'},413);}chunks.push(value);} }
        const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
        try {body=JSON.parse(new TextDecoder().decode(bytes));}catch{return json({error:'JSON 형식을 확인해 주세요.'},400);}
        if (!body || typeof body!=='object' || Array.isArray(body)) return json({error:'요청 형식을 확인해 주세요.'},400);
      }
      const call = async (action,payload={}) => {
        const result=await rpc(action,token,payload);
        if(result.error){const error=Error(result.error);error.status=result.status||400;error.conflict=result.conflict;throw error;}
        return result;
      };
      const month = () => {const value=url.searchParams.get('month');if(!/^(19\d{2}|20\d{2}|2100)-(0[1-9]|1[0-2])$/.test(value||''))throw Error('관찰 월을 확인해 주세요.');return value;};
      const name = value => {if(typeof value!=='string'||!value.trim()||[...value.trim()].length>30)throw Error('이름은 1~30자로 입력해 주세요.');return value.trim();};
      if(path==='/api/classrooms'&&method==='GET')return json(await call('public_classrooms'));
      if(path==='/api/auth/student-pin'&&method==='POST') {
        if(!Number.isInteger(body.classId)||body.classId<1||body.classId>4||!Number.isInteger(body.number)||body.number<1||body.number>40||typeof body.pin!=='string'||!/^\d{4}$/.test(body.pin))throw Error('반, 번호, 4자리 PIN을 확인해 주세요.');
        return json(await call('login_pin',{classId:body.classId,number:body.number,pin:body.pin}));
      }
      if(path==='/api/auth/teacher'&&method==='POST') {
        if(typeof body.password!=='string'||body.password.length>200)throw Error('비밀번호를 확인해 주세요.');
        const username=body.username??'teacher1';
        if(typeof username!=='string'||!/^teacher[1-4]$/.test(username))throw Error('관리 계정을 선택해 주세요.');
        return json(await call('login_teacher',{username,password:body.password}));
      }
      if(path==='/api/auth/student'&&method==='POST') {
        if(typeof body.token!=='string'||! /^[a-f0-9]{64}$/.test(body.token))return json({error:'학생 접속 링크를 확인해 주세요.'},401);
        return json(await call('login_student',{token:body.token}));
      }
      if(path==='/api/me'&&method==='GET')return json(await call('me'));
      if(path==='/api/auth/logout'&&method==='POST')return json(await call('logout'));
      if(path==='/api/student/state'&&method==='GET')return json(await call('read_state'));
      if(path==='/api/student/state'&&method==='PUT') {
        // Authenticate before spending work decoding user-supplied photos.
        const me=await call('me');if(me.role!=='student')return json({error:'학생만 사용할 수 있어요.'},403);
        if(!Number.isInteger(body.revision)||body.revision<0)throw Error('저장 버전을 확인해 주세요.');
        return json(await call('write_state',{state:validateState(body.state),revision:body.revision}));
      }
      if(!path.startsWith('/api/teacher/'))return json({error:'없는 요청이에요.'},404);
      const me=await call('me');if(me.role!=='teacher')return json({error:'선생님만 사용할 수 있어요.'},403);
      if(path==='/api/teacher/students'&&method==='GET')return json(await call('roster',{month:month()}));
      if(path==='/api/teacher/invitations'&&method==='GET')return json(await call('invitations'));
      if(path==='/api/teacher/classroom'&&method==='PATCH')return json(await call('rename_class',{className:name(body.className)}));
      if(path==='/api/teacher/password'&&method==='POST') {
        if(typeof body.current!=='string'||typeof body.password!=='string'||body.current.length>200||[...body.password].length<12||new TextEncoder().encode(body.password).length>72)throw Error('새 비밀번호는 12자 이상, UTF-8 72바이트 이하여야 해요.');
        return json(await call('password',{current:body.current,password:body.password}));
      }
      const match=/^\/api\/teacher\/students\/(\d+)(?:\/(reset-link|reset-pin|qr.svg|backup))?$/.exec(path);
      if(match) {
        const id=Number(match[1]);
        if(!match[2]&&method==='PATCH')return json(await call('rename_student',{id,name:name(body.name)}));
        if(match[2]==='reset-link'&&method==='POST')return json(await call('reset_link',{id}));
        if(match[2]==='reset-pin'&&method==='POST')return json(await call('reset_pin',{id}));
        if(match[2]==='backup'&&method==='GET')return json(await call('backup_student',{id}));
        if(match[2]==='qr.svg'&&method==='GET') {
          const invitations=await call('invitations'),student=invitations.students.find(s=>s.id===id);
          if(!student)return json({error:'학생을 찾지 못했어요.'},404);
          return new Response(await qr(origin+student.path),{headers:{...headers,'Content-Type':'image/svg+xml'}});
        }
      }
      if(path==='/api/teacher/reports'&&method==='GET') {
        const mon=month(),raw=url.searchParams.get('ids')||'';
        if(!/^\d+(,\d+){0,39}$/.test(raw))throw Error('출력할 학생을 선택해 주세요.');
        // Frontend requests one student at a time, keeping Edge memory bounded.
        const ids=[...new Set(raw.split(',').map(Number))];
        if(ids.length!==1)throw Error('한 번에 한 학생의 보고서를 요청해 주세요.');
        return json({month:mon,reports:[await call('report',{id:ids[0],month:mon})]});
      }
      return json({error:'없는 요청이에요.'},404);
    } catch(error) {
      return json({error:error.message||'요청에 실패했어요.',...(error.conflict?{conflict:true}:{})},error.status||400);
    }
  };
}
