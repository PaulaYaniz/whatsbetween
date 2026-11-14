import type {Env, SignedResult} from './types';

const SESSION_COOKIE = 'wb_session';
const SESSION_SECONDS = 60 * 60 * 24 * 30;

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function secretFor(request: Request, env: Env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const host = new URL(request.url).hostname;
  if (host === 'localhost' || host === '127.0.0.1') return 'local-development-only-change-before-deploy';
  throw new Error('SESSION_SECRET is required for non-local requests.');
}

async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    {name: 'HMAC', hash: 'SHA-256'},
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

function cookieValue(request: Request) {
  const cookie = request.headers.get('Cookie') || '';
  const item = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return item?.slice(SESSION_COOKIE.length + 1) || '';
}

export async function getSession(request: Request, env: Env) {
  const token = cookieValue(request);
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;
  try {
    const actual = base64UrlToBytes(signature);
    if (actual.length !== 32) return null;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secretFor(request, env)),
      {name: 'HMAC', hash: 'SHA-256'},
      false,
      ['verify']
    );
    if (!(await crypto.subtle.verify('HMAC', key, actual, new TextEncoder().encode(payload)))) return null;
    const data = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
    return typeof data.id === 'string' && data.expiresAt > Date.now() ? data.id as string : null;
  } catch {
    return null;
  }
}

export async function issueSession(request: Request, env: Env) {
  const existingSession = await getSession(request, env);
  if (existingSession) return new Response(JSON.stringify({sessionId: existingSession, expiresInSeconds: SESSION_SECONDS}), {
    headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'},
  });
  const sessionId = crypto.randomUUID();
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({
    id: sessionId,
    expiresAt: Date.now() + SESSION_SECONDS * 1000,
  })));
  const signature = bytesToBase64Url(await hmac(secretFor(request, env), payload));
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return new Response(JSON.stringify({sessionId, expiresInSeconds: SESSION_SECONDS}), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Set-Cookie': `${SESSION_COOKIE}=${payload}.${signature}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}${secure}`,
    },
  });
}

export async function signResult(request: Request, env: Env, value: SignedResult) {
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  const signature = bytesToBase64Url(await hmac(secretFor(request, env), payload));
  return `${payload}.${signature}`;
}

export async function readResult(request: Request, env: Env, token: unknown, sessionId: string) {
  if (typeof token !== 'string' || token.length > 64_000) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secretFor(request, env)),
      {name: 'HMAC', hash: 'SHA-256'},
      false,
      ['verify']
    );
    if (!(await crypto.subtle.verify('HMAC', key, base64UrlToBytes(signature),
      new TextEncoder().encode(payload)))) return null;
    const data = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))) as SignedResult;
    if (data.sessionId !== sessionId || data.expiresAt < Date.now()) return null;
    if (!data.connection || !Array.isArray(data.connection.sharedTopics)) return null;
    return data;
  } catch {
    return null;
  }
}
