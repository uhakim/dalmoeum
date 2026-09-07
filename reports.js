'use strict';
(async()=>{
  const $=id=>document.getElementById(id),params=new URLSearchParams(location.search);
  const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  async function api(path){const response=await DalCloud.fetch(path,{cache:'no-store'});const data=await response.json();if(!response.ok)throw Error(data.error||'기록을 불러오지 못했어요.');return data;}
  function report(state,month){
    const [year,m]=month.split('-').map(Number),first=new Date(year,m-1,1).getDay(),days=new Date(year,m,0).getDate(),total=Math.ceil((first+days)/7)*7;
    const profile=state.profile,details=[];
    let cells='';
    let lunar;try{lunar=new Intl.DateTimeFormat('ko-KR-u-ca-chinese',{month:'numeric',day:'numeric'});}catch{}
    for(let i=0;i<total;i++){
      const day=i-first+1;if(day<1||day>days){cells+='<div class="day empty"></div>';continue;}
      const date=month+'-'+String(day).padStart(2,'0'),record=state.records[date];
      cells+='<div class="day"><span class="day-number">'+day+'</span>';
      if(lunar)cells+='<span class="lunar">음 '+escape(lunar.format(new Date(year,m-1,day)))+'</span>';
      if(record){cells+=record.photo?'<img src="'+escape(record.photo)+'" alt="직접 찍은 달 사진">':DalMoon.svg(record.phase);if(record.time)cells+='<span class="day-time">'+escape(record.time)+'</span>';const note=record.note||(record.phase==='hidden'?'못 봤어요':'');if(note.length>20){details.push({date,time:record.time,note});cells+='<span class="day-note">'+escape(note.slice(0,17))+'… (뒷장)</span>';}else cells+='<span class="day-note">'+escape(note)+'</span>';}
      cells+='</div>';
    }
    const reflection=state.reflections[month]||'',longReflection=reflection.length>250||reflection.split('\n').length>4;
    const article=document.createElement('article');article.className='print-report';
    article.innerHTML='<section class="journal"><div class="journal-toolbar"><div><span class="eyebrow">MOON OBSERVATION</span><h2>달의 모양 관찰 보고서</h2></div></div><div class="print-identity"><span>'+escape(profile.className)+'</span><span>'+escape(profile.studentNumber)+'번</span><strong>'+escape(profile.studentName)+'</strong></div><div class="report-info"><div><span>관찰 주제</span><p>여러 날 동안 보이는 달의 모양 관찰하기</p></div><div><span>관찰 장소</span><p>'+escape(profile.place)+'</p></div><div><span>주의할 점</span><p>'+escape(profile.precaution)+'</p></div></div><div class="calendar-toolbar"><h3>'+year+'년 '+m+'월</h3><span class="short-row">'+Object.keys(state.records).filter(d=>d.startsWith(month)).length+'일 관찰</span></div><div class="weekdays">'+['일','월','화','수','목','금','토'].map(d=>'<span>'+d+'</span>').join('')+'</div><div class="calendar">'+cells+'</div><div class="reflection"><label>✧ 관찰하며 알게 된 점</label><p>'+escape(longReflection?'자세한 내용은 다음 장에 이어집니다.':reflection)+'</p></div><footer class="journal-footer"><span>부모님과 함께 바라본 하늘, 차곡차곡 쌓이는 발견.</span><span>달모음 ☾</span></footer></section>';
    if(details.length||longReflection){const appendix=document.createElement('section');appendix.className='report-appendix';appendix.innerHTML='<span class="eyebrow">관찰 기록 이어 보기</span><h3>'+escape(profile.className)+' · '+escape(profile.studentNumber)+'번 '+escape(profile.studentName)+' · '+year+'년 '+m+'월</h3>'+details.map(d=>'<div class="note-entry"><h4>'+escape(d.date)+' '+escape(d.time)+'</h4><p>'+escape(d.note)+'</p></div>').join('')+(longReflection?'<h4>관찰하며 알게 된 점</h4><p>'+escape(reflection)+'</p>':'');article.append(appendix);}
    return article;
  }
  try{
    const me=await api('/api/me');
    if(me.role==='student'){$('back-link').href='/';$('back-link').textContent='← 내 기록장으로';}
    if(params.has('invitations')){
      if(me.role!=='teacher')throw Error('선생님만 접속 안내 카드를 볼 수 있어요.');
      const data=await api('/api/teacher/invitations');const sheet=document.createElement('section');sheet.className='print-report link-sheet';
      sheet.innerHTML='<h2>'+escape(me.className)+' · 달모음 접속 안내</h2>'+data.students.map(s=>'<div class="invite-card"><h3>'+s.number+'번 '+escape(s.name)+'의 달 관찰 기록장</h3><p>부모님과 함께 아래 전용 주소로 접속해 주세요. 날짜를 누르고 사진이나 달 모양을 남기면 선생님이 확인하고 출력할 수 있어요.</p><img class="invite-qr" '+(DalCloud.enabled?'data-qr-src':'src')+'="/api/teacher/students/'+s.id+'/qr.svg" alt="학생 전용 접속 QR 코드"><code>'+escape(location.origin+s.path)+'</code><p>이 카드는 해당 학생 가정에만 전달해 주세요. 링크는 다른 친구에게 공유하지 않아요.</p></div>').join('');$('reports').append(sheet);$('print-info').textContent='학생별로 잘라 배부하세요. 전용 링크가 담겨 있어 전체 목록을 공유하면 안 돼요.';
      if(DalCloud.enabled)sheet.querySelectorAll('.invite-card').forEach((card,index)=>{
        const s=data.students[index],p=document.createElement('p'),strong=document.createElement('strong');
        strong.textContent=me.className+' / '+s.number+'번 / PIN '+s.pin;
        p.append(strong,document.createElement('br'),document.createTextNode(location.origin+'에서 반·번호·PIN으로 접속하세요.'));card.querySelector('h3').after(p);
      });
    }else{
      const month=params.get('month');if(!/^(19\d{2}|20\d{2}|2100)-(0[1-9]|1[0-2])$/.test(month||''))throw Error('출력할 월을 선택해 주세요.');
      let reports;
      if(me.role==='teacher'){
        if(DalCloud.enabled){
          const raw=params.get('ids')||'';
          if(!/^\d+(,\d+){0,39}$/.test(raw))throw Error('출력할 학생을 선택해 주세요.');
          reports=[];
          for(const id of new Set(raw.split(','))){const data=await api('/api/teacher/reports?'+new URLSearchParams({month,ids:id}));reports.push(...data.reports);$('print-info').textContent=reports.length+'명 기록 불러오는 중…';}
        }else{const data=await api('/api/teacher/reports?'+new URLSearchParams({month,ids:params.get('ids')||''}));reports=data.reports;}
      }
      else{const data=await api('/api/student/state');reports=[{state:data.state}];}
      reports.forEach(r=>$('reports').append(report(r.state,month)));
      $('print-info').textContent=reports.length+'명 보고서 · A4 세로 / 머리글·바닥글 끄기 · 긴 메모는 다음 장에 이어집니다.';
    }
    if(DalCloud.enabled){
      for(const img of document.querySelectorAll('.invite-qr')){
        const response=await DalCloud.fetch(img.getAttribute('data-qr-src'));
        if(!response.ok)throw Error('QR 코드를 불러오지 못했어요.');
        const blobUrl=URL.createObjectURL(await response.blob());img.src=blobUrl;
        await img.decode();URL.revokeObjectURL(blobUrl);
      }
    }
    await Promise.all(Array.from(document.images).map(img=>img.decode()));
    await document.fonts.ready;
    $('print-reports').disabled=false;document.body.dataset.ready='true';
    $('print-reports').onclick=()=>window.print();
  }catch(error){$('print-info').textContent=error.message+' 돌아가서 다시 시도해 주세요.';document.body.dataset.error='true';}
})();
