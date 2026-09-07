import QRCode from 'npm:qrcode@1.5.4';
import {createHandler} from './handler.js';

const supabaseUrl=Deno.env.get('SUPABASE_URL')!;
const serviceKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const origin=(Deno.env.get('DAL_PUBLIC_ORIGIN')||'').replace(/\/$/,'');
Deno.serve(createHandler({origin,qr:(value:string)=>QRCode.toString(value,{type:'svg',errorCorrectionLevel:'M'}),
  async rpc(action:string,session_token:string,payload:unknown) {
    const response=await fetch(supabaseUrl+'/rest/v1/rpc/dal_api',{
      method:'POST',headers:{apikey:serviceKey,Authorization:'Bearer '+serviceKey,'Content-Type':'application/json'},
      body:JSON.stringify({action,session_token,payload}),signal:AbortSignal.timeout(25000)
    });
    if(!response.ok) {
      // Never expose database errors, keys, passwords or student payloads to logs.
      console.error('Database request failed:',response.status);
      const error=new Error('학급 저장소 요청에 실패했어요. 잠시 후 다시 시도해 주세요.');
      Object.assign(error,{status:503});throw error;
    }
    return response.json();
  }
}));
