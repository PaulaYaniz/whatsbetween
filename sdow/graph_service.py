"""
Read-only local graph service for the full SDOW snapshot.

Exposes shared-topic lookup and shortest-path search over the SDOW link tables so the Cloudflare
Worker can avoid live Wikipedia link requests. Every response carries the snapshot date so the UI
can label the graph's age.

The service refuses to serve data until the download has been validated, unless it is started
with allow_unvalidated=True (for tests against fixture databases only).
"""

import itertools
import json
import math
import re
import sqlite3
from pathlib import Path

from flask import Flask, jsonify, request

SNAPSHOT = '2023-12-20'
VALIDATED_STATUS = 'downloaded_and_validated'
GENERIC_TITLE = re.compile(
    r'^(science|technology|society|culture|history|geography|country|list of |outline of |index of )',
    re.IGNORECASE)
# Pages with more incoming links than this are treated as hubs and never shown as shared topics.
HUB_INCOMING_LIMIT = 5_000
# Shared topics are ranked by how close their incoming-link count is to this level (log scale):
# mid-level topics first, away from both hubs and obscure pages.
PREFERRED_INCOMING = 500
# Route stops (preferIndirect mode): pages linked from more than this many articles are broad
# topics (countries, Album, YouTube); they are shown only when a step has nothing else.
BROAD_TOPIC_INCOMING = 100_000
# Pages linked mostly through citation, identifier, database and infobox templates, not because of
# what they are about. Never used as route stops in preferIndirect mode.
TEMPLATE_PAGES = (
    'ISBN', 'Digital object identifier', 'Wayback Machine', 'Wikidata', 'ISSN', 'Semantic Scholar',
    'OCLC', 'PubMed', 'PubMed Central', 'JSTOR', 'Bibcode', 'ArXiv', 'Handle System',
    'Library of Congress Control Number', 'Virtual International Authority File',
    'International Standard Name Identifier', 'Integrated Authority File', 'Open Library', 'IMDb',
    'AllMusic', 'Sports Reference', 'Geographic coordinate system', 'Geographic Names Information System',
    'Time zone', 'UTC+01:00', 'UTC+02:00', 'Central European Time', 'Central European Summer Time',
    'Telephone numbering plan', 'Global Biodiversity Information Facility', 'Catalogue of Life',
    'Interim Register of Marine and Nonmarine Genera', 'INaturalist', 'Encyclopedia of Life',
    'Wikispecies', 'National Center for Biotechnology Information',
    'Integrated Taxonomic Information System', 'Barcode of Life Data System', 'Open Tree of Life',
    'World Register of Marine Species', 'IUCN Red List', 'International Plant Names Index',
    'Plants of the World Online', 'World Flora Online', 'The Global Lepidoptera Names Index',
)
# Titles that make dull route stops: lists, filmographies, episode and season pages.
LIST_TITLE = re.compile(
    r'^(list of|lists of|outline of|index of|glossary of|timeline of)|filmography|discography|'
    r'bibliography|episodes|\bseason\b|\(season', re.IGNORECASE)
MAX_HOPS = 8
DEFAULT_MAX_HOPS = 6
MAX_PATHS = 5
# Fewer routes than this when following links forward: also try links in either direction, at no
# extra length, and keep whichever finds more routes.
MIN_ROUTES = 3
DEFAULT_PER_STEP = 6
MAX_PER_STEP = 40
MAX_TOPICS = 12
MAX_NODES_VISITED = 2_000_000
CHUNK = 500
LINK_COLUMNS = ('outgoing_links', 'incoming_links')


class GraphUnavailable(Exception):
  pass


class SearchLimitReached(Exception):
  pass


def display_title(raw):
  """SDOW stores titles with underscores for spaces and backslash-escaped quotes."""
  return raw.replace('_', ' ').replace("\\'", "'").replace('\\"', '"')


def stored_title(text):
  """The form a title takes in the SDOW pages table."""
  return text.strip().replace(' ', '_').replace("'", "\\'").replace('"', '\\"')


class Graph(object):
  """Read-only access to the SDOW pages, redirects and links tables."""

  def __init__(self, database_path):
    self.database_path = Path(database_path)
    if not self.database_path.is_file():
      raise GraphUnavailable('Graph database not found.')
    self._template_ids = None

  def template_ids(self, conn):
    """IDs of TEMPLATE_PAGES in this snapshot (looked up once)."""
    if self._template_ids is None:
      titles = [stored_title(title) for title in TEMPLATE_PAGES]
      placeholders = ','.join('?' * len(titles))
      self._template_ids = frozenset(row[0] for row in conn.execute(
          f'SELECT id FROM pages WHERE is_redirect = 0 AND title IN ({placeholders})', titles))
    return self._template_ids

  def connect(self):
    return sqlite3.connect(self.database_path.resolve().as_uri() + '?mode=ro', uri=True)

  def pages(self, conn, ids):
    ids = list(ids)
    found = {}
    for start in range(0, len(ids), CHUNK):
      chunk = ids[start:start + CHUNK]
      placeholders = ','.join('?' * len(chunk))
      for page_id, title, is_redirect in conn.execute(
          f'SELECT id, title, is_redirect FROM pages WHERE id IN ({placeholders})', chunk):
        found[page_id] = {'id': page_id, 'title': display_title(title), 'isRedirect': bool(is_redirect)}
    return found

  def links(self, conn, ids, column):
    if column not in LINK_COLUMNS:
      raise ValueError('Unknown link column.')
    ids = list(ids)
    result = {}
    for start in range(0, len(ids), CHUNK):
      chunk = ids[start:start + CHUNK]
      placeholders = ','.join('?' * len(chunk))
      for page_id, text in conn.execute(
          f'SELECT id, {column} FROM links WHERE id IN ({placeholders})', chunk):
        result[page_id] = [int(item) for item in text.split('|') if item] if text else []
    return result

  def resolve_redirect(self, conn, page_id):
    seen = set()
    while page_id not in seen:
      seen.add(page_id)
      row = conn.execute('SELECT target_id FROM redirects WHERE source_id = ?', (page_id,)).fetchone()
      if row is None:
        return page_id
      page_id = row[0]
    raise GraphUnavailable('Redirect loop in graph data.')

  def resolve_title(self, conn, title):
    """The page for a typed title, following redirects. Prefers the exact spelling, then Wikipedia's
    usual form (first letter capitalized), then any other capitalization ("can" finds Can, not CAN)."""
    stored = stored_title(title)
    rows = conn.execute('SELECT id, title, is_redirect FROM pages WHERE title = ? COLLATE NOCASE',
                        (stored,)).fetchall()
    if not rows:
      return None
    capitalized = stored[:1].upper() + stored[1:]
    rows.sort(key=lambda row: (row[1] != stored, row[1] != capitalized, row[2]))
    return self.resolve_redirect(conn, rows[0][0])

  def incoming_counts(self, conn, ids):
    ids = list(ids)
    counts = {}
    for start in range(0, len(ids), CHUNK):
      chunk = ids[start:start + CHUNK]
      placeholders = ','.join('?' * len(chunk))
      for page_id, count in conn.execute(
          f'SELECT id, incoming_links_count FROM links WHERE id IN ({placeholders})', chunk):
        counts[page_id] = count
    return counts

  def shared_topics(self, conn, source_id, target_id, max_incoming=HUB_INCOMING_LIMIT):
    """Pages both articles link to. Hub pages linked from very many articles (ISBN, United States)
    are dropped because they say little about the connection; the rest are ranked by how
    specific they are: a moderate number of incoming links ranks above obscure ones."""
    source_links = set(self.links(conn, [source_id], 'outgoing_links').get(source_id, []))
    target_links = self.links(conn, [target_id], 'outgoing_links').get(target_id, [])
    shared = [page_id for page_id in dict.fromkeys(target_links)
              if page_id in source_links and page_id not in (source_id, target_id)]
    details = self.pages(conn, shared)
    counts = self.incoming_counts(conn, shared)
    topics = []
    for page_id in shared:
      topic = details.get(page_id)
      if topic is None or topic['isRedirect'] or GENERIC_TITLE.search(topic['title']):
        continue
      incoming = counts.get(page_id, 0)
      if incoming > max_incoming:
        continue
      topics.append({**topic, 'incomingLinks': incoming})

    def closeness(topic):
      return abs(math.log10(max(topic['incomingLinks'], 1)) - math.log10(PREFERRED_INCOMING))

    topics.sort(key=lambda topic: (closeness(topic), topic['title']))
    return topics

  def neighbours(self, conn, ids, column, any_direction):
    """Links of each page in one direction, or in both when any_direction is set."""
    found = self.links(conn, ids, column)
    if any_direction:
      other = 'incoming_links' if column == 'outgoing_links' else 'outgoing_links'
      for page_id, items in self.links(conn, ids, other).items():
        found[page_id] = list(dict.fromkeys(found.get(page_id, []) + items))
    return found

  def _search(self, conn, source_id, target_id, max_hops, exclude_direct=False, any_direction=False,
              skip=frozenset()):
    """Bidirectional level-by-level breadth-first search. Returns the forward parent map, the
    backward child map and the set of nodes where the two searches met, or None if no route exists
    within max_hops. With any_direction, a link counts whichever way it points, so a page that
    nothing links to can still be reached through the pages it links to."""
    forward_parents = {source_id: set()}
    backward_children = {target_id: set()}
    forward_frontier = {source_id}
    backward_frontier = {target_id}
    visited = 2
    meeting = set()
    depth = 0

    while forward_frontier and backward_frontier and not meeting and depth < max_hops:
      if len(forward_frontier) <= len(backward_frontier):
        links = self.neighbours(conn, forward_frontier, 'outgoing_links', any_direction)
        next_frontier = {}
        for node in forward_frontier:
          for child in links.get(node, []):
            if exclude_direct and node == source_id and child == target_id:
              continue
            if child in skip and child != target_id:
              continue
            if child not in forward_parents:
              next_frontier.setdefault(child, set()).add(node)
        forward_parents.update(next_frontier)
        forward_frontier = set(next_frontier)
        meeting = forward_frontier & set(backward_children)
      else:
        links = self.neighbours(conn, backward_frontier, 'incoming_links', any_direction)
        next_frontier = {}
        for node in backward_frontier:
          for parent in links.get(node, []):
            if exclude_direct and parent == source_id and node == target_id:
              continue
            if parent in skip and parent != source_id:
              continue
            if parent not in backward_children:
              next_frontier.setdefault(parent, set()).add(node)
        backward_children.update(next_frontier)
        backward_frontier = set(next_frontier)
        meeting = backward_frontier & set(forward_parents)
      visited += len(next_frontier)
      depth += 1
      if visited > MAX_NODES_VISITED:
        raise SearchLimitReached('Search visited too many pages; try a closer pair.')

    if not meeting:
      return None
    return forward_parents, backward_children, meeting

  def shortest_path_graph(self, conn, source_id, target_id, max_hops, exclude_direct=False,
                          any_direction=False, skip=frozenset()):
    """Every node and link on any shortest path, with each node's step number and the number of
    shortest paths passing through it. Returns None when there is no route within max_hops."""
    if source_id == target_id:
      return {'hops': 0, 'step': {source_id: 0}, 'children': {}, 'parents': {}, 'through': {source_id: 1},
              'total': 1}
    found = self._search(conn, source_id, target_id, max_hops, exclude_direct, any_direction, skip)
    if found is None:
      return None
    forward_parents, backward_children, meeting = found
    children, parents = {}, {}

    def link(parent, child):
      children.setdefault(parent, set()).add(child)
      parents.setdefault(child, set()).add(parent)

    # Walk back from the meeting nodes to the start, and forward from them to the end.
    stack, seen = list(meeting), set(meeting)
    while stack:
      node = stack.pop()
      for parent in forward_parents.get(node, ()):
        link(parent, node)
        if parent not in seen:
          seen.add(parent)
          stack.append(parent)
    stack, seen = list(meeting), set(meeting)
    while stack:
      node = stack.pop()
      for child in backward_children.get(node, ()):
        link(node, child)
        if child not in seen:
          seen.add(child)
          stack.append(child)

    # Step numbers: distance from the start along the shortest-path graph.
    step = {source_id: 0}
    frontier = [source_id]
    while frontier:
      following = []
      for node in frontier:
        for child in children.get(node, ()):
          if child not in step:
            step[child] = step[node] + 1
            following.append(child)
      frontier = following
    hops = step[target_id]

    # Path counts without listing paths: from the start to each node, and from each node to the end.
    order = sorted(step, key=step.get)
    to_node = {source_id: 1}
    for node in order[1:]:
      to_node[node] = sum(to_node[parent] for parent in parents.get(node, ()))
    from_node = {target_id: 1}
    for node in reversed(order[:-1]):
      from_node[node] = sum(from_node[child] for child in children.get(node, ()))
    through = {node: to_node[node] * from_node.get(node, 0) for node in step}
    return {'hops': hops, 'step': step, 'children': children, 'parents': parents, 'through': through,
            'total': to_node[target_id]}

  def three_step_graph(self, conn, source_id, target_id, any_direction=False, skip=frozenset()):
    """Every route of exactly three links (source, first stop, second stop, target), in the same
    shape as shortest_path_graph. Used when the shortest route has only one stop in the middle, so
    the map can show two-stop routes instead. Returns None when there are none."""
    ends = {source_id, target_id}
    first = set(self.neighbours(conn, [source_id], 'outgoing_links', any_direction).get(source_id, []))
    second = set(self.neighbours(conn, [target_id], 'incoming_links', any_direction).get(target_id, []))
    first -= ends | skip
    second -= ends | skip
    if not first or not second:
      return None
    # Expand whichever side is smaller.
    pairs = set()
    if len(first) <= len(second):
      for node, items in self.neighbours(conn, first, 'outgoing_links', any_direction).items():
        pairs.update((node, item) for item in items if item in second and item != node)
    else:
      for node, items in self.neighbours(conn, second, 'incoming_links', any_direction).items():
        pairs.update((item, node) for item in items if item in first and item != node)
    # A page can be a first stop on some routes and a second stop on others; keep it where it has
    # more routes so every page sits in one column.
    as_first, as_second = {}, {}
    for a, b in pairs:
      as_first[a] = as_first.get(a, 0) + 1
      as_second[b] = as_second.get(b, 0) + 1
    pairs = {(a, b) for a, b in pairs
             if as_first[a] >= as_second.get(a, 0) and as_second[b] > as_first.get(b, 0)}
    if not pairs:
      return None
    children, parents, through = {}, {}, {}

    def link(parent, child):
      children.setdefault(parent, set()).add(child)
      parents.setdefault(child, set()).add(parent)

    step = {source_id: 0, target_id: 3}
    for a, b in pairs:
      link(source_id, a)
      link(a, b)
      link(b, target_id)
      step[a], step[b] = 1, 2
      through[a] = through.get(a, 0) + 1
      through[b] = through.get(b, 0) + 1
    through[source_id] = through[target_id] = len(pairs)
    return {'hops': 3, 'step': step, 'children': children, 'parents': parents, 'through': through,
            'total': len(pairs)}

  def path_summary(self, conn, source_id, target_id, max_hops, per_step, hub_limit=HUB_INCOMING_LIMIT, prefer_indirect=False):
    """A readable slice of all shortest paths: the busiest stops at each step (most shortest paths
    through them), only real links between them, and counts of total and shown paths.

    With prefer_indirect, the route should always pass through at least one other article. Tried in
    order: links followed forward without the direct link; links in either direction without the
    direct link (up to MAX_HOPS); then the direct link as a last resort. `directed` in the result
    says whether every link on the route points from the source side to the target side.

    prefer_indirect also aims for interesting routes: citation and identifier pages (TEMPLATE_PAGES)
    are never stops; when the shortest route has a single stop, routes with two stops are shown
    instead; and stops are ranked to favour specific topics over broad ones and lists."""
    if prefer_indirect:
      attempts = [(max_hops, True, False), (max(max_hops, MAX_HOPS), True, True),
                  (max_hops, False, False), (max_hops, False, True)]
    else:
      attempts = [(max_hops, False, False)]
    skip = self.template_ids(conn) if prefer_indirect else frozenset()
    graph, directed = None, True
    for hops_limit, exclude_direct, any_direction in attempts:
      graph = self.shortest_path_graph(conn, source_id, target_id, hops_limit, exclude_direct,
                                       any_direction, skip)
      if graph is not None:
        directed = not any_direction
        break
    if graph is None:
      return None
    # Stops on routes whose links all point forward; listed before the others.
    forward = set(graph['step']) if directed else set()
    if prefer_indirect and graph['hops'] == 2:
      # One stop in the middle: show two-stop routes, forward links first, either direction when
      # forward links give too few.
      longer = self.three_step_graph(conn, source_id, target_id, False, skip)
      longer_forward = set(longer['step']) if longer else set()
      if longer is None or longer['total'] < MIN_ROUTES:
        wide = self.three_step_graph(conn, source_id, target_id, True, skip)
        if wide is not None and (longer is None or wide['total'] > longer['total']):
          longer = wide
      if longer is not None:
        graph, forward = longer, longer_forward
        directed = longer_forward == set(longer['step'])
    elif prefer_indirect and directed and graph['hops'] > 1 and graph['total'] < MIN_ROUTES:
      wider = self.shortest_path_graph(conn, source_id, target_id, graph['hops'], True, True, skip)
      if wider is not None and wider['total'] > graph['total']:
        graph, directed = wider, False
    if prefer_indirect:
      hub_limit = BROAD_TOPIC_INCOMING
    hops, step, children, parents, through = (
        graph['hops'], graph['step'], graph['children'], graph['parents'], graph['through'])
    middle = [node for node in step if 0 < step[node] < hops]
    incoming = self.incoming_counts(conn, middle)
    titles = self.pages(conn, list(step))

    def interest(node):
      """Higher for stops on many routes, with a moderate number of incoming links, and not lists."""
      title = titles.get(node, {}).get('title', '')
      specificity = abs(math.log10(max(incoming.get(node, 0), 1)) - math.log10(PREFERRED_INCOMING))
      return math.log10(through[node] + 1) - 0.5 * specificity - (1 if LIST_TITLE.search(title) else 0)

    def rank(node):
      title = titles.get(node, {}).get('title', '')
      if prefer_indirect:
        return (node not in forward, -interest(node), title)
      return (node not in forward, -through[node], title)

    def is_hub(node):
      return incoming.get(node, 0) > hub_limit

    # Pick the busiest stops step by step. After the first step, prefer stops linked to the stops
    # already chosen, so the view stays connected. Hub pages only when a step has nothing else.
    chosen = {}
    for number in range(1, hops):
      previous = chosen.get(number - 1, {source_id})
      at_step = sorted((node for node in middle if step[node] == number),
                       key=lambda node: (not parents.get(node, set()) & previous, rank(node)))
      plain = [node for node in at_step if not is_hub(node)]
      chosen[number] = set((plain or at_step)[:per_step])

    def best(nodes):
      nodes = sorted(nodes, key=lambda node: (is_hub(node), rank(node)))
      return nodes[0] if nodes else None

    # Repair gaps so every shown stop links to a shown stop on each side.
    for _ in range(hops + 1):
      changed = False
      for number in range(1, hops - 1):
        for node in list(chosen[number]):
          if not children.get(node, set()) & chosen[number + 1]:
            chosen[number + 1].add(best(children.get(node, ())))
            changed = True
      for number in range(hops - 1, 1, -1):
        for node in list(chosen[number]):
          if not parents.get(node, set()) & chosen[number - 1]:
            chosen[number - 1].add(best(parents.get(node, ())))
            changed = True
      if not changed:
        break

    shown = {source_id, target_id}.union(*chosen.values()) if chosen else {source_id, target_id}
    links = sorted((parent, child) for parent in shown for child in children.get(parent, ())
                   if child in shown and step[child] == step[parent] + 1)

    # Order each column to reduce crossings: by the average position of its shown parents.
    columns, position = [], {source_id: 0.0}
    for number in range(1, hops):
      nodes = sorted(chosen[number], key=rank)
      if number > 1:
        def centre(node):
          spots = [position[parent] for parent in parents.get(node, ()) if parent in position]
          return sum(spots) / len(spots) if spots else 0.0
        nodes.sort(key=lambda node: (centre(node), rank(node)))
      for index, node in enumerate(nodes):
        position[node] = float(index)
      columns.append(nodes)

    # Complete paths that stay inside what is shown.
    shown_count = {source_id: 1}
    for node in sorted(shown, key=step.get)[1:]:
      shown_count[node] = sum(shown_count.get(parent, 0) for parent in parents.get(node, ()) if parent in shown)

    # A few full example routes (busiest first) for saving and "Explain this route".
    # Prefer stops shown on the map, then non-hubs, then forward links, then the busiest.
    def preference(item):
      return (item in shown, not is_hub(item), item in forward, through[item], -item)

    def busiest_route_through(node):
      head, current = [node], node
      while current != source_id:
        current = max(parents[current], key=preference)
        head.insert(0, current)
      current = node
      while current != target_id:
        current = max(children[current], key=preference)
        head.append(current)
      return head

    routes = []
    for node in (columns[0] if columns else []):
      route = busiest_route_through(node)
      if route not in routes:
        routes.append(route)
      if len(routes) == 5:
        break
    if hops <= 1:
      routes = [[source_id, target_id]] if hops == 1 else [[source_id]]

    def page(node):
      details = titles.get(node, {'id': node, 'title': str(node), 'isRedirect': False})
      return {**details, 'through': through.get(node, 0)}

    # Steps where the Wikipedia link points backwards (the later article links to the earlier one).
    reversed_links = []
    if not directed:
      pairs = set(links) | {pair for route in routes for pair in zip(route, route[1:])}
      outgoing = self.links(conn, {parent for parent, _ in pairs}, 'outgoing_links')
      reversed_links = sorted([parent, child] for parent, child in pairs
                              if child not in outgoing.get(parent, ()))

    return {
      'hops': hops,
      'directed': directed,
      'totalPaths': graph['total'],
      'shownPaths': shown_count.get(target_id, 0),
      'steps': [[page(node) for node in column] for column in columns],
      'links': [list(item) for item in links],
      'reversedLinks': reversed_links,
      'routes': [[page(node) for node in route] for route in routes],
    }

  def shortest_paths(self, conn, source_id, target_id, max_hops, limit):
    """Up to `limit` example shortest paths (busiest first)."""
    summary = self.path_summary(conn, source_id, target_id, max_hops, per_step=limit)
    if summary is None:
      return None, []
    return summary['hops'], [[item['id'] for item in route] for route in summary['routes'][:limit]]


def _int_arg(name):
  raw = request.args.get(name, '')
  if not raw.isdigit() or int(raw) <= 0:
    raise ValueError(f'{name} must be a positive page ID.')
  return int(raw)


def create_app(database_path, status_path=None, allow_unvalidated=False, hub_limit=HUB_INCOMING_LIMIT):
  """Builds the Flask app. The database is only opened read-only."""
  graph = Graph(database_path)
  # Responses from an unvalidated database must not claim the 2023-12-20 snapshot.
  snapshot = 'unvalidated-test-database' if allow_unvalidated else SNAPSHOT
  app = Flask(__name__)

  def ensure_validated():
    if allow_unvalidated:
      return
    try:
      status = json.loads(Path(status_path).read_text())
    except (OSError, ValueError, TypeError):
      status = {}
    if status.get('status') != VALIDATED_STATUS:
      raise GraphUnavailable('Graph snapshot has not passed download validation yet.')

  @app.errorhandler(ValueError)
  def bad_request(error):
    return jsonify({'error': str(error), 'code': 'invalid_request'}), 400

  @app.errorhandler(GraphUnavailable)
  def unavailable(error):
    return jsonify({'error': str(error), 'code': 'graph_unavailable'}), 503

  @app.errorhandler(SearchLimitReached)
  def limit_reached(error):
    return jsonify({'error': str(error), 'code': 'search_limit'}), 422

  @app.get('/health')
  def health():
    try:
      ensure_validated()
      ready = True
    except GraphUnavailable:
      ready = False
    return jsonify({'ok': True, 'ready': ready, 'snapshot': snapshot})

  @app.get('/api/graph/page')
  def page():
    ensure_validated()
    title = request.args.get('title', '').strip()
    if not title or len(title) > 300:
      raise ValueError('title is required.')
    conn = graph.connect()
    try:
      page_id = graph.resolve_title(conn, title)
      if page_id is None:
        return jsonify({'error': 'No such page in the snapshot.', 'code': 'not_found',
                        'snapshot': snapshot}), 404
      details = graph.pages(conn, [page_id])[page_id]
    finally:
      conn.close()
    return jsonify({'page': details, 'snapshot': snapshot})

  @app.get('/api/graph/search')
  def search():
    ensure_validated()
    typed = request.args.get('q', '').strip()
    query = stored_title(typed)
    if len(typed) < 2 or len(typed) > 100:
      raise ValueError('q must be 2 to 100 characters.')
    # Prefix search on the indexed, case-insensitive title column, plus the exact title even when it
    # is only a redirect (typing "phone" should find Telephone, which "Phone" redirects to).
    conn = graph.connect()
    try:
      exact_id = graph.resolve_title(conn, typed)
      rows = conn.execute(
          'SELECT id, title FROM pages WHERE is_redirect = 0 '
          'AND title COLLATE NOCASE >= ? COLLATE NOCASE AND title COLLATE NOCASE < ? COLLATE NOCASE '
          'LIMIT 2000', (query, query + '\uffff')).fetchall()
      found = {page_id: display_title(title) for page_id, title in rows}
      if exact_id is not None and exact_id not in found:
        found[exact_id] = graph.pages(conn, [exact_id])[exact_id]['title']
      counts = graph.incoming_counts(conn, list(found))
    finally:
      conn.close()
    typed_lower = typed.lower()

    def rank(item):
      title = item['title'].lower()
      # The page the typed title resolves to comes first, then other spellings of the same title.
      # A whole-word match ("Phone Link") beats a longer word that merely starts the same ("Phoneme").
      next_char = title[len(typed_lower):len(typed_lower) + 1]
      whole_word = title.startswith(typed_lower) and (next_char == '' or not next_char.isalnum())
      return (item['id'] != exact_id, title != typed_lower, not whole_word, -item['incomingLinks'])

    matches = sorted(
        ({'id': page_id, 'title': title, 'incomingLinks': counts.get(page_id, 0)}
         for page_id, title in found.items()),
        key=rank)[:10]
    return jsonify({'query': typed, 'snapshot': snapshot, 'results': matches})

  @app.get('/api/graph/pages')
  def pages_by_id():
    ensure_validated()
    raw = request.args.get('ids', '')
    ids = [int(item) for item in raw.split(',') if item.isdigit() and int(item) > 0][:50]
    if not ids:
      raise ValueError('ids must be a comma-separated list of page IDs.')
    conn = graph.connect()
    try:
      found = graph.pages(conn, ids)
    finally:
      conn.close()
    return jsonify({'snapshot': snapshot, 'pages': [found[i] for i in ids if i in found]})

  @app.get('/api/graph/shared-topics')
  def shared_topics():
    ensure_validated()
    source_id, target_id = _int_arg('source'), _int_arg('target')
    max_incoming = min(hub_limit, max(0, int(request.args.get('maxIncoming', hub_limit))))
    conn = graph.connect()
    try:
      topics = graph.shared_topics(conn, source_id, target_id, max_incoming)
      # How many articles each side links to, so the UI can show how few of them meet.
      outgoing = dict(conn.execute(
          'SELECT id, outgoing_links_count FROM links WHERE id IN (?, ?)',
          (source_id, target_id)).fetchall())
    finally:
      conn.close()
    return jsonify({
      'sourceId': source_id, 'targetId': target_id, 'snapshot': snapshot,
      'sourceLinks': outgoing.get(source_id, 0), 'targetLinks': outgoing.get(target_id, 0),
      'total': len(topics), 'topics': topics[:MAX_TOPICS],
    })

  @app.get('/api/graph/path')
  def path():
    ensure_validated()
    source_id, target_id = _int_arg('source'), _int_arg('target')
    max_hops = min(MAX_HOPS, max(1, int(request.args.get('maxHops', DEFAULT_MAX_HOPS))))
    per_step = min(MAX_PER_STEP, max(1, int(request.args.get('perStep', DEFAULT_PER_STEP))))
    conn = graph.connect()
    try:
      summary = graph.path_summary(conn, source_id, target_id, max_hops, per_step, hub_limit,
                                   prefer_indirect=request.args.get('preferIndirect') == '1')
    finally:
      conn.close()
    base = {'sourceId': source_id, 'targetId': target_id, 'snapshot': snapshot, 'maxHops': max_hops}
    if summary is None:
      return jsonify({**base, 'found': False, 'paths': [], 'steps': [], 'links': [], 'totalPaths': 0,
                      'shownPaths': 0})
    return jsonify({**base, 'found': True, 'hops': summary['hops'], 'directed': summary['directed'],
                    'totalPaths': summary['totalPaths'],
                    'shownPaths': summary['shownPaths'], 'steps': summary['steps'],
                    'links': summary['links'], 'reversedLinks': summary['reversedLinks'],
                    'paths': summary['routes']})

  return app


if __name__ == '__main__':
  import argparse

  parser = argparse.ArgumentParser(description='Serve the SDOW graph to the local WikiWormhole app.')
  parser.add_argument('--db', default='data/sdow-20231220/sdow.sqlite')
  parser.add_argument('--status', default='data/sdow-20231220/download-status.json')
  parser.add_argument('--port', type=int, default=8788)
  parser.add_argument('--allow-unvalidated', action='store_true',
                      help='Serve a database that has not passed download validation (testing only).')
  args = parser.parse_args()
  flask_app = create_app(args.db, args.status, allow_unvalidated=args.allow_unvalidated)
  flask_app.run(host='127.0.0.1', port=args.port, threaded=True)
