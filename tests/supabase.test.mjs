import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fixture,password} from './cloud_fixture.mjs';
import {validateState} from '../supabase/functions/classroom/validation.js';

test('class and number PIN login, persistent lockout and teacher-only reset',async t=>{
  const {db,rpc,request}=await fixture();t.after(()=>db.close());
  await db.query('select * from public.dal_initialize_four($1::text[])',[[password,password+'-2',password+'-3',password+'-4']]);
  const publicData=await request('/api/classrooms');assert.equal(publicData.status,200);
  assert.equal(publicData.body.classrooms.length,4);
  assert.ok(publicData.body.classrooms.every(c=>Object.keys(c).sort().join(',')==='id,name'));
  const teacher=(await rpc('login_teacher','',{password})).token;
  const other=(await rpc('login_teacher','',{username:'teacher2',password:password+'-2'})).token;
  const invitations=(await rpc('invitations',teacher)).students;
  const pin=invitations[0].pin;assert.match(pin,/^\d{4}$/);
  const login=await request('/api/auth/student-pin','POST',{classId:1,number:1,pin});
  assert.equal(login.status,200);const token=login.body.token;
  assert.equal((await rpc('me',token)).student.id,1);
  assert.equal((await rpc('me',token)).classId,1);
  assert.equal((await rpc('invitations',token)).status,403);
  assert.equal((await request('/api/teacher/students/1/reset-pin','POST',{},other)).status,404);
  assert.equal((await request('/api/teacher/students/1/reset-pin','POST',{},token)).status,403);
  // Leading zeroes are significant; no numeric PIN coercion at the HTTP boundary.
  assert.equal((await request('/api/auth/student-pin','POST',{classId:1,number:1,pin:Number(pin)})).status,400);
  await db.query("update dal_private.students set login_pin='0007' where id=2");
  assert.equal((await request('/api/auth/student-pin','POST',{classId:1,number:2,pin:'0007'})).status,200);
  const wrong=pin==='0000'?'0001':'0000';
  for(let i=0;i<4;i++)assert.equal((await request('/api/auth/student-pin','POST',{classId:1,number:1,pin:wrong})).status,401);
  assert.equal((await request('/api/auth/student-pin','POST',{classId:1,number:1,pin:wrong})).status,429);
  assert.equal((await request('/api/auth/student-pin','POST',{classId:1,number:1,pin})).status,429);
  assert.equal((await rpc('invitations',teacher)).students[0].pinLocked,true);
  const reset=await request('/api/teacher/students/1/reset-pin','POST',{},teacher);
  assert.equal(reset.status,200);assert.notEqual(reset.body.pin,pin);
  assert.equal((await rpc('me',token)).status,401);
  assert.equal((await request('/api/auth/student-pin','POST',{classId:1,number:1,pin:reset.body.pin})).status,200);
  assert.equal((await rpc('invitations',teacher)).students[0].pinLocked,false);
  const backup=await rpc('backup_student',teacher,{id:1});assert.equal(backup.pin,undefined);assert.equal(backup.login_pin,undefined);
  for(const role of ['anon','authenticated','service_role']){
    await db.exec('set role '+role);
    await assert.rejects(()=>db.query("select public.dal_api_links('login_student','','{}')"),/permission denied/);
    await db.exec('reset role');
  }
});

test('four classrooms isolate every teacher operation and student record',async t=>{
  const {db,rpc,request}=await fixture();t.after(()=>db.close());
  const passwords=[password,password+'-2',password+'-3',password+'-4'];
  const created=await db.query('select * from public.dal_initialize_four($1::text[])',[passwords]);
  assert.deepEqual(created.rows.map(r=>r.created),[false,true,true,true]);
  const again=await db.query('select * from public.dal_initialize_four($1::text[])',[['','','','']]);
  assert.ok(again.rows.every(r=>!r.created));
  const teachers=[],students=[],invitations=[];
  for(let i=1;i<=4;i++){
    const login=await request('/api/auth/teacher','POST',{username:'teacher'+i,password:passwords[i-1]});
    assert.equal(login.status,200);teachers.push(login.body.token);
    const me=await rpc('me',login.body.token);assert.equal(me.classId,i);assert.equal(me.username,'teacher'+i);
    const links=(await rpc('invitations',login.body.token)).students;invitations.push(links);
    assert.equal(links.length,28);assert.ok(links.every(s=>s.id>(i-1)*40&&s.id<=i*40));
    const token=(await rpc('login_student','',{token:links[0].path.split('#')[1]})).token;students.push(token);
    const data=(await rpc('read_state',token)).state;
    data.records['2026-09-07']={phase:'full',photo:null,time:'20:00',note:'class '+i};
    assert.equal((await rpc('write_state',token,{state:data,revision:0,classroomId:5-i,id:999})).revision,1);
    assert.equal((await request('/api/auth/teacher','POST',{username:'teacher'+i,password:'other-class-password'})).status,401);
  }
  for(let i=0;i<4;i++)for(let j=0;j<4;j++)if(i!==j){
    const id=invitations[j][0].id;
    for(const action of ['report','backup_student','reset_link','rename_student']){
      assert.equal((await rpc(action,teachers[i],{id,month:'2026-09',name:'intruder',classroomId:j+1})).status,404,action);
    }
    assert.equal((await request('/api/teacher/students/'+id+'/qr.svg','GET',undefined,teachers[i])).status,404);
    assert.equal((await request('/api/teacher/reports?month=2026-09&ids='+id,'GET',undefined,teachers[i])).status,404);
    assert.equal((await rpc('backup_student',students[i],{id})).status,403);
  }
  const before=await db.query('select to_jsonb(s) as value from dal_private.students s where classroom_id<>1 order by id');
  const others=await db.query('select to_jsonb(c) as value from dal_private.classroom c where id<>1 order by id');
  const extra=(await rpc('login_teacher','',{username:'teacher1',password})).token;
  assert.equal((await rpc('rename_class',teachers[0],{className:'새로운 첫 번째 반',classroomId:2})).ok,true);
  assert.equal((await rpc('password',teachers[0],{current:password,password:'changed-class-one-password'})).ok,true);
  assert.equal((await rpc('me',extra)).status,401);
  await rpc('reset_link',teachers[0],{id:invitations[0][0].id});
  assert.equal((await rpc('me',students[0])).status,401);
  assert.deepEqual((await db.query('select to_jsonb(s) as value from dal_private.students s where classroom_id<>1 order by id')).rows,before.rows);
  assert.deepEqual((await db.query('select to_jsonb(c) as value from dal_private.classroom c where id<>1 order by id')).rows,others.rows);
  for(let i=1;i<4;i++){
    assert.equal((await rpc('me',teachers[i])).classId,i+1);
    assert.equal((await rpc('read_state',students[i])).state.records['2026-09-07'].note,'class '+(i+1));
    assert.equal((await rpc('roster',teachers[i],{month:'2026-09',classroomId:1})).students.length,28);
  }
  await assert.rejects(()=>db.query('select public.dal_initialize_class(5,$1,$2,28)',['extra',password]));
  for(const role of ['anon','authenticated','service_role']){
    await db.exec('set role '+role);
    await assert.rejects(()=>db.query('select * from public.dal_initialize_four($1::text[])',[passwords]),/permission denied/);
    await assert.rejects(()=>db.query('select public.dal_initialize_class(2,$1,$2,28)',['extra',password]),/permission denied/);
    await db.exec('reset role');
  }
});

test('upgrade preserves an existing class, password, student link, active sessions and observations',async t=>{
  const {db,rpc}=await fixture(undefined,{upgrade:false});t.after(()=>db.close());
  const teacher=(await rpc('login_teacher','',{password})).token;
  const links=(await rpc('invitations',teacher)).students;
  const student=(await rpc('login_student','',{token:links[0].path.split('#')[1]})).token;
  const state=(await rpc('read_state',student)).state;
  state.records['2026-09-07']={phase:'full',photo:null,time:'',note:'before migration'};
  await rpc('write_state',student,{state,revision:0});
  const revision=(await rpc('read_state',student)).revision;
  await db.exec(await readFile(new URL('../supabase/migrations/202609070002_four_classrooms.sql',import.meta.url),'utf8'));
  assert.equal((await rpc('me',teacher)).classId,1);
  assert.equal((await rpc('read_state',student)).revision,revision);
  assert.equal((await rpc('read_state',student)).state.records['2026-09-07'].note,'before migration');
  assert.deepEqual((await rpc('invitations',teacher)).students,links);
  assert.equal((await rpc('login_teacher','',{username:'teacher1',password})).ok,true);
});

test('fresh four-class initialization is all-or-nothing',async t=>{
  const {db}=await fixture(undefined,{initialize:false});t.after(()=>db.close());
  await assert.rejects(()=>db.query('select * from public.dal_initialize_four($1::text[])',[[password,password,'short',password]]));
  assert.equal((await db.query('select count(*)::integer as n from dal_private.classroom')).rows[0].n,0);
  const result=await db.query('select * from public.dal_initialize_four($1::text[])',[[password,password+'-2',password+'-3',password+'-4']]);
  assert.equal(result.rows.length,4);assert.ok(result.rows.every(r=>r.created));
  assert.equal((await db.query('select count(*)::integer as n from dal_private.students')).rows[0].n,112);
});

test('Supabase SQL + HTTP: authorization, persistence, revocation, reports, backup and password',async t=>{
  const {db,rpc,request}=await fixture();t.after(()=>db.close());
  assert.equal((await request('/api/me')).status,401);
  assert.equal((await request('/api/me','OPTIONS')).status,204);
  assert.equal((await request('/api/me','GET',undefined,'','https://evil.example')).status,403);
  const teacher=(await request('/api/auth/teacher','POST',{password})).body.token;
  assert.match(teacher,/^[a-f0-9]{64}$/);
  const invites=(await request('/api/teacher/invitations','GET',undefined,teacher)).body.students;
  assert.equal(invites.length,28);
  const login=async index=>(await request('/api/auth/student','POST',{token:invites[index].path.split('#')[1]})).body.token;
  const first=await login(0),second=await login(1);
  assert.equal((await request('/api/teacher/invitations','GET',undefined,first)).status,403);
  assert.equal((await rpc('backup_student',first,{id:2})).status,403);
  assert.equal((await request('/api/student/state','GET',undefined,teacher)).status,403);
  const initial=(await request('/api/student/state','GET',undefined,first)).body;
  const state=structuredClone(initial.state);
  state.profile.studentName='forged identity';
  state.records['2026-09-07']={phase:'full',photo:null,time:'20:30',note:'밝은 보름달'};
  state.records['2026-08-07']={phase:'hidden',photo:null,time:'',note:'구름'};
  state.reflections['2026-09']='달의 모양이 바뀌어요.';
  const save=await request('/api/student/state','PUT',{state,revision:initial.revision},first);
  assert.equal(save.status,200);assert.equal(save.body.profile.studentName,'1번 학생');
  assert.equal((await request('/api/student/state','PUT',{state,revision:initial.revision},first)).status,409);
  const independent=(await request('/api/student/state','GET',undefined,second)).body;
  assert.deepEqual(independent.state.records,{});
  const read=(await request('/api/student/state','GET',undefined,await login(0))).body;
  assert.equal(read.state.records['2026-09-07'].note,'밝은 보름달');
  const roster=(await request('/api/teacher/students?month=2026-09','GET',undefined,teacher)).body;
  assert.equal(roster.students[0].days,1);assert.equal(roster.students[0].hasReflection,true);
  const report=(await request('/api/teacher/reports?month=2026-09&ids=1','GET',undefined,teacher)).body;
  assert.deepEqual(Object.keys(report.reports[0].state.records),['2026-09-07']);
  const backup=(await request('/api/teacher/students/1/backup','GET',undefined,teacher)).body;
  assert.equal(Object.keys(backup.state.records).length,2);assert.equal(backup.invitation,undefined);
  const qr=await request('/api/teacher/students/1/qr.svg','GET',undefined,teacher);
  assert.equal(qr.status,200);assert.match(qr.body,/<svg/);
  assert.equal((await request('/api/teacher/students/1','PATCH',{name:'달이'},teacher)).status,200);
  assert.equal((await request('/api/student/state','PUT',{state,revision:save.body.revision},first)).status,409);
  const reset=await request('/api/teacher/students/1/reset-link','POST',{},teacher);
  assert.notEqual(reset.body.path,invites[0].path);
  assert.equal((await request('/api/me','GET',undefined,first)).status,401);
  assert.equal((await request('/api/auth/student','POST',{token:invites[0].path.split('#')[1]})).status,401);
  const renewed=(await request('/api/auth/student','POST',{token:reset.body.path.split('#')[1]})).body.token;
  assert.equal((await request('/api/student/state','GET',undefined,renewed)).body.state.records['2026-09-07'].note,'밝은 보름달');
  const otherTeacher=(await request('/api/auth/teacher','POST',{password})).body.token;
  assert.equal((await request('/api/teacher/password','POST',{current:password,password:'replacement-password-28'},teacher)).status,200);
  assert.equal((await request('/api/me','GET',undefined,otherTeacher)).status,401);
  assert.equal((await request('/api/me','GET',undefined,teacher)).status,200);
  assert.equal((await request('/api/auth/teacher','POST',{password})).status,401);
  assert.equal((await request('/api/auth/teacher','POST',{password:'replacement-password-28'})).status,200);
  assert.equal((await request('/api/teacher/classroom','PATCH',{className:'새 학급'},teacher)).status,200);
  assert.equal((await request('/api/me','GET',undefined,renewed)).body.className,'새 학급');
  assert.equal((await request('/api/auth/logout','POST',{},renewed)).status,200);
  assert.equal((await request('/api/me','GET',undefined,renewed)).status,401);
  // Anonymous/public roles cannot bypass the Edge Function and call privileged RPCs.
  for(const role of ['anon','authenticated']) {
    await db.exec('set role '+role);
    await assert.rejects(()=>db.query("select public.dal_api('invitations','','{}')"),/permission denied/);
    await assert.rejects(()=>db.query('select * from dal_private.students'),/permission denied/);
    await assert.rejects(()=>db.query("select public.dal_initialize('evil','123456789012',1)"),/permission denied/);
    await db.exec('reset role');
  }
  await db.exec('set role service_role');
  assert.equal((await rpc('me',teacher)).role,'teacher');
  await assert.rejects(()=>db.query("select public.dal_initialize('evil','123456789012',1)"),/permission denied/);
  await db.exec('reset role');
});

test('28 independent students save and stale writes cannot overwrite newer data',async t=>{
  const {db,rpc}=await fixture();t.after(()=>db.close());
  const teacher=(await rpc('login_teacher','',{password})).token;
  const students=(await rpc('invitations',teacher)).students;
  const results=await Promise.all(students.map(async(student)=>{
    const token=(await rpc('login_student','',{token:student.path.split('#')[1]})).token;
    const state={version:1,profile:{},records:{'2026-09-07':{phase:'full',photo:null,time:'',note:String(student.id)}},reflections:{}};
    return rpc('write_state',token,{state,revision:0});
  }));
  assert.ok(results.every(r=>r.revision===1));
  const token=(await rpc('login_student','',{token:students[0].path.split('#')[1]})).token;
  const state=(await rpc('read_state',token)).state;
  const writes=await Promise.all([rpc('write_state',token,{state,revision:1}),rpc('write_state',token,{state,revision:1})]);
  assert.equal(writes.filter(r=>r.status===409).length,1);
  assert.equal((await rpc('roster',teacher,{month:'2026-09'})).students.filter(s=>s.days===1).length,28);
});

test('password attempts are limited; corrupt photos, dates, types and oversized input rejected',async t=>{
  const {db,request}=await fixture();t.after(()=>db.close());
  for(let i=0;i<10;i++)assert.equal((await request('/api/auth/teacher','POST',{password:'wrong'})).status,401);
  assert.equal((await request('/api/auth/teacher','POST',{password})).status,429);
  const valid={version:1,profile:{},records:{'2026-09-07':{phase:'full',photo:null,time:'',note:''}},reflections:{}};
  assert.equal(validateState(valid).version,1);
  const photo=structuredClone(valid);photo.records['2026-09-07'].photo='data:image/png;base64,'+btoa('not an image');
  assert.throws(()=>validateState(photo));
  const date=structuredClone(valid);date.records={'2026-02-30':date.records['2026-09-07']};assert.throws(()=>validateState(date));
  assert.throws(()=>validateState({...valid,records:[]}));
  const big=structuredClone(valid);big.records['2026-09-07'].photo='x'.repeat(1500000);assert.throws(()=>validateState(big));
});
