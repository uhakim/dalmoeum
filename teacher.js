'use strict';
(() => {
  const $=id=>document.getElementById(id);
  if(DalCloud.enabled){
    const label=document.createElement('label');label.htmlFor='teacher-username';label.textContent='관리 계정';
    const select=document.createElement('select');select.id='teacher-username';select.name='username';select.autocomplete='username';
    for(let i=1;i<=4;i++){const option=document.createElement('option');option.value='teacher'+i;option.textContent='관리자 '+i+' (teacher'+i+')';select.append(option);}
    $('login-form').prepend(label,select);
  }
  let account, students=[], selected=new Set(), loadSequence=0, inviteStudent=null, editTarget=null, toastTimer;
  const now=new Date();$('report-month').value=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  function toast(message){$('toast').textContent=message;$('toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),4500);}
  async function api(path,method='GET',body){
    let response;
    try{response=await DalCloud.fetch(path,{method,cache:'no-store',headers:{'Content-Type':'application/json',...(account?{'X-CSRF-Token':account.csrf}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
    catch{throw Error('인터넷 연결을 확인하고 다시 시도해 주세요.');}
    const data=await response.json().catch(()=>({error:'학급 서버를 먼저 실행하거나 배포된 주소로 접속해 주세요.'}));
    if(!response.ok){if(response.status===401&&account){showLogin();throw Error('로그인 시간이 끝났어요. 다시 로그인해 주세요.');}throw Error(data.error||'요청에 실패했어요.');}
    return data;
  }
  function showLogin(){$('teacher-app').hidden=true;$('teacher-login').hidden=false;$('roster').replaceChildren();students=[];account=null;document.querySelectorAll('dialog[open]').forEach(d=>d.close());$('invite-link').value='';}
  async function enter(){account=await api('/api/me');if(account.role!=='teacher'){showLogin();throw Error('학생으로 접속 중이에요. 선생님 비밀번호로 로그인해 주세요.');}$('teacher-login').hidden=true;$('teacher-app').hidden=false;await loadRoster(true);}
  $('login-form').onsubmit=async event=>{event.preventDefault();$('login-button').disabled=true;$('login-error').textContent='';try{await api('/api/auth/teacher','POST',{password:$('teacher-password').value,...(DalCloud.enabled?{username:$('teacher-username').value}:{})});$('teacher-password').value='';await enter();}catch(error){$('login-error').textContent=error.message;}finally{$('login-button').disabled=false;}};
  async function loadRoster(selectAll=false){
    const sequence=++loadSequence;
    $('teacher-status').textContent='불러오는 중…';$('print-selected').disabled=true;
    try{const result=await api('/api/teacher/students?month='+encodeURIComponent($('report-month').value));if(sequence!==loadSequence)return;students=result.students;account.className=result.className;$('class-title').textContent=result.className+' 달 관찰';if(selectAll)selected=new Set(students.map(s=>s.id));else selected=new Set([...selected].filter(id=>students.some(s=>s.id===id)));render();$('teacher-status').textContent='방금 갱신됨';}
    catch(error){if(sequence!==loadSequence)return;$('teacher-status').textContent='불러오지 못했어요';toast(error.message);}
  }
  function selection(){const count=students.filter(s=>selected.has(s.id)).length;$('print-selected').textContent=`선택한 ${count}명 출력`;$('print-selected').disabled=count===0;$('select-all').checked=count===students.length&&count>0;$('select-all').indeterminate=count>0&&count<students.length;}
  function button(label,action){const b=document.createElement('button');b.textContent=label;b.onclick=action;return b;}
  function render(){
    $('total-students').textContent=students.length;$('active-students').textContent=students.filter(s=>s.days>0).length;$('total-records').textContent=students.reduce((n,s)=>n+s.days,0);$('roster').replaceChildren();
    for(const student of students){
      const row=document.createElement('tr');const checkCell=document.createElement('td');const check=document.createElement('input');check.type='checkbox';check.checked=selected.has(student.id);check.setAttribute('aria-label',`${student.number}번 ${student.name} 선택`);check.onchange=()=>{check.checked?selected.add(student.id):selected.delete(student.id);selection();};checkCell.append(check);row.append(checkCell);
      const number=document.createElement('td');number.textContent=student.number;row.append(number);
      const name=document.createElement('td');name.className='student-name';name.append(document.createTextNode(student.name));name.append(button('수정',()=>openName(student)));row.append(name);
      const count=document.createElement('td'),pill=document.createElement('span');pill.className='status-pill'+(student.days?'':' empty');pill.textContent=student.days?`${student.days}일 관찰 · 사진 ${student.photos}장`:'아직 기록 없음';count.append(pill);row.append(count);
      const last=document.createElement('td');last.textContent=student.lastDate||'—';row.append(last);
      const reflection=document.createElement('td');reflection.textContent=student.hasReflection?'작성함':'—';row.append(reflection);
      const actions=document.createElement('td'),group=document.createElement('div');group.className='row-actions';group.append(button('보고서',()=>openReports([student.id])),button('접속 링크',()=>openInvitation(student)));actions.append(group);row.append(actions);$('roster').append(row);
    }
    $('roster-message').hidden=students.length>0;selection();
  }
  function openReports(ids){const query=new URLSearchParams({month:$('report-month').value,ids:ids.join(',')});window.open((DalCloud.enabled?'/reports.html?':'/reports?')+query,'_blank','noopener');}
  $('select-all').onchange=()=>{selected=$('select-all').checked?new Set(students.map(s=>s.id)):new Set();render();};
  $('print-selected').onclick=()=>openReports([...selected]);
  $('report-month').onchange=()=>loadRoster();$('refresh-roster').onclick=()=>loadRoster();
  $('teacher-logout').onclick=async()=>{try{await api('/api/auth/logout','POST',{});showLogin();}catch(error){toast(error.message);}};
  function openName(student=null){editTarget=student;$('name-title').textContent=student?`${student.number}번 학생 이름`:'학급 이름';$('new-name').value=student?student.name:account.className;$('name-dialog').showModal();$('new-name').select();}
  $('edit-class').onclick=()=>openName();$('close-name').onclick=()=>$('name-dialog').close();
  $('name-form').onsubmit=async event=>{event.preventDefault();const b=event.target.querySelector('[type=submit]');b.disabled=true;try{if(editTarget)await api('/api/teacher/students/'+editTarget.id,'PATCH',{name:$('new-name').value.trim()});else await api('/api/teacher/classroom','PATCH',{className:$('new-name').value.trim()});$('name-dialog').close();await loadRoster();toast('이름을 저장했어요.');}catch(error){toast(error.message);}finally{b.disabled=false;}};
  async function openInvitation(student){try{const result=await api('/api/teacher/invitations');const invitation=result.students.find(s=>s.id===student.id);if(!invitation)throw Error('학생을 찾지 못했어요.');inviteStudent=student;$('invite-title').textContent=`${student.number}번 ${student.name} 접속 링크`;$('invite-link').value=location.origin+invitation.path;$('invite-dialog').showModal();}catch(error){toast(error.message);}}
  $('close-invite').onclick=()=>$('invite-dialog').close();
  $('copy-invite').onclick=async()=>{try{await navigator.clipboard.writeText($('invite-link').value);toast('링크를 복사했어요. 해당 학생 가정에 전달해 주세요.');}catch{$('invite-link').select();toast('링크를 길게 누르거나 Ctrl+C로 복사해 주세요.');}};
  $('reset-invite').onclick=async()=>{if(!inviteStudent||!confirm('이 학생의 기존 링크와 로그인을 해제하고 새 링크를 발급할까요? 기록은 유지됩니다.'))return;try{const result=await api('/api/teacher/students/'+inviteStudent.id+'/reset-link','POST',{});$('invite-link').value=location.origin+result.path;toast('새 링크를 발급했어요. 해당 가정에 다시 전달해 주세요.');}catch(error){toast(error.message);}};
  $('invitation-sheet').onclick=()=>window.open(DalCloud.enabled?'/reports.html?invitations=1':'/reports?invitations=1','_blank','noopener');
  $('class-backup').onclick=async()=>{const b=$('class-backup');b.disabled=true;try{const response=await DalCloud.backup();if(!response.ok)throw Error('백업에 실패했어요. 로그인을 확인하고 다시 시도해 주세요.');const url=URL.createObjectURL(await response.blob()),a=document.createElement('a');a.href=url;a.download='달모음-학급전체-'+new Date().toISOString().slice(0,10)+DalCloud.backupExtension;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('학급 기록과 사진을 백업했어요. 안전한 곳에 보관해 주세요.');}catch(error){toast(error.message);}finally{b.disabled=false;}};
  $('change-password').onclick=()=>{$('password-form').reset();$('password-dialog').showModal();};$('close-password').onclick=()=>$('password-dialog').close();
  $('password-form').onsubmit=async event=>{event.preventDefault();if($('new-password').value!==$('confirm-password').value){toast('새 비밀번호가 서로 달라요.');return;}try{await api('/api/teacher/password','POST',{current:$('current-password').value,password:$('new-password').value});$('password-dialog').close();$('password-form').reset();toast('비밀번호를 바꾸고 다른 선생님 로그인을 해제했어요.');}catch(error){toast(error.message);}};
  if(location.protocol==='file:')$('login-error').textContent='학급 기능은 웹서버가 필요해요. 운영 안내의 실행 방법을 확인해 주세요.';
  else enter().catch(error=>{if(!error.message.includes('로그인이 필요'))$('login-error').textContent=error.message;});
})();
