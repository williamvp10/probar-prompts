import { createHash } from "node:crypto";
import { readFile, rename, writeFile, open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { visit } from "jsonc-parser";

const validator = addFormats(new Ajv({ allErrors: true, strict: true, validateFormats: true, addUsedSchema: false }));
const statuses = { OK: "OK", FALLO: "FALLO", PENDIENTE: "PENDIENTE" };

export function jsonEstricto(raw) {
  const data = JSON.parse(raw);
  let duplicate;
  const objects = [];
  visit(raw, {
    onObjectBegin() { objects.push(new Set()); },
    onObjectProperty(key) {
      const current = objects.at(-1);
      if (current.has(key)) duplicate = key;
      current.add(key);
    },
    onObjectEnd() { objects.pop(); },
    onLiteralValue(value) {
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new Error("Número fuera del rango numérico interoperable");
      }
    }
  }, { disallowComments: true, allowTrailingComma: false });
  if (duplicate !== undefined) throw new Error("Clave JSON duplicada: " + duplicate);
  return data;
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
  }
  return value;
}
export const canonical = value => JSON.stringify(sorted(value));
export const sha256 = value => createHash("sha256").update(canonical(value), "utf8").digest("hex");
export const key = (...fields) => JSON.stringify(fields);
const compile = schema => validator.compile(schema);
export const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

export function identifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/.test(value)
      || ["todas", "todos", "historial"].includes(value.toLowerCase())) {
    throw new Error(label + " debe ser un identificador ASCII de hasta 60 caracteres (letras, números, . _ -).");
  }
  return value;
}

function text(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Falta " + label);
  return value;
}

export function unique(items, getKey, label) {
  const index = new Map();
  for (const item of items) {
    const id = getKey(item);
    if (index.has(id)) throw new Error("Duplicado en " + label + ": " + id);
    index.set(id, item);
  }
  return index;
}

const fromExpected = expected => Object.entries(expected ?? {}).map(([field, value]) =>
  isObject(value) && Object.hasOwn(value, "uno_de")
    ? { field, op: "UNO_DE", values: value.uno_de }
    : { field, op: "IGUAL", values: [value] }
);

export function normalize(source) {
  if (!Array.isArray(source?.prompts) || !Array.isArray(source?.cases)) {
    throw new Error("La entrada necesita arreglos prompts y cases.");
  }
  const prompts = source.prompts.map(p => {
    for (const name of ["id", "version", "datasetId", "datasetVersion"]) identifier(p[name], "Prompt." + name);
    text(p.instructions, "instrucciones del prompt");
    if (!isObject(p.schema)) throw new Error("El prompt " + p.id + " necesita un JSON Schema de objeto.");
    compile(p.schema);
    return {
      id: p.id, version: p.version, datasetId: p.datasetId, datasetVersion: p.datasetVersion,
      instructions: p.instructions, schema: p.schema, hash: sha256([p.instructions, p.schema])
    };
  });
  unique(prompts, p => key(p.id, p.version, p.datasetId, p.datasetVersion), "Prompts");
  assertVersions(prompts.map(p => [key("prompt", p.id, p.version), p.hash]));
  const cases = source.cases.map(c => {
    for (const name of ["id", "datasetId", "datasetVersion", "promptId", "promptVersion"]) identifier(c[name], "Caso." + name);
    if (typeof c.input !== "string") throw new Error("El input debe ser texto, incluso vacío: " + c.id);
    const group = c.group || "Sin grupo";
    if (typeof group !== "string") throw new Error("Grupo no textual: " + c.id);
    if (c.expected != null && !isObject(c.expected)) throw new Error("esperado_json debe ser un objeto: " + c.id);
    const checks = (c.checks?.length ? c.checks : fromExpected(c.expected)).map(rule => {
      text(rule.field, "campo de " + c.id);
      if (rule.op === "RUBRICA") {
        return { field: rule.field, op: rule.op, rubric: text(rule.rubric, "criterio de " + rule.field) };
      }
      if (!["IGUAL", "UNO_DE"].includes(rule.op) || !Array.isArray(rule.values)
          || (rule.op === "IGUAL" ? rule.values.length !== 1 : rule.values.length < 2)) {
        throw new Error("Regla inválida: " + c.id + " / " + rule.field);
      }
      return {
        field: rule.field, op: rule.op, values: rule.values,
        unordered: rule.unordered ?? rule.field === "campos_revisar"
      };
    });
    if (!checks.length) throw new Error("Falta una clave o regla explícita para " + c.id);
    unique(checks, rule => rule.field, "validaciones de " + c.id);
    return {
      id:c.id, datasetId:c.datasetId, datasetVersion:c.datasetVersion, promptId:c.promptId,
      promptVersion:c.promptVersion, group, input:c.input, checks,
      reference: typeof c.reference === "string" ? c.reference : ""
    };
  });
  unique(cases, c => key(c.datasetId, c.datasetVersion, c.id), "Dataset");
  return { prompts, cases };
}

export function selectPlan(source, opts) {
  const { prompts, cases } = normalize(source);
  const datasetKeys = new Set(cases.filter(c => !opts.dataset || c.datasetId === opts.dataset)
    .filter(c => !opts.datasetVersion || c.datasetVersion === opts.datasetVersion)
    .map(c => key(c.datasetId,c.datasetVersion)));
  if (opts.promptVersion && datasetKeys.size !== 1) {
    throw new Error("--version-prompt exige seleccionar exactamente una versión de un dataset.");
  }
  const rows = cases.filter(c => datasetKeys.has(key(c.datasetId,c.datasetVersion))).map(c => {
    const matches = prompts.filter(p => p.id === c.promptId && p.datasetId === c.datasetId
      && p.datasetVersion === c.datasetVersion && p.version === (opts.promptVersion ?? c.promptVersion));
    if (matches.length !== 1) throw new Error("Falta un prompt aplicable a " + c.id + " (" + c.promptId + ").");
    const item = { ...c, promptVersion: matches[0].version, prompt: matches[0] };
    return item;
  });
  if (!rows.length && !opts.allowEmpty) throw new Error("La selección no contiene casos.");
  unique(rows, c => c.id, "caso_id de la selección");
  const versions = [];
  for (const datasetKey of datasetKeys) {
    const group = rows.filter(c => key(c.datasetId,c.datasetVersion) === datasetKey);
    const frozen = group.map(({id, group, input, reference, checks}) =>
      [id,group,input,reference,[...checks].sort((a,b)=>a.field.localeCompare(b.field,"en"))]
    ).sort((a,b)=>a[0].localeCompare(b[0],"en"));
    const hash = sha256(frozen);
    for (const row of group) row.datasetHash = hash;
    versions.push([key("dataset", ...JSON.parse(datasetKey)), hash]);
  }
  for (const c of rows) versions.push([key("prompt",c.promptId,c.promptVersion),c.prompt.hash]);
  return { rows, versions };
}

export function assertVersions(versions) {
  const known = new Map();
  for (const [id, hash] of versions) {
    if (known.has(id) && known.get(id) !== hash) {
      throw new Error("Cambió el contenido de una versión ya registrada: " + id + ". Asigna una versión nueva.");
    }
    known.set(id, hash);
  }
}

export function jobs(plan) {
  return plan.rows.map(c => ({
    caso_id:c.id, dataset_id:c.datasetId, prompt_id:c.promptId, version_prompt:c.promptVersion,
    prompt_sha256:c.prompt.hash, instrucciones:c.prompt.instructions, esquema:c.prompt.schema, input:c.input
  }));
}

export function responseIndex(rows, plan) {
  const output = unique(rows, row => identifier(row.caso_id,"Respuesta.caso_id"), "respuestas");
  const validIds = new Set(plan.rows.map(c=>c.id));
  for (const row of output.values()) {
    if (!validIds.has(row.caso_id)) throw new Error("Respuesta de un caso ajeno: " + row.caso_id);
    if (typeof row.input_enviado !== "string" || typeof row.prompt_id !== "string"
      || typeof row.version_prompt !== "string" || typeof row.prompt_sha256 !== "string") {
      throw new Error("Falta la entrada o procedencia enviada en " + row.caso_id);
    }
    if (row.error !== undefined) text(row.error, "error de ejecución");
    if (row.error === undefined && typeof row.salida_bruta !== "string") {
      throw new Error("Falta salida_bruta en " + row.caso_id);
    }
  }
  return output;
}

function normalizeValue(value, rule) {
  if (rule.unordered && Array.isArray(value)) {
    return canonical([...value].sort((a,b)=>canonical(a).localeCompare(canonical(b),"en")));
  }
  return canonical(value);
}

export function evaluate(plan, responseRows, decisions) {
  const responseMap = responseIndex(responseRows, plan);
  const decisionMap = unique(decisions, d=>key(d.caso_id,d.campo), "dictámenes de rúbrica");
  const rubricCases = new Set(plan.rows.flatMap(c=>c.checks.filter(r=>r.op==="RUBRICA").map(r=>key(c.id,r.field))));
  for (const [id, d] of decisionMap) {
    if (!rubricCases.has(id) || !["OK","FALLO"].includes(d.veredicto) || typeof d.evidencia !== "string" || !d.evidencia.trim()) {
      throw new Error("Dictamen de rúbrica con campo, veredicto o evidencia inválidos: " + id);
    }
    const response = responseMap.get(d.caso_id);
    if (!response || response.error !== undefined || d.salida_sha256 !== sha256(response.salida_bruta)) {
      throw new Error("El dictamen no corresponde a la respuesta congelada: " + id);
    }
  }
  const validations = new Map();
  const pending = [];
  const rows = plan.rows.map(c => {
    const response = responseMap.get(c.id);
    const inputOk = response ? (response.input_enviado === c.input ? "OK" : "FALLO") : "";
    const promptOk = response ? (
      response.prompt_id === c.promptId && response.version_prompt === c.promptVersion
        && response.prompt_sha256 === c.prompt.hash ? "OK" : "FALLO"
    ) : "";
    let parsed = false;
    let data;
    let format = "";
    let diagnostic = response?.error ?? "";
    if (response && response.error === undefined) {
      try {
        data = jsonEstricto(response.salida_bruta);
        parsed = true;
      } catch {
        format = "FALLO";
        diagnostic = "La salida no es un JSON estricto.";
      }
      if (parsed) {
        if (!validations.has(c.prompt.hash)) validations.set(c.prompt.hash, compile(c.prompt.schema));
        const validate = validations.get(c.prompt.hash);
        format = validate(data) ? "OK" : "FALLO";
        if (format === "FALLO") {
          diagnostic = (validate.errors ?? []).map(e=>(e.instancePath || "/") + " [" + e.keyword + "]").join(" | ");
        }
      }
    }
    const content = c.checks.map(rule => {
      const present = parsed && isObject(data) && Object.hasOwn(data,rule.field);
      const obtained = parsed ? (present ? normalizeValue(data[rule.field],rule) : "__AUSENTE__") : "";
      let result = response && !parsed ? "SIN_EVALUAR" : statuses.PENDIENTE;
      let evidence = "";
      if (parsed && rule.op === "RUBRICA") {
        const decision = decisionMap.get(key(c.id,rule.field));
        if (decision) {
          result = decision.veredicto;
          evidence = decision.evidencia;
        } else {
          pending.push({
            caso_id:c.id, campo:rule.field, criterio:rule.rubric, input:c.input,
            obtenido_json:obtained, salida_bruta:response.salida_bruta,
            salida_sha256:sha256(response.salida_bruta)
          });
        }
      } else if (parsed) {
        result = rule.values.some(value=>normalizeValue(value,rule) === obtained) ? "OK" : "FALLO";
      }
      return { ...rule, obtained, result, evidence };
    });
    let accuracy = "";
    if (parsed && content.some(r=>r.result==="FALLO")) accuracy = "FALLO";
    else if (parsed && content.every(r=>r.result==="OK")) accuracy = "OK";
    let result = statuses.PENDIENTE;
    if (response?.error !== undefined) result = "ERROR_EJECUCION";
    else if (inputOk === "FALLO") result = "INPUT_ALTERADO";
    else if (promptOk === "FALLO") result = "PROMPT_DISTINTO";
    else if (format === "FALLO" || accuracy === "FALLO") result = "FALLO";
    else if (response && format === "OK" && accuracy === "OK") result = "OK";
    return { id:c.id, response, inputOk, promptOk, parsed, format, accuracy, content, result, diagnostic };
  });
  return { rows, pending };
}

export function mergeImmutable(oldRows,newRows,getKey,label) {
  const merged = unique(oldRows,getKey,label);
  for (const row of newRows) {
    const id = getKey(row);
    if (merged.has(id) && canonical(merged.get(id)) !== canonical(row)) {
      throw new Error("Ya existe una observación distinta para " + id + ". Usa otra variación.");
    }
    merged.set(id,row);
  }
  return [...merged.values()];
}

export async function readJson(path, fallback) {
  try { return jsonEstricto(await readFile(path,"utf8")); }
  catch (error) { if (error.code === "ENOENT" && fallback !== undefined) return fallback; throw error; }
}
export async function jsonl(path) {
  const rows = (await readFile(path,"utf8")).split(/\r?\n/);
  return rows.flatMap((line,index) => {
    if (!line.trim()) return [];
    try { return [jsonEstricto(line)]; }
    catch (error) { throw new Error("JSONL inválido en " + path + ":" + (index+1) + " (" + error.message + ")"); }
  });
}
export const asJsonl = rows => rows.map(row=>JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");
export async function atomicWrite(path, contents) {
  const temp = path + "." + process.pid + ".tmp";
  try { await writeFile(temp,contents,{flag:"wx"}); await rename(temp,path); }
  finally { await unlink(temp).catch(error=>{ if (error.code !== "ENOENT") throw error; }); }
}
export async function locked(dir, exec) {
  const path=resolve(dir,".lock");
  let file;
  try { file = await open(path,"wx"); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("Ya otra operación usa " + dir + ". Si se interrumpió, comprueba el PID en " + path + ".");
    throw error;
  }
  try {
    await file.writeFile(String(process.pid));
    return await exec();
  } finally {
    await file.close();
    await unlink(path);
  }
}
