import {NextResponse} from "next/server";
export const dynamic="force-dynamic";

const KEY="goofies:messages";
const URL_=process.env.UPSTASH_REDIS_REST_URL||process.env.KV_REST_API_URL;
const TOKEN=process.env.UPSTASH_REDIS_REST_TOKEN||process.env.KV_REST_API_TOKEN;
const useRedis=!!(URL_&&TOKEN);
// fallback memory store (hanya untuk development lokal, hilang saat server restart)
const mem=globalThis.__goofies||(globalThis.__goofies={list:[],rl:new Map()});

async function redis(cmd){
  const r=await fetch(URL_,{method:"POST",headers:{Authorization:`Bearer ${TOKEN}`,"Content-Type":"application/json"},body:JSON.stringify(cmd),cache:"no-store"});
  const j=await r.json();
  if(j.error)throw new Error(j.error);
  return j.result;
}
const parse=x=>{try{return typeof x==="string"?JSON.parse(x):x}catch{return null}};

async function getRaw(){return useRedis?await redis(["LRANGE",KEY,0,59]):mem.list.map(x=>JSON.stringify(x)).slice(0,60)}
async function add(item){
  if(useRedis){await redis(["LPUSH",KEY,JSON.stringify(item)]);await redis(["LTRIM",KEY,0,199])}
  else{mem.list.unshift(item);mem.list.length=Math.min(mem.list.length,200)}
}
async function limited(ip){
  if(useRedis){const ok=await redis(["SET",`goofies:rl:${ip}`,"1","EX",30,"NX"]);return ok!=="OK"}
  const now=Date.now();if(now-(mem.rl.get(ip)||0)<30000)return true;mem.rl.set(ip,now);return false;
}

export async function GET(){
  try{
    const raw=await getRaw();
    const messages=raw.map(parse).filter(Boolean);
    return NextResponse.json({messages});
  }catch(e){return NextResponse.json({messages:[],error:"storage error"},{status:500})}
}

export async function POST(req){
  try{
    const body=await req.json();
    if(body.website)return NextResponse.json({ok:true}); // honeypot: bot terdeteksi
    const type=["saran","confession"].includes(body.type)?body.type:"confession";
    const text=String(body.text||"").trim().replace(/\n{3,}/g,"\n\n");
    if(text.length<5)return NextResponse.json({error:"Pesan terlalu pendek (min 5 karakter)."},{status:400});
    if(text.length>300)return NextResponse.json({error:"Pesan terlalu panjang (maks 300 karakter)."},{status:400});
    const ip=(req.headers.get("x-forwarded-for")||"unknown").split(",")[0].trim();
    if(await limited(ip))return NextResponse.json({error:"Sabar dulu, tunggu 30 detik sebelum kirim lagi."},{status:429});
    const message={id:crypto.randomUUID(),type,text,createdAt:Date.now()};
    await add(message);
    return NextResponse.json({ok:true,message});
  }catch(e){return NextResponse.json({error:"Gagal mengirim pesan."},{status:500})}
}

// Hapus pesan (moderasi). Butuh env ADMIN_KEY dan header x-admin-key.
export async function DELETE(req){
  const key=process.env.ADMIN_KEY;
  if(!key||req.headers.get("x-admin-key")!==key)return NextResponse.json({error:"Unauthorized"},{status:401});
  try{
    const {id}=await req.json();
    if(useRedis){
      const raw=await redis(["LRANGE",KEY,0,-1]);
      const hit=raw.find(x=>parse(x)?.id===id);
      if(hit)await redis(["LREM",KEY,1,hit]);
    }else{mem.list=mem.list.filter(m=>m.id!==id)}
    return NextResponse.json({ok:true});
  }catch(e){return NextResponse.json({error:"Gagal menghapus."},{status:500})}
}
