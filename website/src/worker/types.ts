export interface Env {
  ASSETS: {fetch(request: Request): Promise<Response>};
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  MONGODB_URI?: string;
  MONGODB_DATABASE?: string;
  SESSION_SECRET?: string;
  WOLFRAM_APP_ID?: string;
  RATE_LIMITER?: {limit(options: {key: string}): Promise<{success: boolean}>};
  MODEL_RATE_LIMITER?: {limit(options: {key: string}): Promise<{success: boolean}>};
  // Local full-graph service (sdow/graph_service.py). Unset in deployed Workers.
  GRAPH_SERVICE_URL?: string;
}

export interface Article {
  id: number;
  title: string;
  url: string;
  description?: string;
  thumbnailUrl?: string;
  disambiguation?: boolean;
  input?: string;
  redirected?: boolean;
}

export interface Evidence {
  id: string;
  sourceArticleId: number;
  sourceArticle: string;
  url: string;
  section: string;
  revisionId: string;
  retrievedAt: string;
  excerpt: string;
  kind: 'wikipedia' | 'wolfram';
  assumptions?: string;
  units?: string;
}

export interface Connection {
  id: string;
  source: Article;
  target: Article;
  sharedTopics: Article[];
  evidenceByTopic: Record<string, Evidence[]>;
  linkCompleteness: {source: boolean; target: boolean};
  status: 'found' | 'no_shared_topics' | 'partial' | 'same_article';
  retrievedAt: string;
  requestCount: number;
  linkSource?: 'live' | 'graph';
  graphSnapshot?: string;
  path?: PathInfo;
}

export interface PathInfo {
  // 'graph': shortest path from the local SDOW snapshot. 'unavailable': the path could not be
  // searched; `reason` says why.
  source: 'graph' | 'unavailable';
  found: boolean;
  hops?: number;
  routes: Article[][];
  snapshot?: string;
  reason?: string;
}

export interface SignedResult {
  sessionId: string;
  expiresAt: number;
  connection: Connection;
}
