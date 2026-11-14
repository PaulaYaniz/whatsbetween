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
MAX_HOPS = 8
DEFAULT_MAX_HOPS = 6
MAX_PATHS = 5
MAX_TOPICS = 12
MAX_NODES_VISITED = 2_000_000
CHUNK = 500
LINK_COLUMNS = ('outgoing_links', 'incoming_links')


class GraphUnavailable(Exception):
  pass


class SearchLimitReached(Exception):
  pass


class Graph(object):
  """Read-only access to the SDOW pages, redirects and links tables."""

  def __init__(self, database_path):
    self.database_path = Path(database_path)
    if not self.database_path.is_file():
      raise GraphUnavailable('Graph database not found.')

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
        found[page_id] = {'id': page_id, 'title': title.replace('_', ' '), 'isRedirect': bool(is_redirect)}
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
    row = conn.execute(
        'SELECT id FROM pages WHERE title = ? COLLATE NOCASE ORDER BY is_redirect ASC LIMIT 1',
        (title.replace('_', ' ').strip(),)).fetchone()
    if row is None:
      return None
    return self.resolve_redirect(conn, row[0])

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

  def shortest_paths(self, conn, source_id, target_id, max_hops, limit):
    """Bidirectional level-by-level breadth-first search returning up to `limit` shortest paths."""
    if source_id == target_id:
      return 0, [[source_id]]

    forward_parents = {source_id: set()}
    backward_children = {target_id: set()}
    forward_frontier = {source_id}
    backward_frontier = {target_id}
    visited = 2
    meeting = set()
    depth = 0

    while forward_frontier and backward_frontier and not meeting and depth < max_hops:
      if len(forward_frontier) <= len(backward_frontier):
        links = self.links(conn, forward_frontier, 'outgoing_links')
        next_frontier = {}
        for node in forward_frontier:
          for child in links.get(node, []):
            if child not in forward_parents:
              next_frontier.setdefault(child, set()).add(node)
        forward_parents.update(next_frontier)
        forward_frontier = set(next_frontier)
        meeting = forward_frontier & set(backward_children)
      else:
        links = self.links(conn, backward_frontier, 'incoming_links')
        next_frontier = {}
        for node in backward_frontier:
          for parent in links.get(node, []):
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
      return None, []

    def forward_paths(node):
      if node == source_id:
        yield [source_id]
        return
      for parent in forward_parents[node]:
        for path in forward_paths(parent):
          yield path + [node]

    def backward_paths(node):
      if node == target_id:
        yield [target_id]
        return
      for child in backward_children[node]:
        for path in backward_paths(child):
          yield [node] + path

    paths = []
    for middle in sorted(meeting):
      for head in itertools.islice(forward_paths(middle), limit):
        for tail in itertools.islice(backward_paths(middle), limit):
          paths.append(head + tail[1:])
          if len(paths) == limit:
            return len(paths[0]) - 1, paths
    return len(paths[0]) - 1, paths


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
    query = request.args.get('q', '').strip().replace('_', ' ')
    if len(query) < 2 or len(query) > 100:
      raise ValueError('q must be 2 to 100 characters.')
    # Prefix search on the indexed, case-insensitive title column.
    conn = graph.connect()
    try:
      rows = conn.execute(
          'SELECT id, title FROM pages WHERE is_redirect = 0 '
          'AND title COLLATE NOCASE >= ? COLLATE NOCASE AND title COLLATE NOCASE < ? COLLATE NOCASE '
          'LIMIT 300', (query, query + '\uffff')).fetchall()
      ids = [page_id for page_id, _ in rows]
      counts = graph.incoming_counts(conn, ids)
    finally:
      conn.close()
    matches = sorted(
        ({'id': page_id, 'title': title.replace('_', ' '), 'incomingLinks': counts.get(page_id, 0)}
         for page_id, title in rows),
        key=lambda item: (item['title'].lower() != query.lower(), -item['incomingLinks']))[:10]
    return jsonify({'query': query, 'snapshot': snapshot, 'results': matches})

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
    finally:
      conn.close()
    return jsonify({
      'sourceId': source_id, 'targetId': target_id, 'snapshot': snapshot,
      'total': len(topics), 'topics': topics[:MAX_TOPICS],
    })

  @app.get('/api/graph/path')
  def path():
    ensure_validated()
    source_id, target_id = _int_arg('source'), _int_arg('target')
    max_hops = min(MAX_HOPS, max(1, int(request.args.get('maxHops', DEFAULT_MAX_HOPS))))
    limit = min(MAX_PATHS, max(1, int(request.args.get('limit', 3))))
    conn = graph.connect()
    try:
      hops, paths = graph.shortest_paths(conn, source_id, target_id, max_hops, limit)
      if not paths:
        return jsonify({'sourceId': source_id, 'targetId': target_id, 'snapshot': snapshot,
                        'found': False, 'maxHops': max_hops, 'paths': []})
      ids = {page_id for route in paths for page_id in route}
      details = graph.pages(conn, ids)
    finally:
      conn.close()
    return jsonify({
      'sourceId': source_id, 'targetId': target_id, 'snapshot': snapshot, 'found': True,
      'hops': hops, 'maxHops': max_hops,
      'paths': [[details[page_id] for page_id in route] for route in paths],
    })

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
