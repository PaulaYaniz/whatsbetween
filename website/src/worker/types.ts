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
  // Kill switch for every Gemini-backed route; set to 'false' to pause AI features.
  MODEL_ENABLED?: string;
  // Shared daily cap on model-backed requests (default 200).
  DAILY_MODEL_LIMIT?: string;
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
  // From the graph: how many articles each side links to, and how many of those they share.
  linkCounts?: {source: number; target: number; shared: number};
}

export interface PathInfo {
  // 'graph': shortest path from the local SDOW snapshot. 'unavailable': the path could not be
  // searched; `reason` says why.
  source: 'graph' | 'unavailable';
  found: boolean;
  hops?: number;
  // False when the route had to follow some Wikipedia links backwards (B links to A rather than
  // A to B) to pass through at least one other article. Steps then mean "linked", not "links to".
  directed?: boolean;
  routes: Article[][];
  snapshot?: string;
  reason?: string;
  // Summary of all shortest paths: how many exist, how many the shown stops cover, the busiest
  // stops at each step, and only the real links between shown stops (as [fromId, toId]).
  totalPaths?: number;
  shownPaths?: number;
  steps?: PathStop[][];
  links?: [number, number][];
  // Steps (as [fromId, toId] in route order) where the Wikipedia link points the other way.
  reversedLinks?: [number, number][];
}

export interface PathStop extends Article {
  // Number of shortest paths that pass through this stop.
  through: number;
}

export interface SignedResult {
  discoveryCard?: import('./gemini').DiscoveryCard;
  sessionId: string;
  expiresAt: number;
  connection: Connection;
}
