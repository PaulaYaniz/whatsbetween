"""Bounded live Wikipedia path search over the MediaWiki Action API.

The local SDOW SQLite graph is a 35-page mock, so object pairs are connected using live
English Wikipedia links instead. Every displayed edge is confirmed by an API response:

  * A -> X        X is in A's outgoing article links (redirects resolved, like a click).
  * X -> B        X links to B or to one of B's redirects (backlinks or pltitles check).
  * A -> X <- B   shared topic: both articles link to X. This is not a directed path.

Depth one and two are searched exhaustively when every link list is fully retrieved. Depth
three is a bounded heuristic over the most prominent pages linking to B. A depth-three path
is only reported as shortest when the depth-two search was exhaustive.
"""
from concurrent.futures import ThreadPoolExecutor
import os
import re
import threading
import time

import requests
from flask import Blueprint, jsonify, request

API_URL = 'https://en.wikipedia.org/w/api.php'
DEFAULT_USER_AGENT = ('WikiWormhole/0.1 (local research prototype derived from Six Degrees of '
                      'Wikipedia; https://github.com/jwngr/sdow) python-requests')
MAX_TITLE_LENGTH = 255
BATCH = 50              # MediaWiki limit for titles= and pltitles= per request.
MAX_PATHS = 40
MAX_SHARED_DETAILS = 30
# Pages that are linked from almost every article through citation templates. They are real
# links, but they make poor evidence of a relationship between two objects.
GENERIC_TITLES = {
    'Wayback Machine', 'Wikidata', 'Wikimedia Commons', 'Wiktionary', 'Wikisource', 'ISBN',
    'ISSN', 'Digital object identifier', 'International Standard Book Number', 'PubMed',
    'PubMed Central', 'JSTOR', 'Bibcode', 'Semantic Scholar', 'OCLC', 'Library of Congress',
    'Library of Congress Control Number', 'Integrated Authority File', 'S2CID', 'Doi',
    'Virtual International Authority File', 'Main Page', 'Handle System', 'National Geographic',
    'Springer Nature', 'Elsevier', 'Wiley-Blackwell', 'Routledge', 'Penguin Books', 'HarperCollins',
    'Encyclopædia Britannica', 'The New York Times', 'The Guardian', 'BBC News', 'Reuters',
}
GENERIC_PATTERN = re.compile(r' \(identifier\)$|^(List|Lists|Index|Outline|Glossary) of |'
                             r' University Press$|^Archive\.| \(disambiguation\)$')


def is_generic(title):
  return title in GENERIC_TITLES or bool(GENERIC_PATTERN.search(title))


class WikiError(Exception):
  def __init__(self, message, status=400, code='invalid_request'):
    super().__init__(message)
    self.message, self.status, self.code = message, status, code


class Budget:
  """Request and wall-clock limits shared by all upstream calls of one search."""

  def __init__(self, max_requests, seconds, clock=time.monotonic):
    self.max_requests, self.clock = max_requests, clock
    self.deadline = clock() + seconds
    self.requests = self.cached = 0
    self.exhausted = False
    self.lock = threading.Lock()

  def take(self):
    with self.lock:
      if self.requests >= self.max_requests or self.clock() >= self.deadline:
        self.exhausted = True
        return False
      self.requests += 1
      return True

  def remaining(self):
    with self.lock:
      return max(0, self.max_requests - self.requests)


class WikiClient:
  """Thin MediaWiki client with response caching and continuation handling."""

  def __init__(self, get=None, user_agent=None, cache_seconds=3600, cache_size=2048):
    self.session = requests.Session()
    self.session.headers['User-Agent'] = (user_agent or os.environ.get('WIKIMEDIA_USER_AGENT') or
                                          DEFAULT_USER_AGENT)
    self.get = get or self._http_get
    self.cache, self.cache_seconds, self.cache_size = {}, cache_seconds, cache_size
    self.lock = threading.Lock()

  def _http_get(self, params):
    for attempt in range(2):
      response = self.session.get(API_URL, params=params, timeout=8)
      if response.status_code != 429:
        break
      if attempt == 0:
        # One polite retry, honoring Retry-After within a short cap.
        try:
          wait = float(response.headers.get('Retry-After', '2'))
        except ValueError:
          wait = 2
        time.sleep(min(max(wait, 1), 5))
    if response.status_code == 429:
      raise WikiError('Wikipedia is rate limiting requests. Wait a minute and try again.', 503,
                      'upstream_throttled')
    response.raise_for_status()
    return response.json()

  def query(self, params, budget):
    """One API request. Returns None (without calling upstream) when the budget is spent."""
    full = {'action': 'query', 'format': 'json', 'formatversion': '2', 'maxlag': '5', **params}
    key = tuple(sorted(full.items()))
    now = time.time()
    with self.lock:
      hit = self.cache.get(key)
      if hit and now - hit[0] < self.cache_seconds:
        budget.cached += 1
        return hit[1]
    if not budget.take():
      return None
    try:
      data = self.get(full)
    except WikiError:
      raise
    except (requests.RequestException, ValueError):
      raise WikiError('Could not reach Wikipedia. Check the connection and try again.', 502,
                      'upstream_unavailable') from None
    if 'error' in data:
      raise WikiError('Wikipedia rejected the request. Try again shortly.', 502, 'upstream_error')
    with self.lock:
      if len(self.cache) >= self.cache_size:
        self.cache.pop(next(iter(self.cache)))
      self.cache[key] = (now, data)
    return data

  def query_all(self, params, budget, max_requests):
    """Follows `continue` tokens. Returns (responses, complete)."""
    responses, extra = [], {}
    for _ in range(max_requests):
      data = self.query({**params, **extra}, budget)
      if data is None:
        return responses, False
      responses.append(data)
      if 'continue' not in data:
        return responses, True
      extra = {k: v for k, v in data['continue'].items()}
    return responses, False


def _resolution_map(query):
  """Maps each input title to its final title through normalization and redirects."""
  mapping = {}
  for step in query.get('normalized', []) + query.get('redirects', []):
    mapping[step['from']] = step['to']

  def final(title):
    seen = set()
    while title in mapping and title not in seen:
      seen.add(title)
      title = mapping[title]
    return title
  return final


def _page_record(page):
  record = {
      'id': page['pageid'],
      'title': page['title'],
      'url': page.get('fullurl') or 'https://en.wikipedia.org/wiki/' + page['title'].replace(' ', '_'),
  }
  if page.get('description'):
    record['description'] = page['description'][:1].upper() + page['description'][1:]
  if page.get('thumbnail', {}).get('source'):
    record['thumbnailUrl'] = page['thumbnail']['source']
  if 'disambiguation' in page.get('pageprops', {}):
    record['disambiguation'] = True
  return record


DETAIL_PARAMS = {'prop': 'info|description|pageimages|pageprops', 'inprop': 'url',
                 'piprop': 'thumbnail', 'pithumbsize': '160', 'ppprop': 'disambiguation',
                 'redirects': '1'}


def _validate_title(value, name):
  if not isinstance(value, str) or not value.strip():
    raise WikiError(f'Enter an article title for {name}.')
  value = ' '.join(value.split())
  if len(value) > MAX_TITLE_LENGTH or any(c in value for c in '#<>[]{}|'):
    raise WikiError(f'"{value[:60]}" is not a valid Wikipedia title.')
  return value


class PathFinder:
  def __init__(self, client=None, max_requests=70, seconds=20, workers=2):
    self.client = client or WikiClient()
    self.max_requests, self.seconds, self.workers = max_requests, seconds, workers

  # --- Article resolution -------------------------------------------------------------------

  def resolve(self, label):
    """Candidate articles for an object label: exact title first, then search results."""
    label = _validate_title(label, 'the object')
    budget = Budget(4, 8)
    exact = self.client.query({**DETAIL_PARAMS, 'titles': label}, budget) or {}
    candidates, seen = [], set()
    for page in exact.get('query', {}).get('pages', []):
      if 'missing' not in page and 'invalid' not in page and page.get('ns') == 0:
        record = _page_record(page)
        record['match'] = 'exact'
        candidates.append(record)
        seen.add(record['id'])
    found = self.client.query({**DETAIL_PARAMS, 'generator': 'search', 'gsrsearch': label,
                               'gsrnamespace': '0', 'gsrlimit': '8'}, budget) or {}
    ranked = sorted(found.get('query', {}).get('pages', []), key=lambda p: p.get('index', 99))
    for page in ranked:
      if 'missing' in page or page.get('pageid') in seen:
        continue
      record = _page_record(page)
      record['match'] = 'search'
      candidates.append(record)
      seen.add(record['id'])
    # Prefer a real article over a disambiguation page, without hiding the alternatives.
    best = next((c for c in candidates if not c.get('disambiguation')), None)
    return {'query': label, 'best': best, 'candidates': candidates[:8]}

  def _resolve_pair(self, source, target, budget):
    data = self.client.query({**DETAIL_PARAMS, 'titles': f'{source}|{target}'}, budget)
    if data is None:
      raise WikiError('Search budget exhausted before resolving the articles.', 503, 'budget')
    query = data.get('query', {})
    final = _resolution_map(query)
    pages = {p['title']: p for p in query.get('pages', [])}
    resolved = []
    for name, title in (('first object', source), ('second object', target)):
      page = pages.get(final(title))
      if not page or 'missing' in page or 'invalid' in page or page.get('ns') != 0:
        raise WikiError(f'No English Wikipedia article named "{title}" for the {name}. '
                        'Choose another article.', 404, 'missing_article')
      record = _page_record(page)
      record['input'] = title
      record['redirected'] = final(title) != title
      resolved.append(record)
    return resolved

  # --- Link retrieval -------------------------------------------------------------------------

  def _outgoing(self, title, budget, max_requests=6):
    """Canonical article links from `title`: {pageid: title}, complete flag."""
    responses, complete = self.client.query_all({
        'generator': 'links', 'titles': title, 'gplnamespace': '0', 'gpllimit': 'max',
        'redirects': '1', 'prop': 'pageprops', 'ppprop': 'disambiguation'}, budget, max_requests)
    links, disambiguation = {}, set()
    for data in responses:
      for page in data.get('query', {}).get('pages', []):
        if 'pageid' in page and page.get('ns') == 0:
          links[page['pageid']] = page['title']
          if 'disambiguation' in page.get('pageprops', {}):
            disambiguation.add(page['pageid'])
    return links, disambiguation, complete

  def _incoming(self, title, budget, max_requests=6):
    """Articles linking to `title` directly or via a redirect. Also returns redirect titles."""
    responses, complete = self.client.query_all({
        'list': 'backlinks', 'bltitle': title, 'blnamespace': '0', 'bllimit': 'max',
        'blredirect': '1'}, budget, max_requests)
    linkers, redirects = {}, [title]
    for data in responses:
      for item in data.get('query', {}).get('backlinks', []):
        if item.get('redirect'):
          redirects.append(item['title'])
          for inner in item.get('redirlinks', []):
            linkers[inner['pageid']] = inner['title']
        else:
          linkers[item['pageid']] = item['title']
    return linkers, redirects, complete

  def _redirects(self, title, budget):
    """Titles that redirect to `title` (article namespace), plus the title itself."""
    responses, complete = self.client.query_all({
        'prop': 'redirects', 'titles': title, 'rdnamespace': '0', 'rdlimit': 'max'}, budget, 2)
    titles = [title]
    for data in responses:
      for page in data.get('query', {}).get('pages', []):
        titles += [item['title'] for item in page.get('redirects', [])]
    return titles, complete

  def _links_into(self, sources, targets, budget):
    """Which `sources` link to which `targets` (all titles)? Returns ({src: set}, complete)."""
    batches = [(sources[i:i + BATCH], '|'.join(targets[j:j + BATCH]))
               for j in range(0, len(targets), BATCH) for i in range(0, len(sources), BATCH)]

    def check(pair):
      batch, joined_targets = pair
      responses, complete = self.client.query_all({
          'prop': 'links', 'titles': '|'.join(batch), 'pltitles': joined_targets,
          'pllimit': 'max'}, budget, 3)
      found = {}
      for data in responses:
        for page in data.get('query', {}).get('pages', []):
          titles = {link['title'] for link in page.get('links', [])}
          if titles:
            found.setdefault(page['title'], set()).update(titles)
      return found, complete and len(responses) > 0

    result, complete = {}, True
    with ThreadPoolExecutor(max_workers=self.workers) as pool:
      for found, done in pool.map(check, batches):
        complete = complete and done
        for key, value in found.items():
          result.setdefault(key, set()).update(value)
    return result, complete

  def _hubs(self, title, budget, offset=0):
    """Prominent articles linking to `title`, ranked by search relevance."""
    data = self.client.query({'list': 'search', 'srsearch': f'linksto:"{title}"',
                              'srnamespace': '0', 'srlimit': str(BATCH), 'sroffset': str(offset),
                              'srprop': ''}, budget)
    if data is None:
      return []
    return [(item['pageid'], item['title']) for item in data.get('query', {}).get('search', [])]

  def _details(self, page_ids, budget):
    ids = [str(i) for i in dict.fromkeys(page_ids)]
    pages = {}
    for start in range(0, len(ids), BATCH):
      params = {k: v for k, v in DETAIL_PARAMS.items() if k != 'redirects'}
      data = self.client.query({**params, 'pageids': '|'.join(ids[start:start + BATCH])}, budget)
      if data is None:
        break
      for page in data.get('query', {}).get('pages', []):
        if 'pageid' in page and 'missing' not in page:
          pages[page['pageid']] = _page_record(page)
    return pages

  # --- Search --------------------------------------------------------------------------------

  def connect(self, source, target):
    started = time.monotonic()
    source = _validate_title(source, 'the first object')
    target = _validate_title(target, 'the second object')
    budget = Budget(self.max_requests, self.seconds)
    a, b = self._resolve_pair(source, target, budget)
    response = {'source': a, 'target': b, 'paths': [], 'sharedTopics': [], 'pages': {},
                'retrievedAt': int(time.time() * 1000)}
    if a['id'] == b['id']:
      response.update(status='same_article', degrees=0, shortest=True, exhaustive=True)
      return self._finish(response, budget, started, [a['id']])

    with ThreadPoolExecutor(max_workers=self.workers) as pool:
      out_a = pool.submit(self._outgoing, a['title'], budget)
      out_b = pool.submit(self._outgoing, b['title'], budget)
      into_b = pool.submit(self._incoming, b['title'], budget)
      forward, disamb_a, forward_complete = out_a.result()
      from_b, disamb_b, from_b_complete = out_b.result()
      incoming, _, incoming_complete = into_b.result()

    titles = {**forward, **from_b, **incoming, a['id']: a['title'], b['id']: b['title']}
    noise = disamb_a | disamb_b
    paths, shortest, exhaustive = [], False, False
    depth2_exhaustive, hubs_checked = False, 0

    if b['id'] in forward:
      paths = [[a['id'], b['id']]]
      shortest = exhaustive = forward_complete
    else:
      # Depth two: X in links(A) and X links to B.
      middle = set(forward) & set(incoming)
      middle.discard(a['id'])
      depth2_exhaustive = forward_complete and incoming_complete
      if not incoming_complete and forward_complete and budget.remaining() > 0:
        # B has too many backlinks to list. Check A's links against B (and its redirects)
        # directly instead; this is exact when every batch completes.
        redirects_b, redirects_complete = self._redirects(b['title'], budget)
        found, done = self._links_into(sorted(forward.values()), redirects_b, budget)
        ids = {t: i for i, t in forward.items()}
        middle |= {ids[t] for t in found if t in ids}
        depth2_exhaustive = done and redirects_complete
      if middle:
        def rank(x):
          return (is_generic(titles[x]) or x in noise, x not in from_b, titles[x].lower())
        paths = [[a['id'], x, b['id']] for x in sorted(middle, key=rank)]
        shortest = exhaustive = depth2_exhaustive
      else:
        paths, hubs_checked = self._depth_three(a, b, forward, incoming, titles, budget)
        # Length three is provably shortest only if length <= 2 was ruled out completely.
        shortest = bool(paths) and depth2_exhaustive
        exhaustive = False

    # Shared topics: A -> X <- B. Complete only when both outgoing lists were complete.
    shared = (set(forward) & set(from_b)) - {a['id'], b['id']}
    on_path = {node for path in paths[:MAX_PATHS] for node in path[1:-1]}
    shared_sorted = sorted(shared, key=lambda x: (is_generic(titles[x]) or x in noise,
                                                  x not in on_path, titles[x].lower()))
    response['sharedTopics'] = shared_sorted
    response['sharedComplete'] = forward_complete and from_b_complete
    response['paths'] = paths[:MAX_PATHS]
    response['pathCount'] = len(paths)
    response['degrees'] = len(paths[0]) - 1 if paths else None
    response['shortest'] = shortest
    response['exhaustive'] = exhaustive
    # Plain-language scope for the UI. Never overstate what was searched.
    if paths and len(paths[0]) == 2:
      method = 'direct'
    elif paths and len(paths[0]) == 3:
      method = 'two_hop_exhaustive' if depth2_exhaustive else 'two_hop_partial'
    else:
      method = 'three_hop_bounded'
    response['method'] = method
    response['depthTwoExhaustive'] = depth2_exhaustive
    response['hubsChecked'] = hubs_checked
    response['genericTopics'] = [x for x in shared_sorted if is_generic(titles[x]) or x in noise]
    response['status'] = 'found' if paths else 'not_found'
    response['linkCounts'] = {
        'sourceOutgoing': len(forward), 'sourceOutgoingComplete': forward_complete,
        'targetOutgoing': len(from_b), 'targetOutgoingComplete': from_b_complete,
        'targetIncoming': len(incoming), 'targetIncomingComplete': incoming_complete,
    }
    detail_ids = [a['id'], b['id']] + [n for p in paths[:12] for n in p] + \
        shared_sorted[:MAX_SHARED_DETAILS]
    response['titles'] = {str(i): titles[i] for i in set(on_path) | set(shared_sorted) if i in titles}
    return self._finish(response, budget, started, detail_ids)

  def _depth_three(self, a, b, forward, incoming, titles, budget):
    """Bounded: A -> X -> Y -> B with Y drawn from the most prominent pages linking to B."""
    if not forward:
      return [], 0
    sources = sorted(forward.values())
    title_ids = {t: i for i, t in forward.items()}
    paths, offset = [], 0
    # Reserve requests for page details after the search.
    while budget.remaining() > len(sources) // BATCH + 4 and offset < 150:
      hubs = [(i, t) for i, t in self._hubs(b['title'], budget, offset) if i not in (a['id'],)]
      if not hubs and offset == 0 and incoming:
        hubs = list(incoming.items())[:BATCH]
      if not hubs:
        break
      offset += BATCH
      hub_titles = {t: i for i, t in hubs}
      titles.update({i: t for i, t in hubs})
      found, _ = self._links_into(sources, list(hub_titles), budget)
      for source_title, linked in found.items():
        x = title_ids.get(source_title)
        if x is None or x == b['id']:
          continue
        for y_title in linked:
          y = hub_titles.get(y_title)
          if y is not None and y != x:
            paths.append([a['id'], x, y, b['id']])
      if paths:
        # The search index can lag behind edits: re-check every Y -> B edge directly.
        redirects_b, _ = self._redirects(b['title'], budget)
        ys = sorted({titles[p[2]] for p in paths})
        verified, _ = self._links_into(ys, redirects_b, budget)
        paths = [p for p in paths if titles[p[2]] in verified]
        if not paths:
          continue
        # Interleave intermediates so alternatives are not all routed through one hub.
        hub_rank = {i: n for n, (i, _) in enumerate(hubs)}
        paths.sort(key=lambda p: (hub_rank.get(p[2], 99), titles[p[1]].lower()))
        seen = {}
        for path in paths:
          path.append(seen.get(path[2], 0))
          seen[path[2]] = path[-1] + 1
        paths.sort(key=lambda p: (is_generic(titles[p[1]]) or is_generic(titles[p[2]]),
                                  p[-1], hub_rank.get(p[2], 99)))
        return [path[:-1] for path in paths], offset
    return paths, offset

  def _finish(self, response, budget, started, detail_ids):
    pages = self._details(detail_ids, Budget(4, 6)) if detail_ids else {}
    # Fall back to bare titles so every node still has a working Wikipedia link.
    for page_id, title in response.get('titles', {}).items():
      if int(page_id) not in pages:
        pages[int(page_id)] = {'id': int(page_id), 'title': title,
                               'url': 'https://en.wikipedia.org/wiki/' + title.replace(' ', '_')}
    for side in ('source', 'target'):
      pages.setdefault(response[side]['id'], response[side])
    response['pages'] = {str(k): v for k, v in pages.items()}
    response.pop('titles', None)
    response['stats'] = {'requests': budget.requests, 'cachedResponses': budget.cached,
                         'budgetExhausted': budget.exhausted,
                         'elapsedMs': round((time.monotonic() - started) * 1000)}
    return response


def create_blueprint(finder=None):
  finder = finder or PathFinder()
  bp = Blueprint('wiki', __name__, url_prefix='/wiki')

  @bp.before_request
  def local_only():
    if request.remote_addr not in ('127.0.0.1', '::1') or request.headers.get('Origin') not in (
        None, 'http://127.0.0.1:3000', 'http://localhost:3000', 'http://127.0.0.1:5001'):
      raise WikiError('Wikipedia search is available only from the local development page.', 403,
                      'local_only')
    request.max_content_length = 10_000

  @bp.errorhandler(WikiError)
  def error_response(error):
    return jsonify(error=error.message, code=error.code), error.status

  @bp.errorhandler(Exception)
  def unexpected_error(_error):
    return jsonify(error='Wikipedia search failed unexpectedly. Try again.', code='internal_error'), 500

  @bp.get('/resolve')
  def resolve():
    return jsonify(finder.resolve(request.args.get('q', '')))

  @bp.post('/connect')
  def connect():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
      raise WikiError('Send a JSON object with source and target titles.')
    return jsonify(finder.connect(data.get('source'), data.get('target')))

  return bp
