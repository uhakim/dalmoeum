'use strict';
(async () => {
const classroom = await window.classroomReady;
const $ = id => document.getElementById(id);
const KEY = 'dalmoeum-v1';
const phases = [ ['new','삭 (새달)'], ['crescent','초승달'], ['first','상현달'], ['waxing','차오르는 달'], ['full','보름달'], ['waning','기우는 달'], ['last','하현달'], ['old','그믐달'], ['hidden','못 봤어요'] ];
let state = {version:1,profile:{},records:{},reflections:{}};
let storageBroken = false;
if(classroom){state=validate(classroom.state);}else{try { const raw = localStorage.getItem(KEY); if(raw) state = validate(JSON.parse(raw)); } catch { storageBroken = true; }}
const now = new Date();
let month = new Date(now.getFullYear(),now.getMonth(),1), originalDate = null, chosen = null, photo = null, photoJob = 0, toastTimer;
let savingRecord=false;
function setEditorBusy(busy){savingRecord=busy;$('record-form').querySelectorAll('input,button').forEach(control=>control.disabled=busy);}
function key(date){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;}
function monthKey(){return key(month).slice(0,7);}
function validDate(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const d=new Date(value+'T12:00:00');return !isNaN(d)&&key(d)===value&&value>='1900-01-01'&&value<='2100-12-31';}
function validate(data){
  if(!data||data.version!==1||!data.profile||!data.records||!data.reflections) throw Error('지원하지 않는 기록 파일이에요.');
  const clean={version:1,profile:{},records:{},reflections:{}};
  for(const name of ['className','studentNumber','studentName','place','precaution']){const v=data.profile[name];if(v!==undefined&&typeof v!=='string')throw Error('기록 형식을 확인해 주세요.');clean.profile[name]=(v||'').slice(0,150);}
  for(const [date,r] of Object.entries(data.records)){
    if(!validDate(date)||!r||!(r.phase===null||phases.some(p=>p[0]===r.phase))||typeof r.note!=='string'||typeof r.time!=='string'||(r.time&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time))||!(r.photo===null||typeof r.photo==='string'&&/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(r.photo)&&r.photo.length<1500000)||(!r.phase&&!r.photo))throw Error('기록 형식을 확인해 주세요.');
    clean.records[date]={phase:r.phase,note:r.note.slice(0,100),time:r.time,photo:r.photo};
  }
  for(const [m,v] of Object.entries(data.reflections)){if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)||typeof v!=='string')throw Error('기록 형식을 확인해 주세요.');clean.reflections[m]=v.slice(0,2000);}
  return clean;
}
let saveQueue=Promise.resolve(), saveTimer, waiting=[], saveConflict=false, saveSequence=0;
function persist(next, immediate=false){
  if(storageBroken){toast('기존 저장 데이터를 읽지 못했어요. 백업 파일을 불러온 뒤 다시 시도해 주세요.');return Promise.resolve(false);}
  if(!classroom){try{localStorage.setItem(KEY,JSON.stringify(next));state=next;return Promise.resolve(true);}catch{toast('저장 공간이 부족하거나 저장이 제한되어 있어요. 기록을 내보내 보관해 주세요.');return Promise.resolve(false);}}
  state=next;
  classroom.unsaved=true;
  if(saveConflict){toast('다른 기기에서 기록이 바뀌었어요. 기록 내보내기로 입력 내용을 보관하고 새로고침해 주세요.');return Promise.resolve(false);}
  classroom.status('학급 저장소에 저장 중…');
  const result=new Promise(resolve=>waiting.push(resolve));
  clearTimeout(saveTimer);
  if(immediate)flushSave();else saveTimer=setTimeout(flushSave,450);
  return result;
}
function flushSave(){
  if(!waiting.length)return;
  clearTimeout(saveTimer);
  const callbacks=waiting;waiting=[];
  const snapshot=JSON.parse(JSON.stringify(state)), sequence=++saveSequence;
  saveQueue=saveQueue.then(async()=>{
    if(saveConflict){callbacks.forEach(resolve=>resolve(false));return;}
    try{await classroom.save(snapshot);if(sequence===saveSequence&&!waiting.length){classroom.unsaved=false;classroom.status('학급 저장소에 저장 완료');}callbacks.forEach(resolve=>resolve(true));}
    catch(error){if(error.status===409)saveConflict=true;classroom.unsaved=true;classroom.status('저장되지 않음 · 연결 확인 후 다시 저장',true);toast(error.message);callbacks.forEach(resolve=>resolve(false));}
  });
}
function toast(message){$('toast').textContent=message;$('toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),4500);}
function moonSvg(phase){
  if(phase==='hidden')return '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M16 45C2 43 5 25 19 26C22 9 47 11 48 29C62 29 63 46 48 46Z" fill="#c0c8bd"/><path d="M20 52l-3 5m15-5-3 5m15-5-3 5" stroke="#a4b2a5" stroke-width="3" stroke-linecap="round"/></svg>';
  let shape='';const gold='#f1d38b';
  if(phase==='full')shape='<circle cx="32" cy="32" r="26"/>';
  if(phase==='first')shape='<path d="M32 6A26 26 0 0 1 32 58Z"/>';
  if(phase==='last')shape='<path d="M32 6A26 26 0 0 0 32 58Z"/>';
  if(phase==='crescent')shape='<path d="M32 6A26 26 0 0 1 32 58C55 50 55 14 32 6Z"/>';
  if(phase==='old')shape='<path d="M32 6A26 26 0 0 0 32 58C9 50 9 14 32 6Z"/>';
  if(phase==='waxing')shape='<path d="M32 6A26 26 0 0 1 32 58C7 54 7 10 32 6Z"/>';
  if(phase==='waning')shape='<path d="M32 6A26 26 0 0 0 32 58C57 54 57 10 32 6Z"/>';
  return `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="26" fill="#39463f"/><g fill="${gold}">${shape}</g></svg>`;
}
let lunar;try{lunar=new Intl.DateTimeFormat('ko-KR-u-ca-chinese',{month:'numeric',day:'numeric'});}catch{}
function render(){
  $('month-title').textContent=`${month.getFullYear()}년 ${month.getMonth()+1}월`;
  $('prev').disabled=month.getFullYear()===1900&&month.getMonth()===0;$('next').disabled=month.getFullYear()===2100&&month.getMonth()===11;
  $('calendar').replaceChildren();
  const start=month.getDay(),days=new Date(month.getFullYear(),month.getMonth()+1,0).getDate(),total=Math.ceil((start+days)/7)*7;
  for(let i=0;i<total;i++){
    const day=i-start+1;if(day<1||day>days){const blank=document.createElement('div');blank.className='day empty';$('calendar').append(blank);continue;}
    const date=new Date(month.getFullYear(),month.getMonth(),day),dateKey=key(date),record=state.records[dateKey],button=document.createElement('button');button.className='day'+(dateKey===key(now)?' is-today':'');
    const name=phases.find(p=>p[0]===record?.phase)?.[1]||'';
    button.setAttribute('aria-label',`${month.getMonth()+1}월 ${day}일, ${record?(record.photo?'사진 기록':name):'기록하기'}`);
    const num=document.createElement('span');num.className='day-number';num.textContent=day;button.append(num);
    if(lunar){const label=document.createElement('span');label.className='lunar';label.textContent='음 '+lunar.format(date);button.append(label);}
    if(record){if(record.photo){const img=document.createElement('img');img.src=record.photo;img.alt='직접 찍은 달 사진';button.append(img);}else{button.insertAdjacentHTML('beforeend',moonSvg(record.phase));}
      if(record.time){const time=document.createElement('span');time.className='day-time';time.textContent=record.time;button.append(time);}
      if(record.note||record.phase==='hidden'){const note=document.createElement('span');note.className='day-note';note.textContent=record.note||'못 봤어요';button.append(note);}
    }else{const add=document.createElement('span');add.className='add-mark';add.textContent='+';button.append(add);}
    button.addEventListener('click',()=>openEditor(dateKey));$('calendar').append(button);
  }
  $('record-count').textContent=Object.keys(state.records).filter(d=>d.startsWith(monthKey())).length;
  $('learned').value=state.reflections[monthKey()]||'';$('printed-learned').textContent=$('learned').value;
}
function loadProfile(){for(const id of ['className','studentNumber','studentName','place','precaution'])$(id).value=state.profile[id]||'';}
for(const id of ['className','studentNumber','studentName','place','precaution'])$(id).addEventListener('input',()=>persist({...state,profile:{...state.profile,[id]:$(id).value}}));
$('learned').addEventListener('input',async()=>{const value=$('learned').value;if(await persist({...state,reflections:{...state.reflections,[monthKey()]:value}}))$('printed-learned').textContent=value;});
$('prev').onclick=()=>{month=new Date(month.getFullYear(),month.getMonth()-1,1);render();};
$('next').onclick=()=>{month=new Date(month.getFullYear(),month.getMonth()+1,1);render();};
$('today').onclick=()=>{month=new Date(now.getFullYear(),now.getMonth(),1);render();};
$('record-today').onclick=()=>openEditor(key(new Date()));
$('print').onclick=async()=>{if(classroom){flushSave();await saveQueue;if(classroom.unsaved){toast('저장되지 않은 내용이 있어요. 연결을 확인하고 다시 저장해 주세요.');return;}location.href='/reports?month='+monthKey();}else window.print();};
for(const [id,name] of phases){const button=document.createElement('button');button.type='button';button.className='phase';button.dataset.phase=id;button.innerHTML=moonSvg(id);const label=document.createElement('span');label.textContent=name;button.append(label);button.onclick=()=>{chosen=id;updatePhases();};$('phases').append(button);}
function updatePhases(){document.querySelectorAll('.phase').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.phase===chosen)));}
function updatePhoto(){$('photo-preview').hidden=!photo;$('preview-image').src=photo||'';}
function openEditor(date){const r=state.records[date];originalDate=r?date:null;chosen=r?.phase||null;photo=r?.photo||null;$('record-date').value=date;$('record-time').value=r?r.time:(date===key(new Date())?new Date().toTimeString().slice(0,5):'');$('record-note').value=r?.note||'';$('editor-title').textContent=`${Number(date.slice(5,7))}월 ${Number(date.slice(8))}일의 달`;$('delete-record').hidden=!r;$('camera').value='';$('photo-file').value='';updatePhases();updatePhoto();$('editor').showModal();}
$('close-editor').onclick=()=>$('editor').close();
$('editor').addEventListener('cancel',event=>{if(savingRecord)event.preventDefault();});
$('editor').addEventListener('close',()=>{photoJob++;$('save-record').disabled=false;});
$('remove-photo').onclick=()=>{photoJob++;photo=null;$('save-record').disabled=false;updatePhoto();};
async function readPhoto(event){const file=event.target.files[0];if(!file)return;const job=++photoJob;$('save-record').disabled=true;
  try{if(file.size>30*1024*1024)throw Error('30MB 이하의 사진을 선택해 주세요.');const url=URL.createObjectURL(file);const img=new Image();try{img.src=url;await img.decode();const scale=Math.min(1,640/Math.max(img.width,img.height));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);if(job===photoJob){photo=canvas.toDataURL('image/jpeg',.78);updatePhoto();}}finally{URL.revokeObjectURL(url);}}
  catch(err){if(job===photoJob)toast(err.message.includes('30MB')?err.message:'이 사진을 읽지 못했어요. JPG 또는 PNG 사진을 선택해 주세요.');}
  finally{if(job===photoJob)$('save-record').disabled=false;event.target.value='';}
}
$('camera').onchange=readPhoto;$('photo-file').onchange=readPhoto;
$('record-form').onsubmit=async event=>{event.preventDefault();if(savingRecord)return;const date=$('record-date').value;if(!validDate(date)){toast('올바른 관찰 날짜를 선택해 주세요.');return;}if(!chosen&&!photo){toast('달 모양을 고르거나 사진을 넣어 주세요.');return;}if(state.records[date]&&date!==originalDate&&!confirm('이 날짜에 기록이 있어요. 새 기록으로 바꿀까요?'))return;const records={...state.records};if(originalDate&&date!==originalDate)delete records[originalDate];records[date]={phase:chosen,photo,time:$('record-time').value,note:$('record-note').value.trim()};setEditorBusy(true);const saved=await persist({...state,records},true);setEditorBusy(false);if(saved){$('editor').close();month=new Date(Number(date.slice(0,4)),Number(date.slice(5,7))-1,1);render();toast(classroom?'학급 저장소에 기록했어요. 선생님도 볼 수 있어요.':'오늘의 발견을 저장했어요.');}};
$('delete-record').onclick=async()=>{if(savingRecord||!originalDate||!confirm('이 날짜의 관찰 기록을 삭제할까요?'))return;const records={...state.records};delete records[originalDate];setEditorBusy(true);const saved=await persist({...state,records},true);setEditorBusy(false);if(saved){$('editor').close();render();toast('기록을 삭제했어요.');}};
$('backup').onclick=()=>{const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`달모음-기록-${key(new Date())}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('기록 파일을 내려받았어요. 안전한 곳에 보관해 주세요.');};
$('restore').onclick=()=>$('backup-file').click();
$('backup-file').onchange=async event=>{const file=event.target.files[0];if(!file)return;try{if(file.size>20*1024*1024)throw Error('20MB 이하의 기록 파일을 선택해 주세요.');const imported=validate(JSON.parse(await file.text()));if(!confirm('불러온 파일로 현재의 모든 기록을 바꿀까요? 기존 기록이 필요하면 먼저 내보내 주세요.'))return;const wasBroken=storageBroken;storageBroken=false;if(classroom){for(const field of ['className','studentNumber','studentName'])imported.profile[field]=state.profile[field];}if(await persist(imported,true)){loadProfile();render();toast('기록을 불러왔어요.');}else storageBroken=wasBroken;}catch(err){toast(err instanceof SyntaxError?'달모음에서 내보낸 JSON 파일을 선택해 주세요.':err.message);}finally{event.target.value='';}};
loadProfile();render();if(storageBroken){$('storage-note').textContent='저장된 기록을 읽지 못했어요. 기존 데이터 보호를 위해 저장을 멈췄어요. 달모음 백업 파일을 불러와 복구해 주세요.';toast('저장된 기록을 읽지 못했어요. 백업 파일을 확인해 주세요.');}
if(classroom){for(const field of ['className','studentNumber','studentName'])$(field).readOnly=true;$('storage-note').textContent='기록은 우리 반 학급 저장소에 저장돼요. 같은 전용 링크로 다른 휴대폰에서도 이어 쓸 수 있고, 담임선생님이 확인하고 출력할 수 있어요. 다른 친구에게는 접속 링크를 공유하지 마세요.';const retry=document.createElement('button');retry.className='text-button';retry.textContent='저장 다시 시도';retry.onclick=()=>persist(state,true);$('storage-note').after(retry);}
})();
