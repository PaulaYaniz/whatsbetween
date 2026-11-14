"""Offline tests for the local graph service, using a small fixture database built in a temp dir."""
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from sdow.graph_service import create_app

PAGES = {
    1: ('Coffee', 0), 2: ('Tea', 0), 3: ('Caffeine', 0), 4: ('Beverage Industry Trade', 0),
    5: ('Science Fiction', 0), 6: ('Teh', 1), 7: ('Plant', 0), 8: ('Leaf', 0), 9: ('Drink', 0),
    30: ('Island', 0), 40: ('ISBN', 0),
    20: ('Chain 20', 0), 21: ('Chain 21', 0), 22: ('Chain 22', 0), 23: ('Chain 23', 0),
    24: ('Chain 24', 0), 25: ('Chain 25', 0), 26: ('Chain 26', 0),
}
EDGES = [
    (1, 3), (1, 4), (1, 5), (1, 7), (1, 9),
    (2, 3), (2, 4), (2, 5), (2, 8),
    (7, 8), (8, 2), (9, 2),
    (20, 21), (21, 22), (22, 23), (23, 24), (24, 25), (25, 26),
    # ISBN-style hub: linked from both topics and from many other articles.
    (1, 40), (2, 40), (20, 40), (21, 40), (22, 40), (23, 40),
]
REDIRECTS = {6: 3}


def build_database(path):
  connection = sqlite3.connect(path)
  connection.executescript("""
    CREATE TABLE redirects (source_id INTEGER PRIMARY KEY, target_id INTEGER NOT NULL);
    CREATE TABLE pages (id INTEGER PRIMARY KEY, title TEXT NOT NULL, is_redirect INTEGER NOT NULL);
    CREATE INDEX pages_title_index ON pages(title COLLATE NOCASE);
    CREATE TABLE links (id INTEGER PRIMARY KEY, outgoing_links_count INTEGER NOT NULL,
      incoming_links_count INTEGER NOT NULL, outgoing_links TEXT NOT NULL, incoming_links TEXT NOT NULL);
  """)
  connection.executemany('INSERT INTO pages VALUES (?, ?, ?)',
                         [(pid, title, redirect) for pid, (title, redirect) in PAGES.items()])
  connection.executemany('INSERT INTO redirects VALUES (?, ?)', REDIRECTS.items())
  outgoing = {pid: [] for pid in PAGES}
  incoming = {pid: [] for pid in PAGES}
  for source, target in EDGES:
    outgoing[source].append(target)
    incoming[target].append(source)
  connection.executemany('INSERT INTO links VALUES (?, ?, ?, ?, ?)', [
      (pid, len(outgoing[pid]), len(incoming[pid]),
       '|'.join(map(str, outgoing[pid])), '|'.join(map(str, incoming[pid])))
      for pid in PAGES])
  connection.commit()
  connection.close()


class GraphServiceTests(unittest.TestCase):
  @classmethod
  def setUpClass(cls):
    cls.tmp = tempfile.TemporaryDirectory()
    root = Path(cls.tmp.name)
    cls.db = root / 'sdow.sqlite'
    build_database(cls.db)
    cls.status = root / 'download-status.json'
    cls.status.write_text(json.dumps({'status': 'downloaded_and_validated'}))
    # Fixture hubs are small, so the hub limit is lowered to make ISBN count as a hub.
    cls.app = create_app(cls.db, cls.status, hub_limit=5).test_client()
    cls.full_limit_app = create_app(cls.db, cls.status).test_client()
    cls.testing_app = create_app(cls.db, allow_unvalidated=True).test_client()

  @classmethod
  def tearDownClass(cls):
    cls.tmp.cleanup()

  def test_shared_topics_exclude_generic_and_redirect_pages_and_hubs(self):
    response = self.app.get('/api/graph/shared-topics?source=1&target=2')
    body = response.get_json()
    self.assertEqual(response.status_code, 200)
    self.assertEqual(body['snapshot'], '2023-12-20')
    # ISBN is linked from six articles, above the hub limit of five, so it is dropped.
    self.assertEqual([topic['title'] for topic in body['topics']],
                     ['Beverage Industry Trade', 'Caffeine'])
    self.assertEqual(body['total'], 2)

  def test_hub_limit_is_configurable(self):
    body = self.full_limit_app.get('/api/graph/shared-topics?source=1&target=2').get_json()
    self.assertEqual([topic['title'] for topic in body['topics']],
                     ['ISBN', 'Beverage Industry Trade', 'Caffeine'])
    self.assertEqual(body['topics'][0]['incomingLinks'], 6)

  def test_shared_topics_rejects_invalid_ids(self):
    for query in ['source=abc&target=2', 'source=0&target=2', 'source=1']:
      response = self.app.get(f'/api/graph/shared-topics?{query}')
      self.assertEqual(response.status_code, 400, query)
      self.assertEqual(response.get_json()['code'], 'invalid_request')

  def test_shortest_path_returns_only_minimum_length_routes(self):
    body = self.app.get('/api/graph/path?source=1&target=2').get_json()
    self.assertTrue(body['found'])
    self.assertEqual(body['hops'], 2)
    self.assertEqual([[page['id'] for page in route] for route in body['paths']], [[1, 9, 2]])
    self.assertEqual([page['title'] for page in body['paths'][0]], ['Coffee', 'Drink', 'Tea'])

  def test_path_respects_max_hops(self):
    within = self.testing_app.get('/api/graph/path?source=20&target=26&maxHops=6').get_json()
    self.assertTrue(within['found'])
    self.assertEqual(within['hops'], 6)
    beyond = self.testing_app.get('/api/graph/path?source=20&target=26&maxHops=4').get_json()
    self.assertFalse(beyond['found'])
    self.assertEqual(beyond['paths'], [])

  def test_unreachable_and_identical_pages(self):
    unreachable = self.testing_app.get('/api/graph/path?source=1&target=30').get_json()
    self.assertFalse(unreachable['found'])
    same = self.testing_app.get('/api/graph/path?source=1&target=1').get_json()
    self.assertTrue(same['found'])
    self.assertEqual(same['hops'], 0)
    self.assertEqual(same['paths'][0][0]['id'], 1)

  def test_page_lookup_is_case_insensitive_and_follows_redirects(self):
    body = self.app.get('/api/graph/page?title=teh').get_json()
    self.assertEqual(body['page']['id'], 3)
    self.assertEqual(body['page']['title'], 'Caffeine')
    missing = self.app.get('/api/graph/page?title=Nonexistent%20Page')
    self.assertEqual(missing.status_code, 404)

  def test_refuses_to_serve_until_download_is_validated(self):
    unvalidated = Path(self.tmp.name) / 'status-downloading.json'
    unvalidated.write_text(json.dumps({'status': 'downloading'}))
    client = create_app(self.db, unvalidated).test_client()
    response = client.get('/api/graph/shared-topics?source=1&target=2')
    self.assertEqual(response.status_code, 503)
    self.assertEqual(response.get_json()['code'], 'graph_unavailable')
    self.assertFalse(client.get('/health').get_json()['ready'])
    self.assertTrue(self.app.get('/health').get_json()['ready'])

  def test_search_is_prefix_case_insensitive_and_puts_exact_title_first(self):
    body = self.testing_app.get('/api/graph/search?q=coffee').get_json()
    titles = [result['title'] for result in body['results']]
    self.assertIn('Chain 20', [result['title'] for result in self.testing_app.get('/api/graph/search?q=cha').get_json()['results']])
    self.assertEqual(titles[0].lower(), 'coffee')
    self.assertNotIn('Teh', titles)  # redirects are excluded from search

  def test_pages_by_id_returns_known_pages_only(self):
    body = self.testing_app.get('/api/graph/pages?ids=1,2,999').get_json()
    self.assertEqual([page['title'] for page in body['pages']], ['Coffee', 'Tea'])
    self.assertEqual(self.testing_app.get('/api/graph/pages?ids=abc').status_code, 400)

  def test_database_is_opened_read_only(self):
    conn = sqlite3.connect(self.db.resolve().as_uri() + '?mode=ro', uri=True)
    with self.assertRaises(sqlite3.OperationalError):
      conn.execute('DELETE FROM links')
    conn.close()


if __name__ == '__main__':
  unittest.main()
