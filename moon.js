'use strict';
window.DalMoon = {
  svg(phase){
    if(phase==='hidden')return '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M16 45C2 43 5 25 19 26C22 9 47 11 48 29C62 29 63 46 48 46Z" fill="#c0c8bd"/><path d="M20 52l-3 5m15-5-3 5m15-5-3 5" stroke="#a4b2a5" stroke-width="3" stroke-linecap="round"/></svg>';
    const shapes={new:'',full:'<circle cx="32" cy="32" r="26"/>',first:'<path d="M32 6A26 26 0 0 1 32 58Z"/>',last:'<path d="M32 6A26 26 0 0 0 32 58Z"/>',crescent:'<path d="M32 6A26 26 0 0 1 32 58C55 50 55 14 32 6Z"/>',old:'<path d="M32 6A26 26 0 0 0 32 58C9 50 9 14 32 6Z"/>',waxing:'<path d="M32 6A26 26 0 0 1 32 58C7 54 7 10 32 6Z"/>',waning:'<path d="M32 6A26 26 0 0 0 32 58C57 54 57 10 32 6Z"/>'};
    return '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="26" fill="#39463f"/><g fill="#f1d38b">'+(shapes[phase]||'')+'</g></svg>';
  }
};
