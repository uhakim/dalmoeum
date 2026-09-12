'use strict';
window.DalMoon = {
  svg(phase){
    if(phase==='hidden')return '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M16 45C2 43 5 25 19 26C22 9 47 11 48 29C62 29 63 46 48 46Z" fill="#c0c8bd"/><path d="M20 52l-3 5m15-5-3 5m15-5-3 5" stroke="#a4b2a5" stroke-width="3" stroke-linecap="round"/></svg>';
    const shapes={new:'',full:'<circle cx="32" cy="32" r="26"/>',first:'<path d="M32 6A26 26 0 0 1 32 58Z"/>',last:'<path d="M32 6A26 26 0 0 0 32 58Z"/>',crescent:'<path d="M32 6A26 26 0 0 1 32 58C55 50 55 14 32 6Z"/>',old:'<path d="M32 6A26 26 0 0 0 32 58C9 50 9 14 32 6Z"/>',waxing:'<path d="M32 6A26 26 0 0 1 32 58C7 54 7 10 32 6Z"/>',waning:'<path d="M32 6A26 26 0 0 0 32 58C57 54 57 10 32 6Z"/>'};
    return '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="26" fill="#39463f"/><g fill="#f1d38b">'+(shapes[phase]||'')+'</g></svg>';
  }
};
window.DalMoon.names={new:'삭 (새달)',crescent:'초승달',first:'상현달',waxing:'차오르는 달',full:'보름달',waning:'기우는 달',last:'하현달',old:'그믐달'};
// 관측 지점은 부산(동성초등학교)으로 고정하고, 시각은 한국 표준시(UTC+9) 기준으로 계산·표시합니다.
window.DalMoon.site={name:'부산',lat:35.18,lon:129.08,offsetHours:9};
// 저정밀 궤도 요소(Schlyter)로 해와 달의 황경·황위·거리를 구합니다. 삭·망 시각 오차는 1시간 안팎, 출몰 시각 오차는 몇 분 안팎입니다.
window.DalMoon.positions=function(date){
  const rad=Math.PI/180,norm=x=>((x%360)+360)%360,d=date.getTime()/86400000-10956;
  const sun={w:282.9404+4.70935e-5*d,e:0.016709-1.151e-9*d,M:356.0470+0.9856002585*d};
  const moon={N:125.1228-0.0529538083*d,i:5.1454,w:318.0634+0.1643573223*d,e:0.054900,M:115.3654+13.0649929509*d};
  function trueAnomaly(o){let E=o.M+o.e/rad*Math.sin(o.M*rad)*(1+o.e*Math.cos(o.M*rad));for(let k=0;k<5;k++)E-=(E-o.e/rad*Math.sin(E*rad)-o.M)/(1-o.e*Math.cos(E*rad));return Math.atan2(Math.sqrt(1-o.e*o.e)*Math.sin(E*rad),Math.cos(E*rad)-o.e)/rad;}
  const sunLon=norm(trueAnomaly(sun)+sun.w);
  const v=trueAnomaly(moon),u=(v+moon.w)*rad,N=moon.N*rad,i=moon.i*rad;
  let moonLon=Math.atan2(Math.sin(N)*Math.cos(u)+Math.cos(N)*Math.sin(u)*Math.cos(i),Math.cos(N)*Math.cos(u)-Math.sin(N)*Math.sin(u)*Math.cos(i))/rad;
  let moonLat=Math.asin(Math.sin(u)*Math.sin(i))/rad;
  let distance=60.2666*(1-moon.e*moon.e)/(1+moon.e*Math.cos(v*rad));
  const Ls=sun.w+sun.M,Lm=moon.N+moon.w+moon.M,D=(Lm-Ls)*rad,F=(Lm-moon.N)*rad,Mm=moon.M*rad,Ms=sun.M*rad;
  moonLon+=-1.274*Math.sin(Mm-2*D)+0.658*Math.sin(2*D)-0.186*Math.sin(Ms)-0.059*Math.sin(2*Mm-2*D)-0.057*Math.sin(Mm-2*D+Ms)+0.053*Math.sin(Mm+2*D)+0.046*Math.sin(2*D-Ms)+0.041*Math.sin(Mm-Ms)-0.035*Math.sin(D)-0.031*Math.sin(Mm+Ms)-0.015*Math.sin(2*F-2*D)+0.011*Math.sin(Mm-4*D);
  moonLat+=-0.173*Math.sin(F-2*D)-0.055*Math.sin(Mm-F-2*D)-0.046*Math.sin(Mm+F-2*D)+0.033*Math.sin(F+2*D)+0.017*Math.sin(2*Mm+F);
  distance+=-0.58*Math.cos(Mm-2*D)-0.46*Math.cos(2*D);
  return {sunLon,moonLon:norm(moonLon),moonLat,moonDistance:distance,obliquity:23.4393-3.563e-7*d,meanSunLon:Ls};
};
window.DalMoon.phase=function(date){
  const rad=Math.PI/180,norm=x=>((x%360)+360)%360,p=window.DalMoon.positions(date);
  const elongation=norm(p.moonLon-p.sunLon),order=['new','crescent','first','waxing','full','waning','last','old'],phase=order[Math.floor(norm(elongation+22.5)/45)];
  return {phase,name:window.DalMoon.names[phase],elongation,illumination:(1-Math.cos(elongation*rad))/2};
};
// 관측 지점에서 본 해·달의 고도(도)입니다. 달은 지평 시차를 보정한 지표면 기준 고도입니다.
window.DalMoon.altitude=function(date,body,site){
  const rad=Math.PI/180,p=window.DalMoon.positions(date),lon=body==='sun'?p.sunLon:p.moonLon,lat=body==='sun'?0:p.moonLat;
  const xh=Math.cos(lon*rad)*Math.cos(lat*rad),yh=Math.sin(lon*rad)*Math.cos(lat*rad),zh=Math.sin(lat*rad),ecl=p.obliquity*rad;
  const ye=yh*Math.cos(ecl)-zh*Math.sin(ecl),ze=yh*Math.sin(ecl)+zh*Math.cos(ecl);
  const ra=Math.atan2(ye,xh),dec=Math.atan2(ze,Math.sqrt(xh*xh+ye*ye));
  const ut=((date.getTime()/86400000)%1+1)%1*24,sidereal=(p.meanSunLon+180)/15+ut+site.lon/15,hourAngle=sidereal*15*rad-ra;
  let alt=Math.asin(Math.sin(site.lat*rad)*Math.sin(dec)+Math.cos(site.lat*rad)*Math.cos(dec)*Math.cos(hourAngle));
  if(body==='moon')alt-=Math.asin(1/p.moonDistance)*Math.cos(alt);
  return alt/rad;
};
// 하루의 월출·월몰·일출·일몰과 '관찰하기 좋은 때'(달 고도 5도 이상, 해 고도 -6도 이하)를 구합니다. 날짜 경계는 한국 표준시 자정입니다.
window.DalMoon.daily=function(date,site=window.DalMoon.site){
  const HOUR=3600000,offset=site.offsetHours*HOUR,local=new Date(date.getTime()+offset);
  const start=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate())-offset,end=start+48*HOUR;
  const bisect=(test,lo,hi)=>{for(let k=0;k<22;k++){const mid=(lo+hi)/2;if(test(mid))hi=mid;else lo=mid;}return (lo+hi)/2;};
  function crossings(body,threshold){
    const above=t=>window.DalMoon.altitude(new Date(t),body,site)>threshold,events=[];let previous=above(start);
    for(let t=start+10*60000;t<=end;t+=10*60000){const current=above(t);if(current!==previous){events.push({type:current?'rise':'set',time:new Date(bisect(x=>above(x)===current,t-10*60000,t))});previous=current;}}
    return events;
  }
  const moonEvents=crossings('moon',-0.833),sunEvents=crossings('sun',-0.833);
  const moonrise=moonEvents.find(e=>e.type==='rise')?.time||null;
  const moonset=(moonrise?moonEvents.find(e=>e.type==='set'&&e.time>moonrise):moonEvents.find(e=>e.type==='set'))?.time||null;
  const today=e=>e.time.getTime()<start+24*HOUR;
  const sunrise=sunEvents.find(e=>e.type==='rise'&&today(e))?.time||null,sunset=sunEvents.find(e=>e.type==='set'&&today(e))?.time||null;
  // 오늘 낮부터 내일 낮까지 살펴 오늘 밤의 관찰 구간을 찾습니다.
  const good=t=>window.DalMoon.altitude(new Date(t),'moon',site)>=5&&window.DalMoon.altitude(new Date(t),'sun',site)<=-6,windows=[];
  let open=null,previous=good(start+12*HOUR);
  for(let t=start+12*HOUR+5*60000;t<=start+36*HOUR;t+=5*60000){const current=good(t);if(current===previous)continue;const edge=bisect(x=>good(x)===current,t-5*60000,t);if(current)open=edge;else if(open!==null){windows.push({from:new Date(open),to:new Date(edge)});open=null;}previous=current;}
  if(open!==null)windows.push({from:new Date(open),to:new Date(start+36*HOUR)});
  return {start:new Date(start),moonrise,moonset,sunrise,sunset,windows:windows.filter(w=>w.to-w.from>=20*60000)};
};
window.DalMoon.formatTime=function(time,base,site=window.DalMoon.site){
  const offset=site.offsetHours*3600000,local=new Date(time.getTime()+offset),day=new Date(base.getTime()+offset);
  const clock=String(local.getUTCHours()).padStart(2,'0')+':'+String(local.getUTCMinutes()).padStart(2,'0');
  const nextDay=local.getUTCDate()!==day.getUTCDate();
  return (nextDay?(local.getUTCHours()<6?'내일 새벽 ':'내일 '):'')+clock;
};
window.DalMoon.describe=function(date){
  const info=window.DalMoon.daily(date),base=info.start,fmt=t=>window.DalMoon.formatTime(t,base);
  const times=info.moonrise?'달 뜸 '+fmt(info.moonrise)+(info.moonset?' · 달 짐 '+fmt(info.moonset):''):info.moonset?'달 짐 '+fmt(info.moonset):'';
  const window_=info.windows.slice(0,2).map(w=>fmt(w.from)+'~'+fmt(w.to)).join(' / ');
  return {times,window:window_?'관찰하기 좋은 때 '+window_:'오늘 밤은 달을 보기 어려워요'};
};
// 첫 화면 상단에 오늘 저녁(20시 기준) 예상되는 달 모양과 부산 기준 출몰 시각, 관찰하기 좋은 때를 보여줍니다. 기록에는 어떤 값도 저장하지 않으며 실패하면 기존 장식이 그대로 남습니다.
(function(){try{
  const box=document.getElementById('today-moon');if(!box)return;
  const evening=new Date();evening.setHours(20,0,0,0);
  const today=window.DalMoon.phase(evening);if(!today.name)return;
  box.innerHTML='<span>오늘의 달</span>'+window.DalMoon.svg(today.phase)+'<strong>'+today.name+'</strong>';
  box.classList.add('today-moon');box.removeAttribute('aria-hidden');box.setAttribute('role','img');box.setAttribute('aria-label','오늘 예상되는 달 모양: '+today.name);
  const guide=window.DalMoon.describe(new Date());
  for(const [text,className] of [[guide.times,'moon-times'],[guide.window,'moon-window']]){if(!text)continue;const line=document.createElement('small');line.className=className;line.textContent=text;box.append(line);}
  box.setAttribute('aria-label','오늘 예상되는 달 모양: '+today.name+'. '+window.DalMoon.site.name+' 기준 '+[guide.times,guide.window].filter(Boolean).join('. '));
}catch(error){}})();
