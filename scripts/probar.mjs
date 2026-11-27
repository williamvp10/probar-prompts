#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve,dirname,join } from "node:path";
import { mkdir,readdir,rename,rm,writeFile } from "node:fs/promises";
import {
  asJsonl, atomicWrite, assertVersions, evaluate, identifier, isObject, jobs, jsonEstricto, jsonl, key, locked,
  mergeImmutable, readJson, selectPlan, sha256
} from "./core.mjs";
import { loadSource, writeReport } from "./xlsx.mjs";
import { apiBase, apiConfig, apiResponse } from "./api.mjs";

const help = `
probar-prompts · Node.js 20+

plantilla --excel ARCHIVO [--input XLSX_O_JSON]
preparar --input XLSX_O_JSON --out DIRECTORIO --corrida ID [--variacion ID]
         [--dataset ID] [--version-dataset VERSION] [--version-prompt VERSION]
         [--modo agente|api] [--modelo NOMBRE] [--parametros JSON]
evaluar --plan ARCHIVO [--respuestas JSONL] [--rubricas JSONL]
ejecutar-api --plan ARCHIVO [--limite N]
reporte --out DIRECTORIO [--excel ARCHIVO] [--preview PNG]

Agente por defecto. API: PROMPT_EVAL_API_KEY y PROMPT_EVAL_MODEL (o --modelo).
`.trim();
const options = {
  help:{type:"boolean",short:"h"},input:{type:"string"},out:{type:"string"},corrida:{type:"string"},
  variacion:{type:"string"},dataset:{type:"string"},"version-dataset":{type:"string"},"version-prompt":{type:"string"},
  modo:{type:"string"},modelo:{type:"string"},parametros:{type:"string"},plan:{type:"string"},
  respuestas:{type:"string"},rubricas:{type:"string"},excel:{type:"string"},preview:{type:"string"},limite:{type:"string"}
};
const emptyState = {responses:[],rubrics:[]};
const pathFor=(dir,name)=>join(dir,name+".json");

function verifyPlan(plan) {
  const { seal, ...snapshot } = plan;
  if (snapshot.protocol !== 1 || seal !== sha256(snapshot)) {
    throw new Error("El plan fue modificado o usa otro protocolo. Prepara una variación nueva desde la entrada.");
  }
}
function excelPath(path) {
  if (!path.toLowerCase().endsWith(".xlsx")) throw new Error("El reporte necesita extensión .xlsx.");
  return path;
}

async function history(suite) {
  const records=[];
  const runs=await readdir(suite,{withFileTypes:true});
  for (const run of runs.filter(e=>e.isDirectory()&&!e.name.startsWith("."))) {
    const runDir=join(suite,run.name);
    const versions=await readdir(runDir,{withFileTypes:true});
    for (const variant of versions.filter(e=>e.isDirectory()&&!e.name.startsWith("."))) {
      const dir=join(runDir,variant.name);
      const plan=await readJson(pathFor(dir,"plan"),null);
      if (!plan) continue;
      verifyPlan(plan);
      if (plan.run!==run.name || plan.variant!==variant.name) {
        throw new Error("El identificador del plan difiere de su carpeta: "+dir);
      }
      const state=await readJson(pathFor(dir,"registro"),emptyState);
      records.push({plan,state});
    }
  }
  return records.sort((a,b)=>a.plan.created.localeCompare(b.plan.created));
}

async function renderHistory(suite,file=join(suite,"reporte.xlsx"),preview) {
  excelPath(file);
  await mkdir(dirname(file),{recursive:true});
  await locked(suite,async()=>{
    const entries=await history(suite);
    await writeReport(file,{entries,preview});
  });
  return file;
}

async function prepare(args, required) {
  const suite=resolve(required("out"));
  const run=identifier(required("corrida"),"corrida");
  const variant=identifier(args.variacion??"base","variacion");
  const mode=args.modo??"agente";
  if (!["agente","api"].includes(mode)) throw new Error("Modo desconocido.");
  const model=args.modelo??(mode==="api"?process.env.PROMPT_EVAL_MODEL:"Agente actual");
  if (!model?.trim()) throw new Error("Define --modelo o PROMPT_EVAL_MODEL para el modo API.");
  const parameters=args.parametros?jsonEstricto(args.parametros):{};
  if (!isObject(parameters)) throw new Error("--parametros necesita un objeto JSON.");
  const config=mode==="api" ? {baseUrl:apiBase(),parameters:apiConfig(parameters),formato:"solicitado; validación local"}
    : {parameters,contexto:"agente"};
  const selected=selectPlan(await loadSource(resolve(required("input"))),{
    dataset:args.dataset,datasetVersion:args["version-dataset"],promptVersion:args["version-prompt"]
  });
  const plan={protocol:1,run,variant,mode,model,config,created:new Date().toISOString(),...selected};
  plan.seal=sha256(plan);
  await mkdir(suite,{recursive:true});
  const dir=join(suite,run,variant);
  await locked(suite,async()=>{
    const existing=await history(suite);
    assertVersions([...existing.flatMap(e=>e.plan.versions),...plan.versions]);
    if (existing.some(e=>e.plan.run===run&&e.plan.variant===variant)) throw new Error("La corrida y variación ya existen.");
    const parent=dirname(dir), staging=join(parent,".preparar-"+process.pid);
    await mkdir(parent,{recursive:true});
    await mkdir(staging);
    try {
      await writeFile(pathFor(staging,"plan"),JSON.stringify(plan,null,2)+"\n",{flag:"wx"});
      await writeFile(join(staging,"trabajos.jsonl"),asJsonl(jobs(plan)),{flag:"wx"});
      await rename(staging,dir);
    } finally { await rm(staging,{recursive:true,force:true}); }
  });
  const report=await renderHistory(suite);
  console.log(JSON.stringify({ plan:pathFor(dir,"plan"),trabajos:join(dir,"trabajos.jsonl"),reporte:report,casos:plan.rows.length }));
}

async function openPlan(path) {
  const full=resolve(path),dir=dirname(full),suite=dirname(dirname(dir));
  const plan=await readJson(full);
  verifyPlan(plan);
  if (full!==pathFor(dir,"plan") || dir!==join(suite,identifier(plan.run,"corrida"),identifier(plan.variant,"variacion"))) {
    throw new Error("Indica el plan.json original en su carpeta de corrida y variación.");
  }
  return {plan,dir,suite};
}

async function persist(current,state) {
  const result=evaluate(current.plan,state.responses,state.rubrics);
  await atomicWrite(pathFor(current.dir,"registro"),JSON.stringify(state,null,2)+"\n");
  await atomicWrite(join(current.dir,"pendientes-rubrica.jsonl"),asJsonl(result.pending));
  return result;
}

async function grade(args,required) {
  const current=await openPlan(required("plan"));
  const supplied=args.respuestas?await jsonl(resolve(args.respuestas)):[];
  const rules=args.rubricas?await jsonl(resolve(args.rubricas)):[];
  const result=await locked(current.dir,async()=>{
    const stored=await readJson(pathFor(current.dir,"registro"),emptyState);
    const state={
      responses:mergeImmutable(stored.responses,supplied,row=>row.caso_id,"respuestas"),
      rubrics:mergeImmutable(stored.rubrics,rules,row=>key(row.caso_id,row.campo),"rúbricas")
    };
    return persist(current,state);
  });
  const report=await renderHistory(current.suite);
  console.log(JSON.stringify({
    reporte:report,pendientes_rubrica:result.pending.length,casos:result.rows.length
  }));
}

async function executeApi(args,required) {
  const current=await openPlan(required("plan"));
  if (current.plan.mode!=="api") throw new Error("Prepara explícitamente una variación con --modo api.");
  const secret=process.env.PROMPT_EVAL_API_KEY;
  if (!secret) throw new Error("Define PROMPT_EVAL_API_KEY para ejecutar por API.");
  const limit=args.limite===undefined?Number.POSITIVE_INFINITY:Number(args.limite);
  if (args.limite!==undefined && (!Number.isSafeInteger(limit)||limit<1)) {
    throw new Error("--limite debe ser entero positivo.");
  }
  let attempt=0;
  try {
    await locked(current.dir,async()=>{
      const state=await readJson(pathFor(current.dir,"registro"),emptyState);
      const recorded=new Set(state.responses.map(row=>row.caso_id));
      for (const job of jobs(current.plan)) {
        if (recorded.has(job.caso_id)) continue;
        if (attempt>=limit) break;
        const response=await apiResponse(job,current.plan,secret);
        state.responses.push(response);
        attempt++;
        await persist(current,state);
      }
    });
  } finally {
    await renderHistory(current.suite);
  }
  console.log(JSON.stringify({ nuevas_respuestas:attempt,reporte:join(current.suite,"reporte.xlsx") }));
}

async function main() {
  const [command,...argv]=process.argv.slice(2);
  const {values:args}=parseArgs({args:argv,options,strict:true,allowPositionals:false});
  if (!command || ["--help","-h","ayuda"].includes(command) || args.help) { console.log(help); return; }
  const required=name=>{
    if (!args[name]) throw new Error("Falta --"+name+".");
    return args[name];
  };
  if (command==="preparar") return prepare(args,required);
  if (command==="evaluar") return grade(args,required);
  if (command==="ejecutar-api") return executeApi(args,required);
  if (command==="plantilla") {
    const path=excelPath(resolve(required("excel")));
    if (args.input && resolve(args.input)===path) throw new Error("El reporte debe guardarse en otro archivo distinto a la entrada.");
    const drafts=args.input?
      selectPlan(await loadSource(resolve(args.input)),{allowEmpty:true,dataset:args.dataset,datasetVersion:args["version-dataset"],promptVersion:args["version-prompt"]}).rows:[];
    await mkdir(dirname(path),{recursive:true});
    await writeReport(path,{drafts,preview:args.preview&&resolve(args.preview)});
    console.log(JSON.stringify({reporte:path,casos:drafts.length}));
    return;
  }
  if (command==="reporte") {
    const out=resolve(required("out"));
    const file=await renderHistory(out,args.excel&&resolve(args.excel),args.preview&&resolve(args.preview));
    console.log(JSON.stringify({reporte:file}));
    return;
  }
  throw new Error("Comando desconocido. Ejecuta --help.");
}

main().catch(error=>{console.error(error.message);process.exitCode=1;});
