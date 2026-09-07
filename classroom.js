'use strict';
window.classroomReady = (async () => {
  if (location.protocol === 'file:') return null;
  document.body.classList.add('classroom-loading');
  const gate = document.createElement('section');
  gate.className = 'access-gate';
  gate.innerHTML = '<a class="brand" href="/">☾ 달모음</a><h1>우리 반 달 관찰 일지</h1><p>선생님에게 받은 나만의 접속 링크로 들어와 주세요.<br>링크는 다른 친구에게 공유하지 않아요.</p><form id="student-access"><label for="access-code">학생 접속 링크 또는 코드</label><input id="access-code" autocomplete="off" spellcheck="false" required><button class="primary" type="submit">내 기록장 열기</button></form><p id="access-message" role="status">접속을 확인하고 있어요…</p><a href="/teacher.html">선생님 관리 화면 →</a>';
  document.body.append(gate);
  if(DalCloud.enabled){
    gate.querySelector('p').textContent='우리 반과 번호를 고르고 선생님에게 받은 4자리 PIN을 입력해 주세요.';
    const legacy=gate.querySelector('#student-access'),details=document.createElement('details'),summary=document.createElement('summary');
    summary.textContent='기존 접속 링크로 들어가기';details.append(summary);legacy.before(details);details.append(legacy);
    const form=document.createElement('form');form.id='student-pin-access';
    form.innerHTML='<label for="student-class">우리 반</label><select id="student-class" required><option value="">반을 선택해 주세요</option></select><label for="student-number">번호</label><input id="student-number" type="number" inputmode="numeric" min="1" max="40" required placeholder="예: 7"><label for="student-pin">4자리 PIN</label><input id="student-pin" type="password" inputmode="numeric" pattern="[0-9]{4}" minlength="4" maxlength="4" autocomplete="current-password" required placeholder="선생님에게 받은 숫자 4자리"><button class="primary" type="submit">내 기록장 열기</button>';
    details.before(form);
    form.onsubmit=async event=>{
      event.preventDefault();const button=form.querySelector('button');button.disabled=true;
      try{await enter({classId:Number(document.getElementById('student-class').value),number:Number(document.getElementById('student-number').value),pin:document.getElementById('student-pin').value});}
      catch(error){document.getElementById('access-message').textContent=error.message;}
      finally{button.disabled=false;}
    };
    request('/api/classrooms').then(data=>{for(const c of data.classrooms)document.getElementById('student-class')?.add(new Option(c.name,String(c.id)));}).catch(error=>{const message=document.getElementById('access-message');if(message)message.textContent=error.message;});
  }
  let resolveLogin;
  const waitLogin = new Promise(resolve => { resolveLogin = resolve; });
  async function request(path, options = {}) {
    let response;
    try { response = await DalCloud.fetch(path, {cache: 'no-store', ...options}); }
    catch { throw Error('인터넷 연결을 확인하고 다시 시도해 주세요.'); }
    const data = await response.json().catch(() => ({error:'학급 서버에 연결하지 못했어요. 선생님에게 접속 주소를 확인해 주세요.'}));
    if (!response.ok || data.error) {const error = Error(data.error || '요청을 처리하지 못했어요.'); error.status=response.status; throw error;}
    return data;
  }
  async function enter(token) {
    await request(typeof token==='string'?'/api/auth/student':'/api/auth/student-pin', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(typeof token==='string'?{token}:token)});
    const account = await request('/api/me');
    history.replaceState(null, '', '/');
    resolveLogin(account);
    return account;
  }
  document.getElementById('student-access').onsubmit = async event => {
    event.preventDefault();
    const button=event.target.querySelector('button');button.disabled=true;
    try {let code=document.getElementById('access-code').value.trim();if(code.includes('#'))code=code.split('#').pop();await enter(code);}
    catch(error){document.getElementById('access-message').textContent=error.message;}
    finally{button.disabled=false;}
  };
  let account;
  const token = location.hash.slice(1);
  if (token) history.replaceState(null, '', location.pathname);
  try {
    account = token ? await enter(token) : await request('/api/me');
  } catch(error) {
    document.getElementById('access-message').textContent = token || error.status !== 401 ? error.message : DalCloud.enabled?'PIN을 모르면 담임선생님에게 물어보세요.':'개별 링크가 없으면 담임선생님에게 요청해 주세요.';
    account = await waitLogin;
  }
  if (account.role === 'teacher') { location.replace(DalCloud.enabled?'/teacher.html':'/teacher'); return new Promise(() => {}); }
  let stored;
  try {stored = await request('/api/student/state');}
  catch(error){document.getElementById('access-message').textContent=error.message+' 새로고침해 주세요.';return new Promise(()=>{});}
  const bar = document.createElement('div');
  bar.className='classroom-bar';
  const identity=document.createElement('strong');identity.textContent=`${account.className} · ${account.student.number}번 ${account.student.name}`;
  const status=document.createElement('span');status.id='sync-status';status.setAttribute('role','status');status.textContent='학급 저장소에 연결됨';
  const logout=document.createElement('button');logout.className='text-button';logout.textContent='나가기';
  bar.append(identity,status,logout);document.querySelector('main').prepend(bar);
  const bridge={account,state:stored.state,revision:stored.revision,unsaved:false,
    status(message,failed=false){status.textContent=message;status.classList.toggle('sync-error',failed);},
    async save(state){
      const result=await request('/api/student/state',{method:'PUT',headers:{'Content-Type':'application/json','X-CSRF-Token':account.csrf},body:JSON.stringify({state,revision:bridge.revision})});
      bridge.revision=result.revision;return result;
    }
  };
  logout.onclick=async()=>{if(bridge.unsaved){alert('저장되지 않은 내용이 있어요. 먼저 저장하거나 새로고침 전에 입력 내용을 따로 보관해 주세요.');return;}try{await request('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':account.csrf},body:'{}'});location.replace('/');}catch(error){alert(error.message);}};
  window.addEventListener('beforeunload',event=>{if(bridge.unsaved){event.preventDefault();event.returnValue='';}});
  gate.remove();document.body.classList.remove('classroom-loading');
  return bridge;
})();
