# Ejecución por API

Usa esta ruta cuando el usuario elija enviar los casos a una API. El adaptador usa un endpoint compatible con Chat Completions.

| Variable | Uso |
|---|---|
| `PROMPT_EVAL_API_KEY` | Credencial que el adaptador lee al ejecutar. No se escribe al expediente. |
| `PROMPT_EVAL_MODEL` | Modelo de la corrida. Se puede especificar con `--modelo`. |
| `PROMPT_EVAL_API_BASE_URL` | Base que incluye el prefijo de versión. Predeterminado `https://api.openai.com/v1`. |

Carga la credencial con tu gestor de secretos o en el entorno de ejecución. La URL y el modelo se fijan al preparar.

```bash
node scripts/probar.mjs preparar --input entrada.xlsx --out historial --corrida piloto --variacion api --modo api --modelo MODELO
node scripts/probar.mjs ejecutar-api --plan historial/piloto/api/plan.json --limite 2
```

`--limite` acota los casos nuevos enviados en esa invocación. Si continúas con el mismo plan, se omiten los casos ya guardados. Para comparar una nueva respuesta de un caso registrado, crea una variación. Una interrupción de red, error de autenticación, límite de tasa o error del proveedor detiene la ejecución sin reintentos automáticos. El expediente y el reporte conservan lo ya registrado.

Pasa parámetros compatibles en `--parametros`, por ejemplo `'{"max_completion_tokens":300}'`. El adaptador admite `temperature`, `top_p`, `seed`, `max_completion_tokens` y `reasoning_effort`. Elige parámetros que soporte el modelo. El adaptador solicita JSON en las instrucciones y valida a continuación el JSON y el esquema localmente. El proveedor recibe el input, las instrucciones y el esquema, sin claves esperadas. Un criterio subjetivo se importa por el mismo flujo de rúbricas del modo agente.

[Contrato Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
