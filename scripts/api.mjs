
import { performance } from "node:perf_hooks";
import { isObject } from "./core.mjs";

export function apiBase(value=process.env.PROMPT_EVAL_API_BASE_URL || "https://api.openai.com/v1") {
  const address=new URL(value);
  const localhost=["127.0.0.1","localhost","[::1]"].includes(address.hostname);
  if (!(address.protocol==="https:" || (address.protocol==="http:" && localhost))
      || address.username || address.password || address.search || address.hash) {
    throw new Error("Usa una URL HTTPS sin credenciales ni parámetros. HTTP se reserva a loopback.");
  }
  return address.href.replace(/\/+$/,"");
}

export function apiConfig(values) {
  if (!isObject(values)) throw new Error("La configuración API debe ser un objeto JSON.");
  const options=new Set(["temperature","top_p","seed","max_completion_tokens","reasoning_effort"]);
  for (const option of Object.keys(values)) {
    if (!options.has(option)) throw new Error("Parámetro API no admitido: " + option);
    const v=values[option];
    if (option==="reasoning_effort" ? (typeof v!=="string" || !v.trim()) : !Number.isFinite(v)) {
      throw new Error("Valor API inválido para " + option);
    }
    if (option==="max_completion_tokens" && (!Number.isInteger(v) || v<1)) {
      throw new Error("max_completion_tokens debe ser un entero positivo.");
    }
  }
  return values;
}

export async function apiResponse(job,plan,secret) {
  const fields={
    caso_id:job.caso_id,input_enviado:job.input,prompt_id:job.prompt_id,
    version_prompt:job.version_prompt,prompt_sha256:job.prompt_sha256
  };
  const started=performance.now();
  let res;
  try {
    res=await fetch(apiBase(plan.config.baseUrl)+"/chat/completions",{
      method:"POST",redirect:"error",signal:AbortSignal.timeout(90000),
      headers:{"content-type":"application/json","authorization":"Bearer "+secret},
      body:JSON.stringify({
        ...apiConfig(plan.config.parameters),model:plan.model,messages:[
          {role:"system",content:job.instrucciones+"\n\nDevuelve únicamente un objeto JSON conforme al esquema:\n"+JSON.stringify(job.esquema)},
          {role:"user",content:job.input}
        ]
      })
    });
  } catch {
    throw new Error("Solicitud interrumpida o sin conexión. Corrige la conexión antes de continuar.");
  }
  const latency=Math.round(performance.now()-started);
  if (!res.ok) {
    if ([400,401,403,404,422,429].includes(res.status) || res.status>=500) {
      throw new Error("API HTTP " + res.status + ". Se detuvo la corrida. Las respuestas guardadas se conservan.");
    }
    return {...fields,error:"API HTTP "+res.status,latencia_ms:latency};
  }
  let answer;
  try { answer=await res.json(); } catch { throw new Error("La API no devolvió el contrato de Chat Completions."); }
  const option=answer?.choices?.[0];
  const content=option?.message?.content;
  const usage=answer?.usage;
  const details={
    latencia_ms:latency,modelo:typeof answer?.model==="string"?answer.model:plan.model,
    ...(Number.isFinite(usage?.prompt_tokens)?{ tokens_entrada:usage.prompt_tokens }:{}),
    ...(Number.isFinite(usage?.completion_tokens)?{ tokens_salida:usage.completion_tokens }:{})
  };
  if (option?.message?.refusal || !["stop","length",undefined].includes(option?.finish_reason) || typeof content!=="string") {
    return {...fields,...details,error:"La API no entregó una respuesta textual evaluable."};
  }
  return {...fields,...details,salida_bruta:content};
}
