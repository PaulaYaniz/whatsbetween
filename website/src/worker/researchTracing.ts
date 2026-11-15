import {awaitAllCallbacks} from '@langchain/core/callbacks/promises';
import type {RunnableConfig} from '@langchain/core/runnables';
import {RunnableLambda} from '@langchain/core/runnables';
import {LangChainTracer} from '@langchain/core/tracers/tracer_langchain';
import {Client} from 'langsmith';

import type {Env} from './types';

// Defense in depth: the traced entry point receives research text only, never the HTTP
// request, environment, cookie or recognition payload.
export function redactTrace(value: unknown): any {
  if (typeof value === 'string')
    return value.replace(/data:image\/[^\s"'<>]+/gi, '[image omitted]');
  if (Array.isArray(value)) return value.map(redactTrace);
  if (value && typeof value === 'object') {
    const data = value as Record<string, unknown>;
    if (['image', 'image_url', 'input_image'].includes(String(data.type)))
      return {type: 'text', text: '[image omitted]'};
    return Object.fromEntries(
      Object.entries(data).map(([key, item]) => [
        key,
        /imageBase64|inlineData|api.?key|authorization|cookie|secret|mongodb_uri|sessionId/i.test(
          key
        )
          ? '[omitted]'
          : redactTrace(item),
      ])
    );
  }
  return value;
}

export async function traceResearch<I extends Record<string, unknown>, O>(
  env: Env,
  input: I,
  action: (input: I, config: RunnableConfig) => Promise<O>
): Promise<O> {
  if (env.LANGSMITH_TRACING !== 'true' || !env.LANGSMITH_API_KEY) return action(input, {});
  const client = new Client({
    apiKey: env.LANGSMITH_API_KEY,
    apiUrl: env.LANGSMITH_ENDPOINT || 'https://api.smith.langchain.com',
    timeout_ms: 3000,
    hideInputs: redactTrace,
    hideOutputs: redactTrace,
  });
  const tracer = new LangChainTracer({
    client,
    projectName: env.LANGSMITH_PROJECT || 'whatsbetween',
  });
  try {
    return await RunnableLambda.from(action).invoke(input, {
      runName: 'Dig deeper',
      callbacks: [tracer],
      tags: ['whatsbetween', 'research'],
      metadata: {model: env.GEMINI_MODEL || 'gemini-3.1-flash-lite'},
    });
  } finally {
    // Telemetry failure must not turn a completed answer into a failed request.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await awaitAllCallbacks();
          await client.awaitPendingTraceBatches();
        })(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 4000);
        }),
      ]);
    } catch {
      console.warn('Research tracing could not flush.');
    } finally {
      clearTimeout(timer);
    }
  }
}
