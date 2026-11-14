import {SDOW_API_URL} from '../resources/constants';

export interface WikiArticle {
  readonly id: number;
  readonly title: string;
  readonly url: string;
  readonly description?: string;
  readonly thumbnailUrl?: string;
  readonly disambiguation?: boolean;
  readonly match?: 'exact' | 'search';
}

export interface ResolveResponse {
  readonly query: string;
  readonly best: WikiArticle | null;
  readonly candidates: readonly WikiArticle[];
}

export type PathMethod = 'direct' | 'two_hop_exhaustive' | 'two_hop_partial' | 'three_hop_bounded';

export interface ConnectResponse {
  readonly source: WikiArticle & {readonly input: string; readonly redirected: boolean};
  readonly target: WikiArticle & {readonly input: string; readonly redirected: boolean};
  readonly status: 'found' | 'not_found' | 'same_article';
  readonly paths: readonly (readonly number[])[];
  readonly pathCount?: number;
  readonly degrees: number | null;
  readonly shortest: boolean;
  readonly exhaustive: boolean;
  readonly method?: PathMethod;
  readonly hubsChecked?: number;
  readonly sharedTopics: readonly number[];
  readonly genericTopics?: readonly number[];
  readonly sharedComplete?: boolean;
  readonly linkCounts?: {
    readonly sourceOutgoing: number;
    readonly sourceOutgoingComplete: boolean;
    readonly targetOutgoing: number;
    readonly targetOutgoingComplete: boolean;
    readonly targetIncoming: number;
    readonly targetIncomingComplete: boolean;
  };
  readonly pages: Readonly<Record<string, WikiArticle>>;
  readonly retrievedAt: number;
  readonly stats: {
    readonly requests: number;
    readonly cachedResponses: number;
    readonly budgetExhausted: boolean;
    readonly elapsedMs: number;
  };
}

async function request<T>(path: string, init?: RequestInit, timeout = 30000): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${SDOW_API_URL}/wiki${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(timeout),
    });
  } catch (error) {
    if (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name))
      throw error;
    throw new Error('The local backend is unreachable. Start Flask on port 5001.', {cause: error});
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(data.error || 'Wikipedia request failed.'));
  return data as T;
}

export function resolveArticle(label: string, signal?: AbortSignal) {
  return request<ResolveResponse>(`/resolve?q=${encodeURIComponent(label)}`, {signal});
}

export function connectArticles(source: string, target: string, signal?: AbortSignal) {
  return request<ConnectResponse>(
    '/connect',
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({source, target}),
      signal,
    },
    35000
  );
}
