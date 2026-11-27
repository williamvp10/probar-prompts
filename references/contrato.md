# Contrato de entrada, ejecución y resultados

## Entrada

El script admite Excel o JSON. En Excel, la primera fila es el encabezado. Los IDs y versiones usan letras, números, punto, guion o guion bajo y empiezan por letra o número. Los IDs de caso son únicos en cada selección de corrida.

| Hoja | Columnas |
|---|---|
| Dataset | `caso_id`, `dataset_id`, `version_dataset`, `grupo`, `prompt_id`, `version_prompt`, `input_fuente`, `esperado_json`, `clave_del_caso`, `n_validaciones` |
| Prompts | `prompt_id`, `version_prompt`, `dataset_id`, `version_dataset`, `prompt`, `json_schema` |
| Validaciones | `caso_id`, `campo`, `operador`, `esperado_1_json`, `esperado_2_json`, `criterio_rubrica`. Si un ID se repite en otra versión, agrega `dataset_id` y `version_dataset`. |

`input_fuente` es texto literal, incluidos saltos de línea y espacios. Se admite input vacío. El esquema es JSON Schema draft-07. Especifica tipos, requeridos y opciones permitidas. Decide si se puede devolver una propiedad adicional. En clasificación la clave contiene las etiquetas aceptadas. En extracción preserva el tipo: por ejemplo, `"0012"` es un identificador textual y `0` es un número. Al usar la marca `"REVISAR"`, represéntala como cadena en el esquema. La sintaxis JSON y el esquema se verifican localmente incluso cuando el proveedor declara JSON estructurado.

Si Validaciones está vacía para un caso, el script traduce el objeto `esperado_json` en reglas `IGUAL`. Un valor como `{"uno_de":["despacho","facturacion"]}` representa alternativas. Cuando haya reglas explícitas, estas prevalecen para puntuar. Usa `n_validaciones` si quieres comprobar que la lista de reglas está completa. El formato JSON equivalente está en [el ejemplo](../assets/entrada-ejemplo.json).

| Operador | Uso |
|---|---|
| IGUAL | Un valor JSON exacto, con comparación sensible a tipo, mayúsculas y espacios internos |
| UNO_DE | Dos alternativas en Excel o dos o más en JSON |
| RUBRICA | Un criterio verificable, un dictamen y evidencia breve. Úsalo para calidad de un resumen, ambigüedad o comparaciones entre casos. |

Los campos son propiedades de primer nivel. Los objetos se comparan con claves ordenadas. Los arreglos conservan el orden salvo `campos_revisar`, que se trata como lista sin orden, o una regla JSON con `"unordered":true`. Los duplicados en un arreglo se conservan y pueden hacer fallar la comparación. Los duplicados de claves de un objeto, cercas Markdown y prosa rodeando el JSON invalidan el formato.

## Agente actual

Lee `trabajos.jsonl` en vez de `plan.json` para generar las salidas. La fila trae el identificador, el prompt, su versión y hash, el esquema, y el input. Trata cada caso como llamada independiente. Ejecuta las instrucciones con el input literal y pide el objeto JSON asociado. Conserva exactamente lo escrito. Copia desde la fila el identificador, versión y hash, y registra el input efectivamente usado. Usa los registros de respuesta como datos del evaluador. Si usas un contexto compartido, registra `--parametros '{"contexto":"compartido"}'` al preparar.

Una línea JSON en el archivo de respuestas por caso. Los nombres de campos de procedencia son obligatorios. El hash de este ejemplo se sustituye con `prompt_sha256` del trabajo real.

```json
{"caso_id":"MAIL-01","input_enviado":"¿Cuándo llega mi pedido?","prompt_id":"clasificador","version_prompt":"v1","prompt_sha256":"COPIAR_DEL_TRABAJO","salida_bruta":"{\"categoria\":\"despacho\"}","modelo":"Agente actual"}
```

Para un fallo de ejecución, conserva la procedencia y registra `"error":"motivo observado"` en lugar de salida. Guarda los archivos de evidencia y alimenta el comando cuando haya un caso o un lote listo. Si la corrida se interrumpe, las respuestas ya importadas se conservan.

```bash
node scripts/probar.mjs evaluar --plan historial/clase/base/plan.json --respuestas respuestas.jsonl
```

Tras evaluar, revisa `pendientes-rubrica.jsonl`. Cada línea trae el campo, criterio, respuesta y hash de esa respuesta. El dictamen se escribe como `{"caso_id":"…","campo":"…","salida_sha256":"…","veredicto":"OK","evidencia":"…"}`, o con `"veredicto":"FALLO"`. Importa el JSONL con `--rubricas`. Conserva el hash. Deja pendiente un campo cuando un criterio depende de evidencia aún ausente. El ejecutor y el evaluador tienen roles distintos. Cuando sea viable, puntúa la rúbrica en otro contexto una vez congelada la salida.

## Iteración y estadísticas

Usa un directorio de historial por conjunto de pruebas relacionado. Para repetir, conserva los mismos casos y crea una variación nueva. Si agregaste otra versión del prompt a la entrada, selecciona `--dataset ID --version-dataset VERSION --version-prompt VERSION`. Una versión registrada no puede cambiar de contenido dentro del mismo historial. El script congela las respuestas y rúbricas importadas. Los XLSX se regeneran a partir de ese historial, por lo que las correcciones se registran como nuevas variaciones.

```bash
node scripts/probar.mjs preparar --input entrada.xlsx --out historial --corrida clase --variacion v2 --dataset CORREOS --version-dataset v1 --version-prompt v2
node scripts/probar.mjs reporte --out historial --excel comparacion.xlsx
```

- **Pruebas** presenta juntos Input fuente e Input enviado, y Output esperado y Output recibido. El output esperado muestra la clave JSON comprobable, con `uno_de` para alternativas. La salida recibida conserva el texto bruto. Comentario de la clave y Diagnóstico están al final.
- **Validaciones** muestra lo esperado y lo recibido para cada campo. En las reglas de rúbrica, la explicación de lo esperado está en Criterio de rúbrica. Esa columna y Evidencia están al final.
- **Corridas** conserva modelo, configuración y hashes de la definición.
- **Estadisticas** filtra por corrida, variación, dataset y versión. El gráfico de historial compara las últimas 20 combinaciones sobre el dataset elegido. Usa el mismo dataset y versión al comparar. La tasa de aprobación usa evaluables, que son aprobados más fallidos. Los casos pendientes y los errores de ejecución se muestran aparte. Los porcentajes de formato, contenido e input usan los casos con veredicto de ese indicador.

El libro usa `PENDIENTE` para casos o rúbricas sin dictamen. Una respuesta que no se puede evaluar por formato o error de ejecución deja sus reglas en `SIN_EVALUAR`. La vista de Excel puede truncar valores de más de 32.767 caracteres. El expediente JSON conserva el valor completo y el script evalúa ese original.
