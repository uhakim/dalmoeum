-- Run in a dedicated Supabase project. Browser roles have no table/RPC access.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists dal_private;
revoke all on schema dal_private from public, anon, authenticated;

create table dal_private.classroom (
  id boolean primary key default true check (id),
  name text not null check (length(name) between 1 and 30),
  password_hash text not null,
  failed_logins integer not null default 0,
  retry_at timestamptz not null default now()
);
create table dal_private.students (
  id integer primary key check (id between 1 and 40),
  number integer not null unique check (number between 1 and 40),
  name text not null check (length(name) between 1 and 30),
  invitation text not null unique default encode(extensions.gen_random_bytes(32), 'hex'),
  state jsonb not null default '{"version":1,"profile":{},"records":{},"reflections":{}}',
  revision integer not null default 0,
  updated_at timestamptz,
  check (octet_length(state::text) <= 5242880)
);
create table dal_private.sessions (
  hash text primary key,
  role text not null check (role in ('teacher','student')),
  student_id integer references dal_private.students(id) on delete cascade,
  expires timestamptz not null,
  check ((role = 'student') = (student_id is not null))
);
alter table dal_private.classroom enable row level security;
alter table dal_private.students enable row level security;
alter table dal_private.sessions enable row level security;
revoke all on all tables in schema dal_private from public, anon, authenticated;

-- SQL editor / deployment only; never callable by browser or Edge requests.
create function public.dal_initialize(class_name text, teacher_password text, student_count integer default 28)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if length(teacher_password) < 12 or octet_length(teacher_password) > 72 or student_count not between 1 and 40 then
    raise exception 'Password must be at least 12 characters and at most 72 UTF-8 bytes; students 1..40';
  end if;
  insert into dal_private.classroom(name,password_hash)
    values (class_name, extensions.crypt(teacher_password,extensions.gen_salt('bf',10)));
  insert into dal_private.students(id,number,name)
    select n,n,n::text || '번 학생' from generate_series(1,student_count) n;
end $$;
revoke all on function public.dal_initialize(text,text,integer) from public, anon, authenticated, service_role;

create function dal_private.document(s dal_private.students, class_name text)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_set(s.state, '{profile}', coalesce(s.state->'profile','{}'::jsonb) ||
    jsonb_build_object('className',class_name,'studentNumber',s.number::text,'studentName',s.name))
$$;
revoke all on function dal_private.document(dal_private.students,text) from public, anon, authenticated;

-- Each request is one transaction; session revocation and optimistic writes are atomic.
create function public.dal_api(action text, session_token text default '', payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c dal_private.classroom; a dal_private.sessions; s dal_private.students;
  token text; h text; result jsonb; items jsonb; doc jsonb; mon text;
  sid integer; n integer; new_password text;
begin
  -- One classroom, short transactions. Serialize to make revocation/password changes
  -- linearizable and avoid inverse session/student lock ordering during resets.
  perform pg_advisory_xact_lock(649206907);
  select * into c from dal_private.classroom where id;
  if not found then return jsonb_build_object('error','학급 초기 설정이 필요해요. 운영 안내를 확인해 주세요.','status',503); end if;
  if action in ('login_teacher','login_student') then
    delete from dal_private.sessions where expires < now();
    if action = 'login_teacher' then
      select * into c from dal_private.classroom where id for update;
      if c.retry_at > now() and c.failed_logins >= 10 then
        return jsonb_build_object('error','시도가 많아요. 15분 뒤 다시 시도해 주세요.','status',429);
      end if;
      if c.retry_at <= now() then
        update dal_private.classroom set failed_logins=0,retry_at=now()+interval '15 minutes' where id;
      end if;
      if octet_length(coalesce(payload->>'password','')) > 72 or
         extensions.crypt(coalesce(payload->>'password',''),c.password_hash) <> c.password_hash then
        update dal_private.classroom set failed_logins=failed_logins+1 where id;
        return jsonb_build_object('error','비밀번호가 맞지 않아요.','status',401);
      end if;
      update dal_private.classroom set failed_logins=0 where id;
    else
      select * into s from dal_private.students where invitation=payload->>'token' for share;
      if not found then return jsonb_build_object('error','학생 접속 링크를 확인해 주세요.','status',401); end if;
    end if;
    token := encode(extensions.gen_random_bytes(32),'hex');
    insert into dal_private.sessions(hash,role,student_id,expires)
      values(encode(extensions.digest(token,'sha256'),'hex'),case when action='login_teacher' then 'teacher' else 'student' end,
      s.id,now()+case when action='login_teacher' then interval '12 hours' else interval '30 days' end);
    return jsonb_build_object('token',token,'ok',true);
  end if;
  h := encode(extensions.digest(coalesce(session_token,''),'sha256'),'hex');
  -- Lock classroom first: same lock order as teacher login/password operations.
  if action='password' then select * into c from dal_private.classroom where id for update; end if;
  select * into a from dal_private.sessions where hash=h and expires>now() for share;
  if not found then return jsonb_build_object('error','로그인이 필요해요.','status',401); end if;
  if action='me' then
    result := jsonb_build_object('role',a.role,'csrf','','className',c.name);
    if a.role='student' then
      select * into s from dal_private.students where id=a.student_id;
      result := result || jsonb_build_object('student',jsonb_build_object('id',s.id,'number',s.number,'name',s.name));
    end if;
    return result;
  elsif action='logout' then
    delete from dal_private.sessions where hash=h;
    return '{"ok":true}';
  elsif action in ('read_state','write_state') then
    if a.role <> 'student' then return jsonb_build_object('error','학생만 사용할 수 있어요.','status',403); end if;
    select * into s from dal_private.students where id=a.student_id for update;
    if action='write_state' then
      if (payload->>'revision')::integer <> s.revision then
        return jsonb_build_object('error','다른 기기에서 기록이 바뀌었어요. 기록을 내보내 보관하고 새로고침해 주세요.','conflict',true,'status',409);
      end if;
      doc := payload->'state';
      if doc->>'version' <> '1' or jsonb_typeof(doc->'records') is distinct from 'object'
        or jsonb_typeof(doc->'profile') is distinct from 'object' or jsonb_typeof(doc->'reflections') is distinct from 'object'
        or octet_length(doc::text)>5242880 then
        return jsonb_build_object('error','기록 형식 또는 학생별 저장 용량(5MB)을 확인해 주세요.','status',400);
      end if;
      update dal_private.students set state=doc,revision=revision+1,updated_at=now() where id=s.id returning * into s;
      return jsonb_build_object('revision',s.revision,'profile',dal_private.document(s,c.name)->'profile');
    end if;
    return jsonb_build_object('state',dal_private.document(s,c.name),'revision',s.revision,'profile',dal_private.document(s,c.name)->'profile');
  end if;
  if a.role <> 'teacher' then return jsonb_build_object('error','선생님만 사용할 수 있어요.','status',403); end if;
  if action='roster' then
    mon := payload->>'month';
    select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'number',t.number,'name',t.name,
      'days',(select count(*) from jsonb_each(t.state->'records') r where left(r.key,7)=mon),
      'photos',(select count(*) from jsonb_each(t.state->'records') r where left(r.key,7)=mon and r.value->>'photo' is not null),
      'lastDate',(select max(r.key) from jsonb_each(t.state->'records') r where left(r.key,7)=mon),
      'hasReflection',length(trim(coalesce(t.state->'reflections'->>mon,'')))>0,'updatedAt',t.updated_at) order by t.number),'[]')
      into items from dal_private.students t;
    return jsonb_build_object('className',c.name,'students',items,'month',mon);
  elsif action='invitations' then
    select jsonb_agg(jsonb_build_object('id',t.id,'number',t.number,'name',t.name,'path','/index.html#'||t.invitation) order by t.number)
      into items from dal_private.students t;
    return jsonb_build_object('students',items);
  elsif action in ('rename_student','reset_link','report','backup_student') then
    sid := (payload->>'id')::integer;
    select * into s from dal_private.students where id=sid for update;
    if not found then return jsonb_build_object('error','학생을 찾지 못했어요.','status',404); end if;
    if action='rename_student' then
      update dal_private.students set name=trim(payload->>'name'),revision=revision+1 where id=sid;
      return '{"ok":true}';
    elsif action='reset_link' then
      update dal_private.students set invitation=encode(extensions.gen_random_bytes(32),'hex') where id=sid returning * into s;
      delete from dal_private.sessions where student_id=sid;
      return jsonb_build_object('path','/index.html#'||s.invitation);
    elsif action='backup_student' then
      return jsonb_build_object('id',s.id,'number',s.number,'name',s.name,'state',dal_private.document(s,c.name),'revision',s.revision);
    else
      mon := payload->>'month'; doc := dal_private.document(s,c.name);
      select coalesce(jsonb_object_agg(r.key,r.value),'{}') into items from jsonb_each(doc->'records') r where left(r.key,7)=mon;
      doc := jsonb_set(jsonb_set(doc,'{records}',items),'{reflections}',jsonb_build_object(mon,coalesce(doc->'reflections'->>mon,'')));
      return jsonb_build_object('id',s.id,'state',doc);
    end if;
  elsif action='rename_class' then
    update dal_private.classroom set name=trim(payload->>'className') where id;
    update dal_private.students set revision=revision+1;
    return '{"ok":true}';
  elsif action='password' then
    if c.retry_at>now() and c.failed_logins>=10 then return jsonb_build_object('error','15분 뒤 다시 시도해 주세요.','status',429); end if;
    if c.retry_at<=now() then update dal_private.classroom set failed_logins=0,retry_at=now()+interval '15 minutes' where id; end if;
    if octet_length(coalesce(payload->>'current',''))>72 or extensions.crypt(coalesce(payload->>'current',''),c.password_hash)<>c.password_hash then
      update dal_private.classroom set failed_logins=failed_logins+1 where id;
      return jsonb_build_object('error','현재 비밀번호가 맞지 않아요.','status',400);
    end if;
    new_password:=payload->>'password';
    if length(new_password)<12 or octet_length(new_password)>72 then return jsonb_build_object('error','비밀번호는 12자 이상, UTF-8 72바이트 이하여야 해요.','status',400); end if;
    update dal_private.classroom set password_hash=extensions.crypt(new_password,extensions.gen_salt('bf',10)),failed_logins=0 where id;
    delete from dal_private.sessions where role='teacher' and hash<>h;
    return '{"ok":true}';
  end if;
  return jsonb_build_object('error','지원하지 않는 요청이에요.','status',404);
end $$;
revoke all on function public.dal_api(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.dal_api(text,text,jsonb) to service_role;
