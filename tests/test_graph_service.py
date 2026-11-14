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
    # SDOW stores quotes escaped with a backslash.
    50: ("April Fools\\' Day", 0),
    # Branching routes: 100 to 110 in three steps, four shortest paths.
    100: ('Start', 0), 101: ('Branch A', 0), 102: ('Branch B', 0), 103: ('Branch C', 0),
    104: ('Middle D', 0), 105: ('Middle E', 0), 110: ('Finish', 0),
    # Gap repair: the busiest stops at step 1 and step 2 are not linked to each other.
    200: ('Gap start', 0), 201: ('Alpha', 0), 202: ('Way one', 0), 203: ('Way two', 0),
    204: ('Pass', 0), 205: ('Yard', 0), 210: ('Gap end', 0),
    # Hub skipping: 301 is busier than 302 but is a hub (linked from many pages).
    300: ('Hub start', 0), 301: ('Busy hub', 0), 302: ('Quiet stop', 0), 303: ('Hub child one', 0),
    304: ('Hub child two', 0), 305: ('Quiet child', 0), 310: ('Hub end', 0),
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
    (100, 101), (100, 102), (100, 103), (101, 104), (101, 105), (102, 104), (103, 105), (104, 110), (105, 110),
    (200, 201), (200, 202), (200, 203), (201, 204), (202, 205), (203, 205), (204, 210), (205, 210),
    (300, 301), (300, 302), (301, 303), (301, 304), (302, 305), (303, 310), (304, 310), (305, 310),
    (20, 301), (21, 301), (22, 301), (23, 301), (24, 301),
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
  # Real SDOW titles use underscores instead of spaces; the fixture does the same.
  connection.executemany('INSERT INTO pages VALUES (?, ?, ?)',
                         [(pid, title.replace(' ', '_'), redirect) for pid, (title, redirect) in PAGES.items()])
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

  def test_shared_topics_report_each_side_link_count(self):
    body = self.app.get('/api/graph/shared-topics?source=1&target=2').get_json()
    # Fixture: Coffee (1) links to 3, 4, 5, 7, 9, 40; Tea (2) links to 3, 4, 5, 8, 40.
    self.assertEqual(body['sourceLinks'], 6)
    self.assertEqual(body['targetLinks'], 5)

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

  def path(self, query, client=None):
    return (client or self.app).get(f'/api/graph/path?{query}').get_json()

  def test_path_summary_counts_every_shortest_path(self):
    body = self.path('source=100&target=110')
    self.assertEqual(body['hops'], 3)
    self.assertEqual(body['totalPaths'], 4)
    self.assertEqual(body['shownPaths'], 4)
    through = {page['title']: page['through'] for column in body['steps'] for page in column}
    self.assertEqual(through, {'Branch A': 2, 'Branch B': 1, 'Branch C': 1, 'Middle D': 2, 'Middle E': 2})

  def test_path_summary_shows_busiest_stops_and_only_real_links(self):
    body = self.path('source=100&target=110&perStep=1')
    self.assertEqual([[page['title'] for page in column] for column in body['steps']], [['Branch A'], ['Middle D']])
    self.assertEqual(body['links'], [[100, 101], [101, 104], [104, 110]])
    self.assertEqual(body['totalPaths'], 4)
    self.assertEqual(body['shownPaths'], 1)

  def test_path_summary_repairs_gaps_so_no_stop_dangles(self):
    body = self.path('source=200&target=210&perStep=2')
    shown = {page['id'] for column in body['steps'] for page in column}
    links = {tuple(link) for link in body['links']}
    for stop in shown:
      self.assertTrue(any(link[1] == stop for link in links), f'{stop} has no incoming shown link')
      self.assertTrue(any(link[0] == stop for link in links), f'{stop} has no outgoing shown link')
    self.assertIn(205, shown)  # Yard: the busiest stop at step 2
    self.assertEqual(body['shownPaths'], 2)

  def test_path_summary_prefers_quiet_stops_over_hubs(self):
    body = self.path('source=300&target=310&perStep=1')
    self.assertEqual(body['steps'][0][0]['title'], 'Quiet stop')
    self.assertEqual(body['totalPaths'], 3)

  def test_search_handles_multi_word_titles(self):
    body = self.app.get('/api/graph/search?q=Beverage%20Ind').get_json()
    self.assertEqual([result['title'] for result in body['results']], ['Beverage Industry Trade'])

  def test_titles_with_quotes_are_unescaped_and_searchable(self):
    page = self.app.get('/api/graph/pages?ids=50').get_json()['pages'][0]
    self.assertEqual(page['title'], "April Fools' Day")
    results = self.app.get("/api/graph/search?q=April%20Fools'").get_json()['results']
    self.assertEqual([item['title'] for item in results], ["April Fools' Day"])
    lookup = self.app.get("/api/graph/page?title=April%20Fools'%20Day").get_json()
    self.assertEqual(lookup['page']['id'], 50)

  def test_database_is_opened_read_only(self):
    conn = sqlite3.connect(self.db.resolve().as_uri() + '?mode=ro', uri=True)
    with self.assertRaises(sqlite3.OperationalError):
      conn.execute('DELETE FROM links')
    conn.close()


if __name__ == '__main__':
  unittest.main()
