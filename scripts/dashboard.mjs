
const C = {
  canvas:"#F1F5FA", white:"#FFFFFF", ink:"#152E49", muted:"#50677F",
  header:"#102A45", onDark:"#E5F2FF", blue:"#0067B1", pale:"#E9F4FE", slate:"#456681"
};
const cell = (sheet, pos, value) => { sheet.getRange(pos).values=[[value]]; };
const formula = (sheet, pos, value) => { sheet.getRange(pos).formulas=[[value]]; };

function merge(sheet, address) {
  if (address.includes(":")) sheet.getRange(address).merge();
  return address.split(":")[0];
}

function mergedValue(sheet, address, value, {font={}, fill, isFormula=false, center=false}={}) {
  const first=merge(sheet,address);
  const range=sheet.getRange(address);
  if (fill) range.format.fill=fill;
  range.format.font={name:"Arial",size:11,color:C.ink,...font};
  range.format.verticalAlignment="center";
  if (center) range.format.horizontalAlignment="center";
  (isFormula ? formula : cell)(sheet,first,value);
  return first;
}

function dropdown(sheet, address, listColumn, options) {
  const source="$"+listColumn+"$2:$"+listColumn+"$"+(options.length+1);
  sheet.getRange(source.replaceAll("$","")).values=options.map(option=>[option]);
  sheet.getRange(address).dataValidation={rule:{type:"list",formula1:source}};
}

function section(sheet, address, value) {
  mergedValue(sheet,address,value,{fill:C.header,font:{bold:true,color:C.white}});
}

function labelRows(sheet, start, left, right, labels) {
  for (let i=0;i<labels.length;i++) mergedValue(sheet,left+(start+i)+":"+right+(start+i),labels[i],{fill:C.white});
}

function chart(sheet, data, title, from, end, percent) {
  const graph=sheet.charts.add("bar",sheet.getRange(data));
  graph.title=title;
  graph.setPosition(from,end);
  graph.hasLegend=false;
  graph.titleTextStyle.fontSize=13;
  graph.yAxis={min:0,...(percent?{max:1}:{}),numberFormatCode:percent?"0%":"0",numberFormatSourceLinked:false};
  if (graph.series.items[0]) graph.series.items[0].fill=percent?C.blue:C.slate;
}

const totals = range => 'COUNTIFS('+range+')';
const ratio = (success,total) => '=IF(AND(ISNUMBER('+total+'),'+total+'>0),'+success+'/'+total+',"")';

function dashboardLayout(sheet) {
  sheet.showGridLines=false;
  const area=sheet.getRange("A1:Q48");
  area.format.fill=C.canvas;
  area.format.font={name:"Arial",size:11,color:C.ink};
  area.format.rowHeightPx=23;
  area.format.verticalAlignment="center";
  const narrow=new Set(["A","E","I","M","Q"]);
  for (const col of "ABCDEFGHIJKLMNOPQ") {
    sheet.getRange(col+"1").format.columnWidthPx=narrow.has(col)?19:91;
  }
  sheet.getRange("A1:Q4").format.fill=C.header;
  sheet.getRange("A2:Q2").format.rowHeightPx=46;
  sheet.getRange("A3:Q3").format.rowHeightPx=27;
  sheet.getRange("A6:Q6").format.rowHeightPx=32;
  sheet.getRange("A9:Q10").format.rowHeightPx=26;
  sheet.getRange("A11:Q11").format.rowHeightPx=25;
  sheet.getRange("A12:Q12").format.rowHeightPx=26;
  mergedValue(sheet,"B2:P2","Estadísticas de pruebas",{font:{size:25,bold:true,color:C.white}});
  mergedValue(sheet,"B3:P3","Consulta la cobertura y compara variaciones sobre la misma versión del dataset.",{font:{size:11,color:C.onDark}});
  sheet.getRange("B13:H26").format.fill=C.white;
  sheet.getRange("J13:P26").format.fill=C.white;
  sheet.getRange("B29:H37").format.fill=C.white;
  sheet.getRange("J29:P40").format.fill=C.white;
}

function card(sheet, grid, caption, value, hint, unit) {
  const [left,right]=grid;
  mergedValue(sheet,left+"8:"+right+"8",caption,{fill:C.white,font:{bold:true,color:C.muted},center:true});
  const anchor=mergedValue(sheet,left+"9:"+right+"10",value,{
    fill:C.white,font:{size:25,bold:true,color:C.blue},isFormula:true,center:true
  });
  if (unit) sheet.getRange(anchor).setNumberFormat(unit);
  mergedValue(sheet,left+"11:"+right+"11",hint,{fill:C.white,font:{size:10,color:C.muted},isFormula:true,center:true});
}

export function renderDashboard(sheet,rows,columns) {
  dashboardLayout(sheet);
  const unique = xs=>[...new Set(xs)];
  const {cases,checks}=columns;
  const runs=unique(rows.runs.map(r=>r[0]));
  const variants=unique(rows.runs.map(r=>r[1]));
  const datasets=unique(rows.cases.map(r=>r[columns.caseDatasetIndex]));
  const versions=unique(rows.cases.map(r=>r[columns.caseVersionIndex]));
  for (const [start,end,label,list,options,value] of [
    ["B","D","Corrida","AH",["Todas",...runs],runs.at(-1)??"Todas"],
    ["F","H","Variación","AI",["Todas",...variants],"Todas"],
    ["J","L","Dataset","AJ",["Todos",...datasets],"Todos"],
    ["N","P","Versión del dataset","AK",["Todas",...versions],"Todas"]
  ]) {
    mergedValue(sheet,start+"5:"+end+"5",label,{font:{bold:true,color:C.muted}});
    const anchor=mergedValue(sheet,start+"6:"+end+"6",value,{
      fill:C.pale,font:{bold:true,color:C.blue}
    });
    dropdown(sheet,anchor,list,options);
  }

  const caseCount=Math.max(2,rows.cases.length+1);
  const checkCount=Math.max(2,rows.checks.length+1);
  const datasetKey=(sheet, col, last)=>sheet+"!$"+col+"$2:$"+col+"$"+last;
  const filter=(name, map, last, run="$B$6", variant="$F$6") =>
    [
      [map.run,'IF('+run+'="Todas","<>",'+run+')'],
      [map.variant,'IF('+variant+'="Todas","<>",'+variant+')'],
      [map.dataset,'IF($J$6="Todos","<>",$J$6)'],
      [map.datasetVersion,'IF($N$6="Todas","<>",$N$6)']
    ].map(([column,value])=>datasetKey(name,column,last)+","+value).join(",");
  const caseFilter=filter("Pruebas",cases,caseCount);
  const validationFilter=filter("Validaciones",checks,checkCount);
  const count=(name,column,last,where,status) =>
    totals(where+","+datasetKey(name,column,last)+',"'+status+'"');
  const caseStatus=(status,where=caseFilter)=>count("Pruebas",cases.status,caseCount,where,status);
  const checkStatus=status=>count("Validaciones",checks.status,checkCount,validationFilter,status);
  const failed=where=>["FALLO","INPUT_ALTERADO","PROMPT_DISTINTO"].map(status=>caseStatus(status,where)).join("+");

  const waiting='=IF('+rows.groups.length+'=0,"Sin corridas registradas",IF(F31="","La selección no tiene casos","Selección activa · "&F32&" de "&F31&" casos ejecutados"))';
  mergedValue(sheet,"B12:P12",waiting,{font:{size:10,color:C.muted},isFormula:true});

  section(sheet,"B29:H29","Cobertura y calidad");
  labelRows(sheet,31,"B","D",["Casos previstos","Casos ejecutados","Cobertura","Tasa de aprobación","JSON y esquema válidos","Acierto de contenido","Input idéntico"]);
  for (let i=31;i<=37;i++) {
    merge(sheet,"F"+i+":G"+i);
    sheet.getRange("F"+i+":G"+i).format.horizontalAlignment="right";
  }
  cell(sheet,"F30","Valor");
  cell(sheet,"H30","Base");
  const totalValues=totals(caseFilter);
  formula(sheet,"F31",'=IF(OR('+rows.groups.length+'=0,'+totalValues+'=0),"",'+totalValues+')');
  const gated=expression=>'=IF(F31="","",'+expression+')';
  const executed=["OK","ERROR"].map(status=>count("Pruebas",cases.execution,caseCount,caseFilter,status)).join("+");
  formula(sheet,"F32",gated(executed));
  formula(sheet,"H33",'=IF(F31="","",F31)');
  formula(sheet,"H34",gated("AC3+AC4"));
  formula(sheet,"F33",ratio("F32","H33"));
  formula(sheet,"F34",ratio("AC3","H34"));
  for (const [row,column] of [[35,cases.format],[36,cases.accuracy],[37,cases.input]]) {
    const pass=count("Pruebas",column,caseCount,caseFilter,"OK");
    const fail=count("Pruebas",column,caseCount,caseFilter,"FALLO");
    formula(sheet,"H"+row,gated(pass+"+"+fail));
    formula(sheet,"F"+row,ratio(pass,"H"+row));
  }
  sheet.getRange("F33:F37").setNumberFormat("0.0%");

  sheet.getRange("AB2:AC6").values=[
    ["Estado","Casos"],["Aprobados",null],["Fallidos",null],["Pendientes",null],["Error de ejecución",null]
  ];
  for (const [i,expression] of [caseStatus("OK"),failed(caseFilter),caseStatus("PENDIENTE"),caseStatus("ERROR_EJECUCION")].entries()) {
    formula(sheet,"AC"+(i+3),gated(expression));
  }

  section(sheet,"J29:P29","Validaciones por campo");
  labelRows(sheet,31,"J","O",["Correctas","Fallidas","Pendientes","Sin evaluar por formato o error"]);
  cell(sheet,"P30","Cantidad");
  for (const [i,status] of ["OK","FALLO","PENDIENTE","SIN_EVALUAR"].entries()) {
    formula(sheet,"P"+(31+i),gated(checkStatus(status)));
  }
  section(sheet,"J36:P36","Estado de los casos");
  for (const [i,[label,color]] of [
    ["Aprobados","#0F6750"],["Fallidos","#9B2542"],["Pendientes","#80560F"],["Error de ejecución","#475D71"]
  ].entries()) {
    mergedValue(sheet,"J"+(37+i)+":L"+(37+i),label,{fill:C.white,font:{color,bold:true}});
    formula(sheet,"P"+(37+i),'=IF(F31="","",AC'+(3+i)+')');
  }

  card(sheet,["B","D"],"Casos ejecutados",'=IF(ISNUMBER(F32),F32,"—")','=IF(ISNUMBER(F31),"De "&F31&" previstos","Sin casos registrados")',"0");
  card(sheet,["F","H"],"Tasa de aprobación",'=IF(ISNUMBER(F34),F34,"—")','=IF(ISNUMBER(H34),H34&" casos evaluables","Sin dictamen")',"0.0%");
  card(sheet,["J","L"],"Formato válido",'=IF(ISNUMBER(F35),F35,"—")','=IF(ISNUMBER(H35),H35&" respuestas con veredicto","Sin respuestas evaluadas")',"0.0%");
  card(sheet,["N","P"],"Acierto de contenido",'=IF(ISNUMBER(F36),F36,"—")','=IF(ISNUMBER(H36),H36&" respuestas con veredicto","Sin respuestas evaluadas")',"0.0%");

  const history=rows.groups.slice(-20);
  sheet.getRange("AE2:AG2").values=[["Corrida / variación","Aprobación","Evaluables"]];
  section(sheet,"B40:H40","Últimas 20 combinaciones");
  mergedValue(sheet,"B41:D41","Corrida / variación",{fill:C.white,font:{bold:true}});
  mergedValue(sheet,"F41:G41","Aprobación",{fill:C.white,font:{bold:true}});
  mergedValue(sheet,"H41","Evaluables",{fill:C.white,font:{bold:true}});
  if (!history.length) {
    cell(sheet,"AE3","Sin corridas");
    mergedValue(sheet,"B42:H42","El historial aparecerá al registrar una corrida.",{fill:C.white,font:{color:C.muted}});
  }
  for (const [i,[run,variant]] of history.entries()) {
    const sourceRow=3+i;
    const targetRow=42+i;
    cell(sheet,"AE"+sourceRow,run+" / "+variant);
    cell(sheet,"AM"+sourceRow,run);
    cell(sheet,"AN"+sourceRow,variant);
    const group=filter("Pruebas",cases,caseCount,"AM"+sourceRow,"AN"+sourceRow);
    const approved=caseStatus("OK",group);
    formula(sheet,"AG"+sourceRow,"="+approved+"+"+failed(group));
    formula(sheet,"AF"+sourceRow,ratio(approved,"AG"+sourceRow));
    mergedValue(sheet,"B"+targetRow+":D"+targetRow,"=AE"+sourceRow,{fill:C.white,isFormula:true});
    const match=mergedValue(sheet,"F"+targetRow+":G"+targetRow,'=IF(ISNUMBER(AF'+sourceRow+'),AF'+sourceRow+',"")',{fill:C.white,isFormula:true});
    sheet.getRange(match).setNumberFormat("0.0%");
    formula(sheet,"H"+targetRow,'=IF(AG'+sourceRow+'>0,AG'+sourceRow+',"")');
  }
  chart(sheet,"AB2:AC6","Estado de los casos","B13","I27",false);
  chart(sheet,"AE2:AF"+Math.max(3,history.length+2),"Aprobación por corrida y variación","J13","Q27",true);
}
