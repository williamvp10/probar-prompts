# Ejemplos de entrada y reporte

Usa la [plantilla de entrada](../assets/plantilla-entrada.xlsx) para Excel o [entrada-ejemplo.json](../assets/entrada-ejemplo.json) para JSON. Los ejemplos de esta carpeta son ficticios.

## Clasificación

| Dato | Ejemplo |
| --- | --- |
| Input fuente | ¿Cuándo llega mi pedido? |
| Instrucción | Identifica si el correo trata de facturación o despacho. |
| Output esperado | `{"categoria":"despacho"}` |
| Output recibido | `{"categoria":"despacho"}` |
| Evaluación | Input idéntico, JSON válido y coincidencia. Estado final `OK`. |

Si el modelo devuelve `{"categoria":"facturacion"}`, el JSON puede cumplir el esquema y fallar en contenido. Si el input enviado tiene un espacio adicional, la comparación literal se registra como `FALLO` y el caso queda `INPUT_ALTERADO`, aunque la categoría coincida.

## Extracción

| Dato | Ejemplo |
| --- | --- |
| Input fuente | Subtotal $80.000. IVA $15.200. |
| Instrucción | Extrae solo el total impreso como número. Si falta escribe REVISAR. |
| Output esperado | `{"total":"REVISAR"}` |
| Output recibido | `{"total":95200}` |
| Evaluación | Formato `OK`. Acierto `FALLO`. El importe sale de una suma y el documento carece de total impreso. |

Un total impreso de cero se representa como `{"total":0}`. Si el modelo lo devuelve como `{"total":"0"}`, cambia el tipo del dato. Un identificador con ceros iniciales, como `"0012"`, sí se conserva como cadena cuando el esquema lo pide.

## Qué encontrarás en el Excel

| Hoja | Qué mirar |
| --- | --- |
| Estadisticas | Filtra por corrida, variación, dataset y versión. Las tarjetas presentan ejecutados, aprobación, formato y acierto. El gráfico de historial conserva ambas variaciones y se compara con el dataset y la versión seleccionados. |
| Pruebas | Compara Input fuente con Input enviado, y Output esperado con Output recibido. Comentario de la clave y Diagnóstico están al final. |
| Validaciones | Revisa el campo, su valor esperado, lo recibido y el veredicto. El criterio cualitativo y la evidencia aparecen al final. |
| Corridas | Consulta la versión, el modelo, la configuración y los hashes que identifican la ejecución. |
| Guia | Lee cómo se calculan y cómo se interpretan los indicadores. |

`Output esperado` es la parte estructurada de la clave. Una salida con `{"uno_de":["despacho","facturacion"]}` como valor esperado acepta cualquiera de esas dos etiquetas. Si un caso depende únicamente de rúbricas, consulta los criterios en Validaciones. Revisar una rúbrica requiere evidencia del texto, por ejemplo qué hechos respaldan un resumen o por qué prioriza un motivo.

## Reproducir el reporte sin llamadas a un modelo

Estas respuestas ya están escritas para demostrar el funcionamiento del evaluador. La base acierta los tres casos. En la variación, la extracción del documento sin total falla por contenido y el total cero falla por tipo. Ejecuta los comandos desde el directorio de la skill y usa un historial nuevo.

```bash
node scripts/probar.mjs preparar --input assets/entrada-ejemplo.json --out demo --corrida demostracion --variacion base --modelo "Respuestas ficticias"
node scripts/probar.mjs evaluar --plan demo/demostracion/base/plan.json --respuestas assets/respuestas-ejemplo-base.jsonl

node scripts/probar.mjs preparar --input assets/entrada-ejemplo.json --out demo --corrida demostracion --variacion alternativa --modelo "Respuestas ficticias"
node scripts/probar.mjs evaluar --plan demo/demostracion/alternativa/plan.json --respuestas assets/respuestas-ejemplo-alternativa.jsonl
node scripts/probar.mjs reporte --out demo --excel demo/reporte.xlsx
```

Abre [el reporte ficticio publicado](../assets/reporte-ejemplo.xlsx) o la copia generada. Con dataset **DOCUMENTOS**, la base aprueba **2 de 2** y la alternativa **0 de 2**. Con dataset **CORREOS**, ambas aprueban **1 de 1**. La tasa de aprobación usa casos evaluables, mientras que cobertura compara ejecutados con previstos.
