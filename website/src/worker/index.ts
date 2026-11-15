import {z} from 'zod';

import {MODEL_UNAVAILABLE_MESSAGES, reserveModelCall} from './budget';
import {createDiscoveryCard, recognizeFrame} from './gemini';
import {investigate} from './research';
import {getSession, issueSession, readResult, signResult} from './session';
import {
  deleteInvestigation,
  listInvestigations,
  loadInvestigation,
  loadResearchHistory,
  saveInvestigation,
  type Finding,
} from './store';
import type {Env} from './types';
import {connectArticles, graphPath, RequestBudget, searchArticles, WikiError} from './wiki';

const corsHeaders = {'Access-Control-Allow-Origin': '', Vary: 'Origin'};

function json(data: unknown, status = 200, extra: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...corsHeaders,
      ...extra,
    },
  });
}

function errorResponse(error: unknown) {
  if (error instanceof WikiError)
    return json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.retryAfterSeconds ? {retryAfterSeconds: error.retryAfterSeconds} : {}),
        },
      },
      error.status,
      error.retryAfterSeconds ? {'Retry-After': String(error.retryAfterSeconds)} : {}
    );
  const message = error instanceof Error ? error.message : 'Request failed.';
  // Errors may carry an HTTP status (Gemini busy = 503, quota = 429); keep it for the browser.
  const status =
    typeof (error as {status?: unknown})?.status === 'number'
      ? (error as {status: number}).status
      : 500;
  const code =
    status === 503 ? 'service_busy' : status === 429 ? 'quota_reached' : 'request_failed';
  return json({error: {code, message}}, status);
}

function checkOrigin(request: Request) {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}

async function readBody(request: Request, maxBytes = 2_500_000) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > maxBytes)
    throw Object.assign(new Error('Request body is too large.'), {status: 413});
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes)
    throw Object.assign(new Error('Request body is too large.'), {status: 413});
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), {status: 400});
  }
}

function numberParam(value: string | null) {
  return value && /^\d+$/.test(value) ? Number(value) : NaN;
}

async function authorizedSession(request: Request, env: Env) {
  const sessionId = await getSession(request, env);
  if (!sessionId)
    throw Object.assign(
      new Error('Your session is missing or expired. Reload the page to create a new session.'),
      {status: 401}
    );
  return sessionId;
}

async function api(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!checkOrigin(request))
    return json({error: {code: 'origin_rejected', message: 'Request origin is not allowed.'}}, 403);
  if (!['GET', 'POST', 'DELETE', 'OPTIONS'].includes(request.method))
    return json({error: {code: 'method_not_allowed', message: 'Method not allowed.'}}, 405);
  if (request.method === 'OPTIONS')
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
      },
    });
  if (url.pathname === '/api/session' && request.method === 'GET')
    return issueSession(request, env);
  const sessionId = await authorizedSession(request, env);
  if (url.pathname === '/api/status' && request.method === 'GET')
    return json({
      recognitionAvailable: Boolean(env.GEMINI_API_KEY),
      savingAvailable: Boolean(env.MONGODB_URI),
      calculationsAvailable: Boolean(env.WOLFRAM_APP_ID),
    });
  if (url.pathname.startsWith('/api/investigations') && !env.MONGODB_URI)
    return json(
      {
        error: {
          code: 'saving_unavailable',
          message:
            'Saving is not set up yet. You can still scan objects and explore connections. Connect MongoDB Atlas to enable saved investigations.',
        },
      },
      503
    );
  if (url.pathname === '/api/recognize' && !env.GEMINI_API_KEY)
    return json(
      {
        error: {
          code: 'recognition_unavailable',
          message:
            'Object recognition is unavailable on this server. Use article names while the connection is restored.',
        },
      },
      503
    );
  if (
    env.RATE_LIMITER &&
    ['/api/articles', '/api/recognize', '/api/connect', '/api/discover', '/api/research'].includes(
      url.pathname
    )
  ) {
    const limit = await env.RATE_LIMITER.limit({key: `${sessionId}:${url.pathname}`});
    if (!limit.success)
      return json(
        {
          error: {
            code: 'session_rate_limit',
            message: 'Too many requests in a minute. Pause briefly, then try again.',
          },
        },
        429,
        {'Retry-After': '60'}
      );
  }
  if (
    env.MODEL_RATE_LIMITER &&
    env.GEMINI_API_KEY &&
    ['/api/recognize', '/api/discover', '/api/research'].includes(url.pathname)
  ) {
    const limit = await env.MODEL_RATE_LIMITER.limit({key: `${sessionId}:${url.pathname}`});
    if (!limit.success)
      return json(
        {
          error: {
            code: 'model_rate_limit',
            message:
              'Recognition or research is temporarily paused after repeated requests. Try again in one minute.',
          },
        },
        429,
        {'Retry-After': '60'}
      );
  }

  if (url.pathname === '/api/articles' && request.method === 'GET') {
    const budget = new RequestBudget(2, Date.now() + 12_000);
    return json(
      await searchArticles(url.searchParams.get('q') || '', budget, env.GRAPH_SERVICE_URL)
    );
  }
  if (url.pathname === '/api/connect' && request.method === 'POST') {
    const body = z
      .object({sourceId: z.number().int().positive(), targetId: z.number().int().positive()})
      .parse(await readBody(request, 10_000));
    const budget = new RequestBudget(8, Date.now() + 30_000);
    const connection = await connectArticles(
      body.sourceId,
      body.targetId,
      budget,
      env.GRAPH_SERVICE_URL
    );
    const resultToken = await signResult(request, env, {
      sessionId,
      expiresAt: Date.now() + 60 * 60 * 1000,
      connection,
    });
    return json({connection, resultToken});
  }
  if (url.pathname === '/api/path' && request.method === 'GET') {
    // Shortest-path search runs only against the local full-graph service.
    if (!env.GRAPH_SERVICE_URL)
      return json(
        {error: 'Path search needs the local graph service.', code: 'graph_unavailable'},
        503
      );
    const sourceId = numberParam(url.searchParams.get('source'));
    const targetId = numberParam(url.searchParams.get('target'));
    if (
      !Number.isSafeInteger(sourceId) ||
      sourceId <= 0 ||
      !Number.isSafeInteger(targetId) ||
      targetId <= 0
    ) {
      return json({error: 'Choose two valid article IDs.', code: 'invalid_article'}, 400);
    }
    // perStep lets the page show more (or fewer) of the busiest stops without a new connection.
    const perStep = Math.min(40, Math.max(1, numberParam(url.searchParams.get('perStep')) || 6));
    const path = await graphPath(env.GRAPH_SERVICE_URL, sourceId, targetId, perStep);
    return json({path}, path.source === 'unavailable' ? 503 : 200);
  }
  if (url.pathname === '/api/discover' && request.method === 'POST') {
    const reservation = await reserveModelCall(env);
    if (!reservation.allowed)
      return json(
        {
          error: {
            code: 'model_unavailable',
            reason: reservation.reason,
            message: MODEL_UNAVAILABLE_MESSAGES[reservation.reason],
          },
        },
        503
      );
    const body = z
      .object({resultToken: z.string().min(1).max(64_000), candidateId: z.string().regex(/^\d+$/)})
      .parse(await readBody(request, 70_000));
    const result = await readResult(request, env, body.resultToken, sessionId);
    if (!result)
      return json(
        {error: {code: 'result_expired', message: 'This result expired. Scan the articles again.'}},
        401
      );
    const discovery = await createDiscoveryCard(
      env,
      result.connection,
      body.candidateId,
      AbortSignal.timeout(20_000)
    );
    if (discovery.status === 'unavailable' && 'topic' in discovery)
      return json({
        status: discovery.status,
        reason: discovery.reason,
        topic: discovery.topic,
        evidence: discovery.evidence,
      });
    if (discovery.status === 'supported' && 'card' in discovery)
      return json({...discovery, card: {...discovery.card, saveToken: await signResult(request, env, {...result, discoveryCard: discovery.card})}});
    return json(discovery);
  }
  if (url.pathname === '/api/recognize' && request.method === 'POST') {
    const reservation = await reserveModelCall(env);
    if (!reservation.allowed)
      return json(
        {
          error: {
            code: 'model_unavailable',
            reason: reservation.reason,
            message: MODEL_UNAVAILABLE_MESSAGES[reservation.reason],
          },
        },
        503
      );
    const body = z
      .object({imageBase64: z.string().min(100).max(2_100_000), mimeType: z.literal('image/jpeg')})
      .parse(await readBody(request, 2_200_000));
    return json(await recognizeFrame(env, body.imageBase64, body.mimeType, request.signal));
  }
  if (url.pathname === '/api/investigations' && request.method === 'GET')
    return json({investigations: await listInvestigations(env, sessionId)});
  if (url.pathname === '/api/investigations' && request.method === 'POST') {
    const body = z
      .object({
        resultToken: z.string().min(1).max(64_000),
        discoveryToken: z.string().max(64_000).optional(),
        // Empty when the two articles share no topic; the saved result then keeps only the path.
        candidateId: z.string().regex(/^\d*$/).default(''),
        question: z.string().max(1200).default(''),
      })
      .parse(await readBody(request, 140_000));
    const result = await readResult(request, env, body.resultToken, sessionId);
    if (!result)
      return json(
        {error: {code: 'result_expired', message: 'This result expired. Scan the articles again.'}},
        401
      );
    let connection = result.connection;
    if (body.candidateId) {
      const selected = [
        ...result.connection.sharedTopics,
        ...(result.connection.path?.steps ?? []).flat(),
        ...(result.connection.path?.routes ?? []).flat(),
      ].find(
        (topic) => String(topic.id) === body.candidateId
      );
      if (!selected)
        return json(
          {error: {code: 'invalid_topic', message: 'Choose a topic from this scan.'}},
          400
        );
      connection = {
        ...result.connection,
        sharedTopics: [selected],
        evidenceByTopic: {
          [body.candidateId]: result.connection.evidenceByTopic[body.candidateId] || [],
        },
      };
    } else {
      connection = {...result.connection, sharedTopics: [], evidenceByTopic: {}};
    }
    const signedCard = body.discoveryToken
      ? await readResult(request, env, body.discoveryToken, sessionId) : null;
    const card = signedCard?.discoveryCard;
    if (body.discoveryToken && (!card || card.candidateId !== body.candidateId ||
      signedCard?.connection.source.id !== connection.source.id ||
      signedCard?.connection.target.id !== connection.target.id))
      return json({error: {code: 'invalid_card', message: 'Refresh the explanation before saving.'}}, 400);
    if (card?.evidence) {
      connection = {
        ...connection,
        evidenceByTopic: {...connection.evidenceByTopic, [body.candidateId]: card.evidence},
      };
    }
    const finding: Finding | undefined = card ? {
      status: 'Supported finding', finding: card.headline,
      claims: [card.explanationSource, card.explanationTarget, card.whyInteresting].map(claim => ({claim, evidenceIds: card.evidenceIds})),
      uncertainty: 'A shared link does not establish causation.', followUp: 'Ask a more specific question.',
    } : undefined;
    const investigation = await saveInvestigation(env, sessionId, connection, body.question, finding);
    return json({investigation}, 201);
  }
  if (url.pathname === '/api/investigations/finding' && request.method === 'POST')
    return json({error: {code: 'server_findings_only', message: 'Findings are saved by the research server.'}}, 410);
  if (url.pathname === '/api/research' && request.method === 'POST') {
    const reservation = await reserveModelCall(env);
    if (!reservation.allowed)
      return json(
        {
          error: {
            code: 'model_unavailable',
            reason: reservation.reason,
            message: MODEL_UNAVAILABLE_MESSAGES[reservation.reason],
          },
        },
        503
      );
    const body = z
      .object({
        resultToken: z.string().min(1).max(64_000),
        question: z.string().trim().min(2).max(1200),
        candidateId: z.string().min(1).max(30).optional(),
        investigationId: z.string().uuid().optional(),
      })
      .parse(await readBody(request, 70_000));
    const result = await readResult(request, env, body.resultToken, sessionId);
    if (!result)
      return json(
        {error: {code: 'result_expired', message: 'This result expired. Scan the articles again.'}},
        401
      );
    const selectedTopic = body.candidateId
      ? [
          ...result.connection.sharedTopics,
          ...(result.connection.path?.steps ?? []).flat(),
          ...(result.connection.path?.routes ?? []).flat(),
        ].find((topic) => String(topic.id) === body.candidateId)
      : undefined;
    if (body.candidateId && !selectedTopic)
      return json(
        {error: {code: 'invalid_topic', message: 'Choose a topic from this connection.'}},
        400
      );
    const history = body.investigationId
      ? await loadResearchHistory(env, sessionId, body.investigationId)
      : [];
    if (history === null)
      return json({error: {code: 'not_found', message: 'Investigation not found.'}}, 404);
    const investigationId = body.investigationId || (env.MONGODB_URI
      ? (await saveInvestigation(env, sessionId, result.connection, body.question)).id
      : undefined);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('Research exceeded 70 seconds.')),
      70_000
    );
    request.signal.addEventListener('abort', () => controller.abort(request.signal.reason), {
      once: true,
    });
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(streamController) {
        const emit = (event: unknown) =>
          streamController.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        void investigate(
          env,
          sessionId,
          {
            question: body.question,
            history,
            sourceId: result.connection.source.id,
            targetId: result.connection.target.id,
            sourceTitle: result.connection.source.title,
            targetTitle: result.connection.target.title,
            sharedTopic: selectedTopic?.title,
            sharedTopicId: selectedTopic?.id,
            ...(investigationId ? {investigationId} : {}),
          },
          emit,
          controller.signal
        )
          .catch((error) => console.error('research escaped', error))
          .finally(() => {
            clearTimeout(timeout);
            streamController.close();
          });
      },
      cancel() {
        controller.abort(new Error('Client disconnected.'));
        clearTimeout(timeout);
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
        ...corsHeaders,
      },
    });
  }
  const detailMatch = url.pathname.match(/^\/api\/investigations\/([0-9a-f-]{36})$/i);
  if (detailMatch && request.method === 'GET') {
    const record = await loadInvestigation(env, sessionId, detailMatch[1]);
    return record
      ? json(record)
      : json({error: {code: 'not_found', message: 'Investigation not found.'}}, 404);
  }
  if (detailMatch && request.method === 'DELETE')
    return (await deleteInvestigation(env, sessionId, detailMatch[1]))
      ? json({deleted: true})
      : json({error: {code: 'not_found', message: 'Investigation not found.'}}, 404);
  return json({error: {code: 'not_found', message: 'API endpoint not found.'}}, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await api(request, env);
      } catch (error) {
        if (error instanceof WikiError) return errorResponse(error);
        const status = (error as {status?: number})?.status;
        if (status)
          return json(
            {
              error: {
                code:
                  status === 413
                    ? 'body_too_large'
                    : status === 400
                      ? 'invalid_request'
                      : 'request_failed',
                message: error instanceof Error ? error.message : 'Request failed.',
              },
            },
            status
          );
        return errorResponse(error);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
