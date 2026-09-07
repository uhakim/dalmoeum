-- Add class + student number + PIN login without changing existing records/links.
begin;
select pg_advisory_xact_lock(649206907);
create function dal_private.new_pin() returns text language plpgsql volatile set search_path='' as $$
declare b bytea; n integer;
begin
  loop
    b:=extensions.gen_random_bytes(2); n:=get_byte(b,0)*256+get_byte(b,1);
    if n<60000 then return lpad((n%10000)::text,4,'0'); end if;
  end loop;
end $$;
revoke all on function dal_private.new_pin() from public,anon,authenticated,service_role;
alter table dal_private.students add column login_pin text not null default dal_private.new_pin() check(login_pin ~ '^[0-9]{4}$');
alter table dal_private.students add column pin_failures integer not null default 0 check(pin_failures between 0 and 5);

alter function public.dal_api(text,text,jsonb) rename to dal_api_links;
revoke all on function public.dal_api_links(text,text,jsonb) from public,anon,authenticated,service_role;
create function public.dal_api(action text, session_token text default '', payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare s dal_private.students; me jsonb; result jsonb; items jsonb; next_pin text;
begin
  perform pg_advisory_xact_lock(649206907);
  if action='public_classrooms' then
    select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.name) order by c.id),'[]')
      into items from dal_private.classroom c;
    return jsonb_build_object('classrooms',items);
  elsif action='login_pin' then
    if coalesce(payload->>'classId','') !~ '^[1-4]$' or coalesce(payload->>'number','') !~ '^([1-9]|[1-3][0-9]|40)$'
      or coalesce(payload->>'pin','') !~ '^[0-9]{4}$' then
      return jsonb_build_object('error','반, 번호, 4자리 PIN을 확인해 주세요.','status',400);
    end if;
    select * into s from dal_private.students where classroom_id=(payload->>'classId')::integer
      and number=(payload->>'number')::integer for update;
    if not found then return jsonb_build_object('error','반, 번호 또는 PIN이 맞지 않아요.','status',401); end if;
    if s.pin_failures>=5 then return jsonb_build_object('error','PIN 입력을 5회 틀려 잠겼어요. 선생님에게 PIN 재발급을 요청해 주세요.','status',429); end if;
    if s.login_pin<>payload->>'pin' then
      update dal_private.students set pin_failures=pin_failures+1 where id=s.id;
      if s.pin_failures=4 then return jsonb_build_object('error','PIN 입력을 5회 틀려 잠겼어요. 선생님에게 PIN 재발급을 요청해 주세요.','status',429); end if;
      return jsonb_build_object('error','반, 번호 또는 PIN이 맞지 않아요.','status',401);
    end if;
    update dal_private.students set pin_failures=0 where id=s.id;
    return public.dal_api_links('login_student','',jsonb_build_object('token',s.invitation));
  elsif action='reset_pin' then
    me:=public.dal_api_links('me',session_token,'{}');
    if me ? 'error' then return me; end if;
    if me->>'role'<>'teacher' then return jsonb_build_object('error','선생님만 사용할 수 있어요.','status',403); end if;
    select * into s from dal_private.students where id=(payload->>'id')::integer and classroom_id=(me->>'classId')::integer for update;
    if not found then return jsonb_build_object('error','학생을 찾지 못했어요.','status',404); end if;
    loop next_pin:=dal_private.new_pin(); exit when next_pin<>s.login_pin; end loop;
    update dal_private.students set login_pin=next_pin,pin_failures=0 where id=s.id;
    delete from dal_private.sessions where student_id=s.id and classroom_id=s.classroom_id;
    return jsonb_build_object('pin',next_pin,'ok',true);
  end if;
  result:=public.dal_api_links(action,session_token,payload);
  if action='invitations' and not result ? 'error' then
    me:=public.dal_api_links('me',session_token,'{}');
    select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'number',t.number,'name',t.name,
      'path','/index.html#'||t.invitation,'pin',t.login_pin,'pinLocked',t.pin_failures>=5) order by t.number),'[]')
      into items from dal_private.students t where classroom_id=(me->>'classId')::integer;
    result:=jsonb_build_object('students',items);
  end if;
  return result;
end $$;
revoke all on function public.dal_api(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.dal_api(text,text,jsonb) to service_role;
commit;
