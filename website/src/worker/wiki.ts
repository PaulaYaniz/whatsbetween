import type {Article, Connection, Env, Evidence, PathInfo, PathStop} from './types';
import {RequestBudget, WikiError, WikipediaTransport} from './wikiTransport';

interface WikiArticleRecord {
  article: Article;
  extract: string;
  revisionId: string;
  revisionTimestamp?: string;
}

export {WikiError, RequestBudget} from './wikiTransport';
const transport = new WikipediaTransport();
const pendingWiki = new Map<string, Promise<any>>();

const API = 'https://en.wikipedia.org/w/api.php';
const GENERIC_TITLE =
  /^(science|technology|society|culture|history|geography|country|list of |outline of |index of )/i;
const localWikiCache = new Map<string, {expiresAt: number; data: any}>();

async function cacheStore(url: string, data: unknown) {
  localWikiCache.set(url, {expiresAt: Date.now() + 60 * 60 * 1000, data});
  if (localWikiCache.size > 300)
    localWikiCache.delete(localWikiCache.keys().next().value as string);
  try {
    const cache = (caches as unknown as {default: Cache}).default;
    await cache.put(
      new Request(url),
      new Response(JSON.stringify(data), {
        headers: {'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600'},
      })
    );
  } catch {
    // Local runtimes without a Cache API still get a bounded live result.
  }
}

async function cacheRead(url: string) {
  const local = localWikiCache.get(url);
  if (local && local.expiresAt > Date.now()) return local.data;
  if (local) localWikiCache.delete(url);
  try {
    const hit = await (caches as unknown as {default: Cache}).default.match(new Request(url));
    if (hit) return (await hit.json()) as any;
  } catch {
    return null;
  }
  return null;
}

export async function queryWiki(params: Record<string, string>, budget: RequestBudget) {
  const url = new URL(API);
  url.searchParams.set('action', 'query');
  url.searchParams.set('format', 'json');
  url.searchParams.set('formatversion', '2');
  for (const [key, value] of Object.entries(params).sort(([a], [b]) => a.localeCompare(b)))
    url.searchParams.set(key, value);
  const key = url.toString();
  const cached = await cacheRead(key);
  if (cached) {
    budget.cacheHits += 1;
    return cached;
  }
  budget.check();
  const existing = pendingWiki.get(key);
  if (existing) {
    budget.cacheHits += 1;
    return existing;
  }
  const request = transport.request(key, budget).then(async (data) => {
    await cacheStore(key, data);
    return data;
  });
  pendingWiki.set(key, request);
  try {
    return await request;
  } finally {
    if (pendingWiki.get(key) === request) pendingWiki.delete(key);
  }
}

function pageArticle(page: any): Article {
  return {
    id: Number(page.pageid),
    title: String(page.title),
    url: String(
      page.fullurl ||
        `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replaceAll(' ', '_'))}`
    ),
    ...(page.description ? {description: String(page.description).slice(0, 240)} : {}),
    ...(page.thumbnail?.source ? {thumbnailUrl: String(page.thumbnail.source)} : {}),
    ...(page.pageprops?.disambiguation !== undefined ? {disambiguation: true} : {}),
    ...(page.input ? {input: String(page.input)} : {}),
  };
}

const ARTICLE_PROPS = {
  prop: 'info|description|pageimages|pageprops',
  inprop: 'url',
  piprop: 'thumbnail',
  pithumbsize: '240',
  ppprop: 'disambiguation',
  redirects: '1',
};

// Local graph lookups: no Wikipedia requests. Return null when the graph cannot answer, so the
// caller falls back to the live Wikipedia path.
function graphArticle(page: any): Article {
  return {
    id: Number(page.id),
    title: String(page.title),
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(page.title).replaceAll(' ', '_'))}`,
  };
}

async function graphGet(baseUrl: string, path: string, params: Record<string, string>) {
  try {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await fetch(url, {signal: AbortSignal.timeout(3000)});
    if (!response.ok) return null;
    return (await response.json()) as any;
  } catch {
    return null;
  }
}

async function graphSearch(baseUrl: string, query: string): Promise<Article[] | null> {
  const body = await graphGet(baseUrl, '/api/graph/search', {q: query});
  if (!body || !Array.isArray(body.results)) return null;
  return body.results.map(graphArticle);
}

async function graphPagesById(baseUrl: string, ids: number[]): Promise<Article[] | null> {
  const body = await graphGet(baseUrl, '/api/graph/pages', {ids: ids.join(',')});
  if (!body || !Array.isArray(body.pages)) return null;
  return body.pages.map(graphArticle);
}

export async function searchArticles(query: string, budget: RequestBudget, graphUrl?: string) {
  const value = query.trim().replace(/\s+/g, ' ');
  if (!value || value.length > 120 || /[#<>\[\]{}|]/.test(value)) {
    throw new WikiError('Enter a short article name to search.', 400, 'invalid_query');
  }
  if (graphUrl) {
    const local = await graphSearch(graphUrl, value);
    if (local && local.length) return {query: value, candidates: local, best: local[0]};
  }
  const exact = await queryWiki({...ARTICLE_PROPS, titles: value}, budget);
  const candidates = new Map<number, Article>();
  for (const page of exact.query?.pages || []) {
    if (page.pageid && !page.missing && page.ns === 0)
      candidates.set(page.pageid, pageArticle(page));
  }
  const exactMatch = [...candidates.values()].find((article) => !article.disambiguation);
  if (exactMatch) return {query: value, candidates: [...candidates.values()], best: exactMatch};
  const found = await queryWiki(
    {...ARTICLE_PROPS, generator: 'search', gsrsearch: value, gsrnamespace: '0', gsrlimit: '8'},
    budget
  );
  for (const page of (found.query?.pages || []).sort(
    (a: any, b: any) => (a.index || 99) - (b.index || 99)
  )) {
    if (page.pageid && !page.missing && page.ns === 0 && !candidates.has(page.pageid)) {
      candidates.set(page.pageid, pageArticle(page));
    }
  }
  const list = [...candidates.values()].slice(0, 8);
  return {
    query: value,
    candidates: list,
    best: list.find((page) => !page.disambiguation) || list[0] || null,
  };
}

export async function articleDetails(ids: number[], budget: RequestBudget, fullText = false): Promise<WikiArticleRecord[]> {
  const unique = [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, 14);
  if (!unique.length) return [];
  const data = await queryWiki(
    {
      prop: 'info|description|pageimages|pageprops|extracts|revisions',
      inprop: 'url',
      piprop: 'thumbnail',
      pithumbsize: '240',
      ppprop: 'disambiguation',
      ...(fullText ? {} : {exchars: '1200', exintro: '1'}),
      exlimit: fullText ? '1' : 'max',
      explaintext: '1',
      exsectionformat: 'plain',
      rvprop: 'ids|timestamp',
      pageids: unique.join('|'),
      redirects: '1',
    },
    budget
  );
  return (data.query?.pages || [])
    .filter((page: any) => page.pageid && !page.missing)
    .map((page: any) => ({
      article: pageArticle(page),
      extract: String(page.extract || '').slice(0, fullText ? 24000 : 9000),
      revisionId: String(page.revisions?.[0]?.revid || ''),
      revisionTimestamp: String(page.revisions?.[0]?.timestamp || ''),
    }));
}

async function outgoingLinks(pageId: number, budget: RequestBudget, maxPages = 3) {
  const all = new Map<
    number,
    {id: number; title: string; disambiguation: boolean; description?: string}
  >();
  let continuation: Record<string, string> = {};
  let complete = false;
  for (let page = 0; page < maxPages; page += 1) {
    const data = await queryWiki(
      {
        generator: 'links',
        pageids: String(pageId),
        gplnamespace: '0',
        gpllimit: 'max',
        prop: 'pageprops|description',
        ppprop: 'disambiguation',
        redirects: '1',
        ...continuation,
      },
      budget
    );
    for (const item of data.query?.pages || []) {
      if (!item.pageid || item.ns !== 0 || item.missing) continue;
      all.set(Number(item.pageid), {
        id: Number(item.pageid),
        title: String(item.title),
        disambiguation: item.pageprops?.disambiguation !== undefined,
        ...(item.description ? {description: String(item.description).slice(0, 240)} : {}),
      });
    }
    if (!data.continue) {
      complete = true;
      break;
    }
    continuation = Object.fromEntries(
      Object.entries(data.continue).map(([key, value]) => [key, String(value)])
    );
  }
  return {links: [...all.values()], complete};
}

function passage(extract: string, topic: string) {
  const clean = extract.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const index = clean.toLocaleLowerCase().indexOf(topic.toLocaleLowerCase());
  if (index < 0) return clean.slice(0, 520);
  const start = Math.max(0, index - 220);
  const end = Math.min(clean.length, index + topic.length + 300);
  const left = start ? '…' : '';
  const right = end < clean.length ? '…' : '';
  return `${left}${clean.slice(start, end)}${right}`;
}

function evidenceFor(
  article: Article,
  extract: string,
  revisionId: string,
  topic: Article,
  retrievedAt: string
): Evidence {
  return {
    id: `wiki:${topic.id}:${article.id}`,
    sourceArticleId: article.id,
    sourceArticle: article.title,
    url: article.url,
    section: 'Article text',
    revisionId,
    retrievedAt,
    excerpt: passage(extract, topic.title),
    kind: 'wikipedia',
  };
}

// Shortest path between two articles from the local graph service. Never throws: the result
// always says whether a path was searched, so the UI can show it or explain why not.
export async function graphPath(
  baseUrl: string,
  sourceId: number,
  targetId: number,
  perStep = 6
): Promise<PathInfo> {
  try {
    const url = new URL('/api/graph/path', baseUrl);
    url.searchParams.set('source', String(sourceId));
    url.searchParams.set('target', String(targetId));
    url.searchParams.set('perStep', String(perStep));
    url.searchParams.set('preferIndirect', '1');
    const response = await fetch(url, {signal: AbortSignal.timeout(8000)});
    const body = (await response.json()) as any;
    if (!response.ok) {
      return {
        source: 'unavailable',
        found: false,
        routes: [],
        reason: body?.code || `graph_${response.status}`,
      };
    }
    const toArticle = (page: any): Article => ({
      id: Number(page.id),
      title: String(page.title),
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(page.title).replaceAll(' ', '_'))}`,
    });
    const toStop = (page: any): PathStop => ({
      ...toArticle(page),
      through: Number(page.through) || 0,
    });
    const routes: Article[][] = (body.paths || []).map((route: any[]) => route.map(toArticle));
    return {
      source: 'graph',
      found: Boolean(body.found),
      hops: typeof body.hops === 'number' ? body.hops : undefined,
      directed: typeof body.directed === 'boolean' ? body.directed : undefined,
      routes,
      totalPaths: Number(body.totalPaths) || 0,
      shownPaths: Number(body.shownPaths) || 0,
      steps: (body.steps || []).map((column: any[]) => column.map(toStop)),
      links: (body.links || [])
        .filter((link: unknown) => Array.isArray(link) && link.length === 2)
        .map((link: number[]) => [Number(link[0]), Number(link[1])] as [number, number]),
      reversedLinks: (body.reversedLinks || [])
        .filter((link: unknown) => Array.isArray(link) && link.length === 2)
        .map((link: number[]) => [Number(link[0]), Number(link[1])] as [number, number]),
      snapshot: typeof body.snapshot === 'string' ? body.snapshot : undefined,
      ...(body.found ? {} : {reason: 'no_path_within_limit'}),
    };
  } catch {
    return {source: 'unavailable', found: false, routes: [], reason: 'graph_unreachable'};
  }
}

export async function connectArticles(
  sourceId: number,
  targetId: number,
  budget: RequestBudget,
  graphUrl?: string
): Promise<Connection> {
  if (
    !Number.isSafeInteger(sourceId) ||
    sourceId <= 0 ||
    !Number.isSafeInteger(targetId) ||
    targetId <= 0
  ) {
    throw new WikiError('Choose two valid English Wikipedia articles.', 400, 'invalid_article');
  }
  // Both articles come from the local graph when it knows them; otherwise ask Wikipedia.
  const local = graphUrl ? await graphPagesById(graphUrl, [sourceId, targetId]) : null;
  const localSource = local?.find((article) => article.id === sourceId);
  const localTarget = local?.find((article) => article.id === targetId);
  const records: WikiArticleRecord[] =
    localSource && localTarget ? [] : await articleDetails([sourceId, targetId], budget);
  const source =
    localSource ??
    records.find((record: WikiArticleRecord) => record.article.id === sourceId)?.article;
  const target =
    localTarget ??
    records.find((record: WikiArticleRecord) => record.article.id === targetId)?.article;
  if (!source || !target)
    throw new WikiError('One selected article is no longer available.', 404, 'missing_article');
  const retrievedAt = new Date().toISOString();
  if (source.id === target.id) {
    return {
      id: crypto.randomUUID(),
      source,
      target,
      sharedTopics: [],
      evidenceByTopic: {},
      linkCompleteness: {source: true, target: true},
      status: 'same_article',
      retrievedAt,
      requestCount: budget.used,
      path: {source: 'graph', found: true, hops: 0, routes: [[source]]},
    };
  }

  // Discovery uses connecting routes only; no independent shared-topic lookup.
  let selected: Article[] = [];
  const linkCompleteness = {source: true, target: true};
  const path = await pathFor(graphUrl, source.id, target.id);
  // Old snapshots may retain pages that now redirect (for example, object synonyms).
  // Resolve each endpoint separately so canonical IDs remain associated with the right pick.
  if (!path.found && budget.used + 2 <= budget.limit) {
    try {
      const currentSource = (await articleDetails([source.id], budget))[0]?.article;
      const currentTarget = (await articleDetails([target.id], budget))[0]?.article;
      if (
        currentSource &&
        currentTarget &&
        (currentSource.id !== source.id || currentTarget.id !== target.id)
      ) {
        return connectArticles(currentSource.id, currentTarget.id, budget, graphUrl);
      }
    } catch (error) {
      if (!(error instanceof WikiError)) throw error;
    }
  }

  // One batched Wikipedia request (max 14 pages) supplies descriptions and pictures for both
  // objects plus either the shared topics or, when there are none, the stops along the routes.
  // Descriptions for the shown stops (busiest first), within the 14-page batch.
  const pathStops = [
    ...new Set([
      ...(path.steps ?? []).flat().map((node) => node.id),
      ...path.routes.flatMap((route) => route.slice(1, -1).map((node) => node.id)),
    ]),
  ];
  let details: WikiArticleRecord[] = [];
  if (budget.used < budget.limit) {
    // Descriptions, pictures and passages are a bonus on top of the graph result: if Wikipedia is
    // slow or throttling, give up after a few seconds and still return the map.
    const ids = [
      source.id,
      target.id,
      ...(selected.length ? selected.map((item) => item.id) : pathStops),
    ];
    const giveUp = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new WikiError('Wikipedia details timed out.', 504, 'time_limit')),
        6000
      )
    );
    try {
      details = await Promise.race([articleDetails(ids, budget), giveUp]);
    } catch (error) {
      if (!(error instanceof WikiError)) throw error;
    }
  }
  const byId = new Map<number, WikiArticleRecord>(
    details.map((record: WikiArticleRecord) => [record.article.id, record])
  );
  // The snapshot is from 2023: drop topics whose pages no longer resolve on Wikipedia.

  const enrich = <T extends {id: number}>(item: T): T => {
    const live = byId.get(item.id)?.article;
    if (!live) return item;
    return {
      ...item,
      ...(live.description ? {description: live.description} : {}),
      ...(live.thumbnailUrl ? {thumbnailUrl: live.thumbnailUrl} : {}),
    };
  };
  const shownSource = enrich(source);
  const shownTarget = enrich(target);
  selected = selected.map(enrich);
  const shownPath: PathInfo = {
    ...path,
    routes: path.routes.map((route) => route.map(enrich)),
    ...(path.steps ? {steps: path.steps.map((column) => column.map(enrich))} : {}),
  };
  const evidenceByTopic: Record<string, Evidence[]> = {};
  for (const topic of selected) {
    const sourceRecord = byId.get(source.id);
    const targetRecord = byId.get(target.id);
    const topicRecord = byId.get(topic.id);
    const evidence: (Evidence | undefined)[] = [
      sourceRecord &&
        evidenceFor(source, sourceRecord.extract, sourceRecord.revisionId, topic, retrievedAt),
      targetRecord &&
        evidenceFor(target, targetRecord.extract, targetRecord.revisionId, topic, retrievedAt),
      topicRecord &&
        evidenceFor(topic, topicRecord.extract, topicRecord.revisionId, topic, retrievedAt),
    ];
    const verifiedEvidence = evidence.filter((item): item is Evidence => !!item && !!item.excerpt);
    evidenceByTopic[String(topic.id)] = verifiedEvidence;
  }
  return {
    id: crypto.randomUUID(),
    source: shownSource,
    target: shownTarget,
    sharedTopics: selected,
    evidenceByTopic,
    linkCompleteness,
    status: path.found ? 'found' : 'no_shared_topics',
    retrievedAt,
    requestCount: budget.used,
    linkSource: 'graph',
    graphSnapshot: path.snapshot,
    path: shownPath,
  };
}

function pathFor(
  graphUrl: string | undefined,
  sourceId: number,
  targetId: number
): Promise<PathInfo> {
  if (!graphUrl)
    return Promise.resolve({
      source: 'unavailable',
      found: false,
      routes: [],
      reason: 'graph_not_configured',
    });
  return graphPath(graphUrl, sourceId, targetId);
}

export function discoveryEvidence(connection: Connection, candidateId: string) {
  const topic = connection.sharedTopics.find((item) => String(item.id) === candidateId);
  if (!topic) return null;
  const evidence = connection.evidenceByTopic[candidateId] || [];
  const source = evidence.find((item) => item.sourceArticleId === connection.source.id);
  const target = evidence.find((item) => item.sourceArticleId === connection.target.id);
  if (!source || !target) return null;
  // A plain link establishes graph structure, not a causal explanation. Return
  // available passages and let the generated card use only those passages.
  return {topic, evidence};
}
