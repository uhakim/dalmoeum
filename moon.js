'use strict';
window.DalMoon = {
  svg(phase){
    if(phase==='hidden')return '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M16 45C2 43 5 25 19 26C22 9 47 11 48 29C62 29 63 46 48 46Z" fill="#c0c8bd"/><path d="M20 52l-3 5m15-5-3 5m15-5-3 5" stroke="#a4b2a5" stroke-width="3" stroke-linecap="round"/></svg>';
    const shapes={new:'',full:'<circle cx="32" cy="32" r="26"/>',first:'<path d="M32 6A26 26 0 0 1 32 58Z"/>',last:'<path d="M32 6A26 26 0 0 0 32 58Z"/>',crescent:'<path d="M32 6A26 26 0 0 1 32 58C55 50 55 14 32 6Z"/>',old:'<path d="M32 6A26 26 0 0 0 32 58C9 50 9 14 32 6Z"/>',waxing:'<path d="M32 6A26 26 0 0 1 32 58C7 54 7 10 32 6Z"/>',waning:'<path d="M32 6A26 26 0 0 0 32 58C57 54 57 10 32 6Z"/>'};
    return '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="26" fill="#39463f"/><g fill="#f1d38b">'+(shapes[phase]||'')+'</g></svg>';
  }
};
window.DalMoon.names={new:'삭 (새달)',crescent:'초승달',first:'상현달',waxing:'차오르는 달',full:'보름달',waning:'기우는 달',last:'하현달',old:'그믐달'};
// 태양·달의 황경 차이(이각)로 위상을 구합니다. 저정밀 궤도 요소(Schlyter)를 사용하며 삭·망 시각 오차는 1시간 안팎입니다.
window.DalMoon.phase=function(date){
  const rad=Math.PI/180,norm=x=>((x%360)+360)%360,d=date.getTime()/86400000-10956;
  const sun={w:282.9404+4.70935e-5*d,e:0.016709-1.151e-9*d,M:356.0470+0.9856002585*d};
  const moon={N:125.1228-0.0529538083*d,i:5.1454,w:318.0634+0.1643573223*d,e:0.054900,M:115.3654+13.0649929509*d};
  function trueAnomaly(o){let E=o.M+o.e/rad*Math.sin(o.M*rad)*(1+o.e*Math.cos(o.M*rad));for(let k=0;k<5;k++)E-=(E-o.e/rad*Math.sin(E*rad)-o.M)/(1-o.e*Math.cos(E*rad));return Math.atan2(Math.sqrt(1-o.e*o.e)*Math.sin(E*rad),Math.cos(E*rad)-o.e)/rad;}
  const sunLon=norm(trueAnomaly(sun)+sun.w);
  const u=(trueAnomaly(moon)+moon.w)*rad,N=moon.N*rad,i=moon.i*rad;
  let moonLon=Math.atan2(Math.sin(N)*Math.cos(u)+Math.cos(N)*Math.sin(u)*Math.cos(i),Math.cos(N)*Math.cos(u)-Math.sin(N)*Math.sin(u)*Math.cos(i))/rad;
  const Ls=sun.w+sun.M,Lm=moon.N+moon.w+moon.M,D=(Lm-Ls)*rad,F=(Lm-moon.N)*rad,Mm=moon.M*rad,Ms=sun.M*rad;
  moonLon+=-1.274*Math.sin(Mm-2*D)+0.658*Math.sin(2*D)-0.186*Math.sin(Ms)-0.059*Math.sin(2*Mm-2*D)-0.057*Math.sin(Mm-2*D+Ms)+0.053*Math.sin(Mm+2*D)+0.046*Math.sin(2*D-Ms)+0.041*Math.sin(Mm-Ms)-0.035*Math.sin(D)-0.031*Math.sin(Mm+Ms)-0.015*Math.sin(2*F-2*D)+0.011*Math.sin(Mm-4*D);
  const elongation=norm(moonLon-sunLon),order=['new','crescent','first','waxing','full','waning','last','old'],phase=order[Math.floor(norm(elongation+22.5)/45)];
  return {phase,name:window.DalMoon.names[phase],elongation,illumination:(1-Math.cos(elongation*rad))/2};
};
// 첫 화면 상단에 오늘 저녁(20시 기준) 예상되는 달 모양만 보여줍니다. 기록에는 어떤 값도 저장하지 않으며 실패하면 기존 장식이 그대로 남습니다.
(function(){try{
  const box=document.getElementById('today-moon');if(!box)return;
  const evening=new Date();evening.setHours(20,0,0,0);
  const today=window.DalMoon.phase(evening);if(!today.name)return;
  box.innerHTML='<span>오늘의 달</span>'+window.DalMoon.svg(today.phase)+'<strong>'+today.name+'</strong>';
  box.classList.add('today-moon');box.removeAttribute('aria-hidden');box.setAttribute('role','img');box.setAttribute('aria-label','오늘 예상되는 달 모양: '+today.name);
}catch(error){}})();
