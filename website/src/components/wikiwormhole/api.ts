import type {Article, Connection, Evidence, PathInfo, PathStop} from '../../worker/types';

export interface Card {
  candidateId: string;
  headline: string;
  explanationSource: string;
  explanationTarget: string;
  whyInteresting: string;
  suggestedQuestions?: string[];
  evidenceIds: string[];
  evidence?: Evidence[];
}
export interface Finding {
  status: string;
  finding: string;
  claims: {claim: string; evidenceIds: string[]}[];
  uncertainty: string;
  followUp: string;
  evidence: Evidence[];
  stoppedAt?: string;
  saved?: any;
}
export type DiscoveryResponse = {
  status: string;
  card?: Card;
  reason?: string;
  topic?: Article;
  evidence?: Evidence[];
};

let sessionReady: Promise<void> | null = null;
async function ensureSession() {
  if (!sessionReady)
    sessionReady = fetch('/api/session', {credentials: 'same-origin'})
      .then((response) => {
        if (!response.ok) throw new Error('Could not start a browser session.');
      })
      .catch((error) => {
        sessionReady = null;
        throw error;
      });
  return sessionReady;
}

// Carries the server's error code (for example 'result_expired') so pages can recover.
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (path !== '/session') await ensureSession();
  const response = await fetch(`/api${path}`, {credentials: 'same-origin', ...init});
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ApiError(
      data.error?.message || 'That request could not be completed.',
      data.error?.code,
      response.status
    );
  return data as T;
}

type ArticleSearch = {candidates: Article[]; best: Article | null};
const articleSearchCache = new Map<string, {expiresAt: number; result: Promise<ArticleSearch>}>();
export function searchArticles(query: string) {
  const value = query.trim().replace(/\s+/g, ' ');
  const key = value.toLocaleLowerCase();
  const cached = articleSearchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const result = api<ArticleSearch>(`/articles?q=${encodeURIComponent(value)}`);
  articleSearchCache.set(key, {expiresAt: Date.now() + 5 * 60_000, result});
  if (articleSearchCache.size > 100)
    articleSearchCache.delete(articleSearchCache.keys().next().value as string);
  void result.catch(() => {
    if (articleSearchCache.get(key)?.result === result) articleSearchCache.delete(key);
  });
  return result;
}

export async function connect(source: Article, target: Article) {
  return api<{connection: Connection; resultToken: string}>('/connect', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({sourceId: source.id, targetId: target.id}),
  });
}

export async function recognize(image: File) {
  if (image.type !== 'image/jpeg') throw new Error('Choose a JPEG image.');
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Image could not be read.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.readAsDataURL(image);
  });
  return api<{objects: {label: string; box_2d: [number, number, number, number]}[]}>('/recognize', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({imageBase64: base64, mimeType: 'image/jpeg'}),
  });
}

export type {Article, Connection, Evidence, PathInfo, PathStop};
