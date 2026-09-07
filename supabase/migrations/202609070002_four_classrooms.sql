-- Upgrade the installed single-class schema without removing records or links.
-- Run AFTER 202609070001_classroom.sql. Apply this file once in SQL Editor.
begin;
select pg_advisory_xact_lock(649206907);

alter table dal_private.classroom drop constraint classroom_id_check;
alter table dal_private.classroom alter column id drop default;
alter table dal_private.classroom alter column id type integer using (case when id then 1 end);
alter table dal_private.classroom add constraint classroom_id_check check(id between 1 and 4);
alter table dal_private.classroom add column teacher_login text;
update dal_private.classroom set teacher_login='teacher1';
alter table dal_private.classroom alter column teacher_login set not null;
alter table dal_private.classroom add constraint classroom_teacher_login_key unique(teacher_login);
alter table dal_private.classroom add constraint classroom_teacher_login_check check(teacher_login='teacher'||id::text);

alter table dal_private.students add column classroom_id integer not null default 1 references dal_private.classroom(id);
alter table dal_private.students alter column classroom_id drop default;
alter table dal_private.students drop constraint students_id_check;
alter table dal_private.students drop constraint students_number_key;
alter table dal_private.students add constraint students_id_check check(id=(classroom_id-1)*40+number);
alter table dal_private.students add constraint students_classroom_number_key unique(classroom_id,number);
alter table dal_private.students add constraint students_id_classroom_key unique(id,classroom_id);
alter table dal_private.sessions add column classroom_id integer not null default 1 references dal_private.classroom(id);
alter table dal_private.sessions alter column classroom_id drop default;
alter table dal_private.sessions add constraint sessions_student_classroom_fkey
  foreign key(student_id,classroom_id) references dal_private.students(id,classroom_id) on delete cascade;
create index sessions_classroom_idx on dal_private.sessions(classroom_id);

create function public.dal_initialize_class(classroom_id integer, class_name text, teacher_password text, student_count integer default 28)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(649206907);
  if classroom_id is null or classroom_id not between 1 and 4 or teacher_password is null
    or length(teacher_password)<12 or octet_length(teacher_password)>72
    or student_count is null or student_count not between 1 and 40 then
    raise exception 'Classroom 1..4; password 12 characters minimum / 72 UTF-8 bytes maximum; students 1..40';
  end if;
  insert into dal_private.classroom(id,name,teacher_login,password_hash)
    values(classroom_id,class_name,'teacher'||classroom_id::text,extensions.crypt(teacher_password,extensions.gen_salt('bf',10)));
  insert into dal_private.students(id,classroom_id,number,name)
    select (classroom_id-1)*40+n,classroom_id,n,n::text||'번 학생' from generate_series(1,student_count) n;
end $$;
revoke all on function public.dal_initialize_class(integer,text,text,integer) from public,anon,authenticated,service_role;

-- Preserve the old setup command for classroom 1 only.
create or replace function public.dal_initialize(class_name text, teacher_password text, student_count integer default 28)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.dal_initialize_class(1,class_name,teacher_password,student_count);
end $$;
revoke all on function public.dal_initialize(text,text,integer) from public,anon,authenticated,service_role;

-- Operator-only setup. Existing classes, passwords and observations are preserved.
-- All four creations are in the caller's transaction: no partial setup on error.
create function public.dal_initialize_four(teacher_passwords text[], class_names text[] default array['1반','2반','3반','4반'], student_counts integer[] default array[28,28,28,28])
returns table(classroom_id integer,login_id text,class_name text,created boolean)
language plpgsql security definer set search_path = '' as $$
declare i integer; added boolean;
begin
  perform pg_advisory_xact_lock(649206907);
  if array_length(teacher_passwords,1) is distinct from 4 or array_length(class_names,1) is distinct from 4
    or array_length(student_counts,1) is distinct from 4 then raise exception 'Provide four passwords, names and student counts'; end if;
  for i in 1..4 loop
    added := not exists(select 1 from dal_private.classroom c where c.id=i);
    if added then perform public.dal_initialize_class(i,class_names[i],teacher_passwords[i],student_counts[i]); end if;
    return query select c.id,c.teacher_login,c.name,added from dal_private.classroom c where c.id=i;
  end loop;
end $$;
revoke all on function public.dal_initialize_four(text[],text[],integer[]) from public,anon,authenticated,service_role;

create or replace function public.dal_api(action text, session_token text default '', payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c dal_private.classroom; a dal_private.sessions; s dal_private.students;
  token text; h text; result jsonb; items jsonb; doc jsonb; mon text;
  sid integer; n integer; new_password text;
begin
  -- Serialize short transactions across the four classes, including revocations.
  perform pg_advisory_xact_lock(649206907);
  if action in ('login_teacher','login_student') then
    if action = 'login_teacher' then
      select * into c from dal_private.classroom
        where teacher_login=coalesce(payload->>'username','teacher1') for update;
      if not found then return jsonb_build_object('error','관리 계정이나 비밀번호를 확인해 주세요.','status',401); end if;
      if c.retry_at > now() and c.failed_logins >= 10 then
        return jsonb_build_object('error','시도가 많아요. 15분 뒤 다시 시도해 주세요.','status',429);
      end if;
      if c.retry_at <= now() then
        update dal_private.classroom set failed_logins=0,retry_at=now()+interval '15 minutes' where id=c.id;
      end if;
      if octet_length(coalesce(payload->>'password','')) > 72 or
         extensions.crypt(coalesce(payload->>'password',''),c.password_hash) <> c.password_hash then
        update dal_private.classroom set failed_logins=failed_logins+1 where id=c.id;
        return jsonb_build_object('error','비밀번호가 맞지 않아요.','status',401);
      end if;
      update dal_private.classroom set failed_logins=0 where id=c.id;
    else
      select * into s from dal_private.students where invitation=payload->>'token' for share;
      if not found then return jsonb_build_object('error','학생 접속 링크를 확인해 주세요.','status',401); end if;
    end if;
    if action='login_student' then select * into c from dal_private.classroom where id=s.classroom_id; end if;
    delete from dal_private.sessions where expires<now() and classroom_id=c.id;
    token := encode(extensions.gen_random_bytes(32),'hex');
    insert into dal_private.sessions(hash,role,student_id,expires,classroom_id)
      values(encode(extensions.digest(token,'sha256'),'hex'),case when action='login_teacher' then 'teacher' else 'student' end,
      s.id,now()+case when action='login_teacher' then interval '12 hours' else interval '30 days' end,c.id);
    return jsonb_build_object('token',token,'ok',true);
  end if;
  h := encode(extensions.digest(coalesce(session_token,''),'sha256'),'hex');
  select * into a from dal_private.sessions where hash=h and expires>now() for share;
  if not found then return jsonb_build_object('error','로그인이 필요해요.','status',401); end if;
  select * into c from dal_private.classroom where id=a.classroom_id;
  if action='me' then
    result := jsonb_build_object('role',a.role,'csrf','','className',c.name,'classId',c.id,'username',case when a.role='teacher' then c.teacher_login else null end);
    if a.role='student' then
      select * into s from dal_private.students where id=a.student_id and classroom_id=c.id;
      result := result || jsonb_build_object('student',jsonb_build_object('id',s.id,'number',s.number,'name',s.name));
    end if;
    return result;
  elsif action='logout' then
    delete from dal_private.sessions where hash=h;
    return '{"ok":true}';
  elsif action in ('read_state','write_state') then
    if a.role <> 'student' then return jsonb_build_object('error','학생만 사용할 수 있어요.','status',403); end if;
    select * into s from dal_private.students where id=a.student_id and classroom_id=c.id for update;
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
      update dal_private.students set state=doc,revision=revision+1,updated_at=now() where id=s.id and classroom_id=c.id returning * into s;
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
      into items from dal_private.students t where t.classroom_id=c.id;
    return jsonb_build_object('className',c.name,'students',items,'month',mon);
  elsif action='invitations' then
    select jsonb_agg(jsonb_build_object('id',t.id,'number',t.number,'name',t.name,'path','/index.html#'||t.invitation) order by t.number)
      into items from dal_private.students t where t.classroom_id=c.id;
    return jsonb_build_object('students',items);
  elsif action in ('rename_student','reset_link','report','backup_student') then
    sid := (payload->>'id')::integer;
    select * into s from dal_private.students where id=sid and classroom_id=c.id for update;
    if not found then return jsonb_build_object('error','학생을 찾지 못했어요.','status',404); end if;
    if action='rename_student' then
      update dal_private.students set name=trim(payload->>'name'),revision=revision+1 where id=sid and classroom_id=c.id;
      return '{"ok":true}';
    elsif action='reset_link' then
      update dal_private.students set invitation=encode(extensions.gen_random_bytes(32),'hex') where id=sid and classroom_id=c.id returning * into s;
      delete from dal_private.sessions where student_id=sid and classroom_id=c.id;
      return jsonb_build_object('path','/index.html#'||s.invitation);
    elsif action='backup_student' then
      return jsonb_build_object('id',s.id,'number',s.number,'name',s.name,'state',dal_private.document(s,c.name),'revision',s.revision,'classroomId',c.id);
    else
      mon := payload->>'month'; doc := dal_private.document(s,c.name);
      select coalesce(jsonb_object_agg(r.key,r.value),'{}') into items from jsonb_each(doc->'records') r where left(r.key,7)=mon;
      doc := jsonb_set(jsonb_set(doc,'{records}',items),'{reflections}',jsonb_build_object(mon,coalesce(doc->'reflections'->>mon,'')));
      return jsonb_build_object('id',s.id,'state',doc);
    end if;
  elsif action='rename_class' then
    update dal_private.classroom set name=trim(payload->>'className') where id=c.id;
    update dal_private.students set revision=revision+1 where classroom_id=c.id;
    return '{"ok":true}';
  elsif action='password' then
    if c.retry_at>now() and c.failed_logins>=10 then return jsonb_build_object('error','15분 뒤 다시 시도해 주세요.','status',429); end if;
    if c.retry_at<=now() then update dal_private.classroom set failed_logins=0,retry_at=now()+interval '15 minutes' where id=c.id; end if;
    if octet_length(coalesce(payload->>'current',''))>72 or extensions.crypt(coalesce(payload->>'current',''),c.password_hash)<>c.password_hash then
      update dal_private.classroom set failed_logins=failed_logins+1 where id=c.id;
      return jsonb_build_object('error','현재 비밀번호가 맞지 않아요.','status',400);
    end if;
    new_password:=payload->>'password';
    if length(new_password)<12 or octet_length(new_password)>72 then return jsonb_build_object('error','비밀번호는 12자 이상, UTF-8 72바이트 이하여야 해요.','status',400); end if;
    update dal_private.classroom set password_hash=extensions.crypt(new_password,extensions.gen_salt('bf',10)),failed_logins=0 where id=c.id;
    delete from dal_private.sessions where role='teacher' and classroom_id=c.id and hash<>h;
    return '{"ok":true}';
  end if;
  return jsonb_build_object('error','지원하지 않는 요청이에요.','status',404);
end $$;
revoke all on function public.dal_api(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.dal_api(text,text,jsonb) to service_role;

commit;
