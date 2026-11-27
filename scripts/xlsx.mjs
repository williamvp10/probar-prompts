
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { rename, unlink } from "node:fs/promises";
import { canonical, evaluate, jsonEstricto, key, readJson } from "./core.mjs";
import { renderDashboard } from "./dashboard.mjs";

async function artifacts() {
  const require = createRequire(import.meta.url);
  const custom = process.env.PROMPT_EVAL_ARTIFACT_TOOL;
  if (custom && /\.(?:mjs|cjs|js)$/.test(custom)) return import(pathToFileURL(resolve(custom)).href);
  try {
    const entry = require.resolve("@oai/artifact-tool", {
      paths: [custom && resolve(custom), join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node"), process.cwd()]
        .filter(Boolean)
    });
    return import(pathToFileURL(entry).href);
  } catch {
    throw new Error("No se encontró @oai/artifact-tool. Usa load_workspace_dependencies y define PROMPT_EVAL_ARTIFACT_TOOL con su directorio node_modules o el archivo de entrada.");
  }
}

const rowsOf = (book, name, optional = false) => {
  const sheet = book.worksheets.items.find(item => item.name === name);
  if (!sheet) {
    if (optional) return [];
    throw new Error("Falta la hoja " + name + ".");
  }
  const [headers = [], ...rows] = sheet.getUsedRange(true)?.values ?? [];
  return rows.filter(row => row.some(value=>value !== null && value !== "" && value !== undefined))
    .map(row => Object.fromEntries(headers.map((header,i)=>[header,row[i]])));
};
const present = value => value !== null && value !== undefined && value !== "";
const embeddedJson = (value, label) => {
  if (typeof value === "number" || typeof value === "boolean") return value;
  try { return jsonEstricto(value); } catch { throw new Error("JSON inválido en " + label); }
};

export async function loadSource(path) {
  if (extname(path).toLowerCase() === ".json") return readJson(path);
  if (extname(path).toLowerCase() !== ".xlsx") throw new Error("Usa una entrada .xlsx o .json.");
  const { FileBlob, SpreadsheetFile } = await artifacts();
  const book = await SpreadsheetFile.importXlsx(await FileBlob.load(path));
  const dataset = rowsOf(book,"Dataset",true);
  const cases = dataset.length ? dataset : rowsOf(book,"Dataset");
  const checks = rowsOf(book,"Validaciones",true);
  const ambiguous = new Set();
  const known = new Set();
  for (const row of cases) {
    if (known.has(row.caso_id)) ambiguous.add(row.caso_id);
    known.add(row.caso_id);
  }
  const checkMap = new Map();
  for (const r of checks) {
    if (!known.has(r.caso_id)) throw new Error("Regla sin caso en Dataset: " + r.caso_id);
    const sourceRows = cases.filter(c=>c.caso_id===r.caso_id
      && (!present(r.dataset_id) || r.dataset_id===c.dataset_id)
      && (!present(r.version_dataset) || r.version_dataset===c.version_dataset));
    if (!sourceRows.length || (ambiguous.has(r.caso_id) && sourceRows.length !== 1)) {
      throw new Error("La fila de Validaciones para " + r.caso_id + " necesita dataset_id y version_dataset inequívocos.");
    }
    const sourceRow = sourceRows[0];
    const id=key(sourceRow.dataset_id,sourceRow.version_dataset,r.caso_id);
    const items=checkMap.get(id) ?? [];
    const rule={field:r.campo,op:r.operador};
    if (rule.op==="RUBRICA") rule.rubric=r.criterio_rubrica;
    else if (["IGUAL","UNO_DE"].includes(rule.op)) {
      rule.values=[embeddedJson(r.esperado_1_json,r.caso_id+" "+r.campo)];
      if (rule.op==="UNO_DE") rule.values.push(embeddedJson(r.esperado_2_json,r.caso_id+" "+r.campo));
    }
    items.push(rule);
    checkMap.set(id,items);
  }
  return {
    prompts:rowsOf(book,"Prompts").map(p=>({
      id:p.prompt_id,version:p.version_prompt,datasetId:p.dataset_id,datasetVersion:p.version_dataset,
      instructions:p.prompt, schema:embeddedJson(p.json_schema,p.prompt_id+" json_schema")
    })),
    cases:cases.map(c=>{
      const rules=checkMap.get(key(c.dataset_id,c.version_dataset,c.caso_id)) ?? [];
      const expected=present(c.esperado_json) ? embeddedJson(c.esperado_json,c.caso_id+" esperado_json") : undefined;
      if (present(c.n_validaciones) && Number(c.n_validaciones) !== (rules.length || Object.keys(expected ?? {}).length)) {
        throw new Error("n_validaciones no cuadra en " + c.caso_id);
      }
      return {
        id:c.caso_id,datasetId:c.dataset_id,datasetVersion:c.version_dataset,group:c.grupo,
        promptId:c.prompt_id,promptVersion:c.version_prompt,input:c.input_fuente??"",
        expected,reference:c.clave_del_caso,checks:rules
      };
    })
  };
}

const limitCell = value => typeof value === "string" && value.length > 32767
  ? value.slice(0,32670) + "… [vista truncada; original en el expediente JSON]"
  : value ?? null;
function table(sheet, headers, rows, options={}) {
  const values=[headers,...rows.map(row=>row.map(limitCell))];
  const all=sheet.getRangeByIndexes(0,0,values.length,headers.length);
  all.values=values;
  all.format.font={name:"Arial",size:10,color:"#152E49"};
  all.format.verticalAlignment="top";
  sheet.showGridLines=false;
  const header=all.getRow(0);
  header.format.fill="#102A45";
  header.format.font={name:"Arial",size:10,color:"#FFFFFF",bold:true};
  header.format.rowHeightPx=34;
  header.format.verticalAlignment="center";
  header.format.wrapText=true;
  sheet.freezePanes.freezeRows(1);
  for (const [i,caption] of headers.entries()) {
    const width=options.widths?.[caption]??Math.max(92,caption.length*7+24);
    sheet.getRangeByIndexes(0,i,1,1).format.columnWidthPx=width;
    if (rows.length && options.wrap?.includes(caption)) {
      sheet.getRangeByIndexes(1,i,rows.length,1).format.wrapText=true;
    }
  }
  if (rows.length && options.height) {
    const wrapColumns=headers.map((caption,i)=>({caption,i})).filter(({caption})=>options.wrap?.includes(caption));
    for (const [index,row] of rows.entries()) {
      const lines=wrapColumns.map(({caption,i})=>{
        const chars=Math.floor((options.widths[caption]-16)/6.9);
        return String(row[i]??"").split("\n").reduce((total,line)=>total+Math.max(1,Math.ceil(line.length/chars)),0);
      });
      const height=Math.min(190,Math.max(options.height,Math.max(1,...lines)*16+16));
      const band=sheet.getRangeByIndexes(index+1,0,1,headers.length);
      band.format.rowHeightPx=height;
      if (index%2===1) band.format.fill="#F2F7FC";
    }
  }
  if (options.comparison) {
    for (const name of options.comparison) {
      const column=headers.indexOf(name);
      sheet.getRangeByIndexes(0,column,1,1).format.fill="#0067B1";
    }
  }
}

function expectedOutput(checks) {
  const fields=checks.flatMap(rule=>{
    if (rule.op==="IGUAL") return [[rule.field,rule.values[0]]];
    if (rule.op==="UNO_DE") return [[rule.field,{uno_de:rule.values}]];
    return [];
  });
  return fields.length ? canonical(Object.fromEntries(fields)) : null;
}

function data(entries, drafts) {
  const prepared = entries.length ? entries : drafts.length ? [{ plan:{rows:drafts}, state:{responses:[],rubrics:[]} }] : [];
  const cases=[], checks=[], runs=[], groups=new Map();
  for (const {plan,state} of prepared) {
    const run=plan.run??"", variant=plan.variant??"";
    const results=evaluate(plan,state.responses,state.rubrics);
    const index=new Map(results.rows.map(row=>[row.id,row]));
    const seen=new Set();
    for (const c of plan.rows) {
      const o=index.get(c.id);
      const r=o.response;
      cases.push([c.id,c.input,r?.input_enviado ?? null,o.inputOk,expectedOutput(c.checks),r?.salida_bruta ?? null,
        o.format,o.accuracy,run ? o.result : "",run||null,variant||null,c.datasetId,c.datasetVersion,c.group,
        c.promptId,c.promptVersion,r?.modelo ?? plan.model ?? "",
        r ? (r.error !== undefined?"ERROR":"OK") : "",o.promptOk,r?.latencia_ms ?? null,
        r?.tokens_entrada ?? null,r?.tokens_salida ?? null,c.reference,o.diagnostic]);
      for (const check of o.content) {
        const expected=check.op==="IGUAL" ? canonical(check.values[0])
          : check.op==="UNO_DE" ? canonical({uno_de:check.values}) : null;
        checks.push([c.id,check.field,expected,check.obtained,run ? check.result : "",check.op,run||null,
          variant||null,c.datasetId,c.datasetVersion,check.rubric??null,check.evidence]);
      }
      if (run) {
        const record=key(run,variant,c.datasetId,c.datasetVersion,c.promptId,c.promptVersion);
        if (!seen.has(record)) {
          seen.add(record);
          runs.push([run,variant,c.datasetId,c.datasetVersion,c.promptId,c.promptVersion,
            plan.mode,plan.model,plan.created,c.datasetHash,c.prompt.hash,canonical(plan.config ?? {})]);
        }
        groups.set(key(run,variant),[run,variant]);
      }
    }
  }
  return {cases,checks,runs,groups:[...groups.values()]};
}

const reportHeaders = [
  ["Caso","Input fuente","Input enviado","Input OK","Output esperado","Output recibido","Formato","Acierto","Estado final",
    "Corrida","Variación","Dataset","Versión dataset","Grupo","Prompt","Versión prompt","Modelo","Ejecución","Prompt OK",
    "Latencia ms","Tokens entrada","Tokens salida","Comentario de la clave","Diagnóstico"],
  ["Caso","Campo","Valor esperado","Valor recibido","Resultado","Operador","Corrida","Variación","Dataset",
    "Versión dataset","Criterio de rúbrica","Evidencia"],
  ["Corrida","Variación","Dataset","Versión dataset","Prompt","Versión prompt","Modo","Modelo","Fecha UTC",
    "SHA dataset","SHA prompt","Configuración"]
];

const columnsFor = (headers, map) => Object.fromEntries(Object.entries(map).map(([key,caption])=>{
  const found=headers.indexOf(caption);
  if (found<0) throw new Error("Falta la columna del reporte: "+caption);
  return [key,String.fromCharCode(65+found)];
}));
const selectors = {run:"Corrida",variant:"Variación",dataset:"Dataset",datasetVersion:"Versión dataset"};
const dashboardColumns = {
  cases:columnsFor(reportHeaders[0],{
    ...selectors,status:"Estado final",execution:"Ejecución",format:"Formato",accuracy:"Acierto",input:"Input OK"
  }),
  checks:columnsFor(reportHeaders[1],{...selectors,status:"Resultado"}),
  caseDatasetIndex:reportHeaders[0].indexOf("Dataset"),
  caseVersionIndex:reportHeaders[0].indexOf("Versión dataset")
};

export async function writeReport(path,{ entries=[],drafts=[],preview }={}) {
  const { Workbook, SpreadsheetFile }=await artifacts();
  const w=Workbook.create();
  const dashboard=w.worksheets.add("Estadisticas");
  const tests=w.worksheets.add("Pruebas");
  const detail=w.worksheets.add("Validaciones");
  const runs=w.worksheets.add("Corridas");
  const guide=w.worksheets.add("Guia");
  const rows=data(entries,drafts);
  table(tests,reportHeaders[0],rows.cases,{
    widths:{"Caso":95,"Input fuente":220,"Input enviado":220,"Output esperado":240,"Output recibido":255,
      "Comentario de la clave":360,"Diagnóstico":340},
    wrap:["Input fuente","Input enviado","Output esperado","Output recibido","Comentario de la clave","Diagnóstico"],
    comparison:["Input fuente","Input enviado","Output esperado","Output recibido"],
    height:57
  });
  table(detail,reportHeaders[1],rows.checks,{
    widths:{"Campo":150,"Valor esperado":207,"Valor recibido":231,"Criterio de rúbrica":315,"Evidencia":400},
    wrap:["Valor esperado","Valor recibido","Criterio de rúbrica","Evidencia"],
    comparison:["Valor esperado","Valor recibido"],
    height:40
  });
  table(runs,reportHeaders[2],rows.runs);
  table(guide,["Tema","Uso"],[
    ["Estadísticas","Filtra por corrida, variación, dataset y versión. El segundo gráfico compara las últimas 20 combinaciones para el dataset y la versión elegidos."],
    ["Tasa de aprobación","Aprobados ÷ (aprobados + fallidos). API fallida y casos pendientes se muestran aparte."],
    ["Formato y acierto","El formato utiliza respuestas con veredicto de esquema. El acierto incluye los casos con un veredicto de contenido."],
    ["Pruebas","Compara el input original con el realmente enviado y la clave JSON con la salida bruta. Los comentarios y el diagnóstico están al final."],
    ["Output esperado","Contiene solo reglas que admiten valores concretos. uno_de indica alternativas. Si todo depende de rúbrica, usa Validaciones para leer sus criterios."],
    ["Validaciones","Compara los valores por campo. La rúbrica y su evidencia están al final. Los dictámenes pendientes se completan con el script."],
    ["Datos originales","El expediente JSON conserva entradas y salidas completas, incluso si una celda de Excel supera su límite de caracteres."],
    ["Iterar","Usa una nueva variación o versión y vuelve a generar el reporte desde el mismo directorio de historial."]
  ]);
  guide.getRange("B1").format.columnWidthPx=760;
  renderDashboard(dashboard,rows,dashboardColumns);
  w.recalculate();
  if (preview) {
    const image=await w.render({sheetName:"Estadisticas",range:"A1:Q44",scale:1,format:"png"});
    const {writeFile}=await import("node:fs/promises");
    await writeFile(preview,new Uint8Array(await image.arrayBuffer()));
  }
  const temp=path+"."+process.pid+".tmp.xlsx";
  try {
    const out=await SpreadsheetFile.exportXlsx(w);
    await out.save(temp);
    await rename(temp,path);
  } finally {
    for (const file of [temp,temp+".inspect.ndjson"]) {
      await unlink(file).catch(error=>{if(error.code!=="ENOENT") throw error;});
    }
  }
}
