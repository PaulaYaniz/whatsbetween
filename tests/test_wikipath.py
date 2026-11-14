"""Offline tests for the live Wikipedia path search, using an in-memory fake MediaWiki API."""
import unittest

from flask import Flask
from sdow.wikipath import BATCH, PathFinder, WikiClient, WikiError, create_blueprint, is_generic


class FakeWiki:
  """Answers the subset of MediaWiki Action API queries used by PathFinder."""

  def __init__(self, links, redirects=None, disambiguation=(), page_size=500, hubs=None):
    self.links = links                      # title -> [linked titles, possibly redirects]
    self.redirects = redirects or {}        # redirect title -> target title
    self.disambiguation = set(disambiguation)
    self.page_size = page_size
    self.hubs = hubs
    titles = set(links) | {t for v in links.values() for t in v}
    self.ids = {t: n + 1 for n, t in enumerate(sorted(titles - set(self.redirects)))}
    self.calls = []

  def canonical(self, title):
    return self.redirects.get(title, title)

  def page(self, title, **extra):
    title = self.canonical(title)
    if title not in self.ids:
      return {'ns': 0, 'title': title, 'missing': True}
    page = {'pageid': self.ids[title], 'ns': 0, 'title': title, **extra}
    if title in self.disambiguation:
      page['pageprops'] = {'disambiguation': ''}
    return page

  def paginate(self, items, params, key):
    start = int(params.get(key, 0))
    chunk = items[start:start + self.page_size]
    result = {'query': {}}
    if start + self.page_size < len(items):
      result['continue'] = {key: str(start + self.page_size), 'continue': '-||'}
    return chunk, result

  def __call__(self, params):
    self.calls.append(params)
    if params.get('generator') == 'links':
      source = params['titles']
      targets = self.links.get(source, [])
      chunk, result = self.paginate(targets, params, 'gplcontinue')
      result['query']['pages'] = [self.page(t) for t in chunk]
      result['query']['redirects'] = [{'from': t, 'to': self.redirects[t]}
                                      for t in chunk if t in self.redirects]
      return result
    if params.get('list') == 'backlinks':
      target = params['bltitle']
      items = []
      for source, targets in sorted(self.links.items()):
        if target in targets:
          items.append({'pageid': self.ids[source], 'ns': 0, 'title': source})
      for redirect, real in self.redirects.items():
        if real == target:
          inner = [{'pageid': self.ids[s], 'ns': 0, 'title': s}
                   for s, t in sorted(self.links.items()) if redirect in t]
          items.append({'pageid': 9000 + len(items), 'ns': 0, 'title': redirect,
                        'redirect': True, 'redirlinks': inner})
      chunk, result = self.paginate(items, params, 'blcontinue')
      result['query']['backlinks'] = chunk
      return result
    if params.get('prop') == 'redirects':
      target = params['titles']
      return {'query': {'pages': [{**self.page(target), 'redirects': [
          {'title': r} for r, t in self.redirects.items() if t == target]}]}}
    if params.get('prop') == 'links':
      wanted = set(params['pltitles'].split('|'))
      pages = []
      for title in params['titles'].split('|'):
        found = [{'ns': 0, 'title': t} for t in self.links.get(title, []) if t in wanted]
        pages.append({**self.page(title), **({'links': found} if found else {})})
      return {'query': {'pages': pages}}
    if params.get('list') == 'search':
      target = params['srsearch'][len('linksto:"'):-1]
      ranked = self.hubs if self.hubs is not None else sorted(
          s for s, t in self.links.items() if target in t)
      start = int(params.get('sroffset', 0))
      return {'query': {'search': [{'pageid': self.ids[t], 'title': t, 'ns': 0}
                                   for t in ranked[start:start + BATCH]]}}
    if params.get('generator') == 'search':
      query = params['gsrsearch'].lower()
      matches = [t for t in sorted(self.ids) if query in t.lower()]
      return {'query': {'pages': [self.page(t, index=n + 1) for n, t in enumerate(matches)]}}
    if 'pageids' in params:
      by_id = {v: k for k, v in self.ids.items()}
      return {'query': {'pages': [self.page(by_id[int(i)], description='desc ' + by_id[int(i)])
                                  for i in params['pageids'].split('|')]}}
    if 'titles' in params:
      pages, normalized, redirects = [], [], []
      for title in params['titles'].split('|'):
        if title != title[:1].upper() + title[1:]:
          normalized.append({'from': title, 'to': title[:1].upper() + title[1:]})
          title = title[:1].upper() + title[1:]
        if title in self.redirects:
          redirects.append({'from': title, 'to': self.redirects[title]})
        pages.append(self.page(title))
      return {'query': {'pages': pages, 'normalized': normalized, 'redirects': redirects}}
    raise AssertionError(f'Unhandled fake query: {params}')


def finder(fake, **kwargs):
  return PathFinder(client=WikiClient(get=fake), workers=1, **kwargs)


GRAPH = {
    'Coin': ['Copper', 'Metal', 'ISBN', 'Ancient Rome', 'Banana'],
    'Cup': ['Ceramic', 'Copper', 'ISBN', 'Tea'],
    'Copper': ['Electrical wire', 'Bronze', 'Tea'],
    'Ceramic': ['Clay'],
    'Metal': ['Copper', 'Tea'],
    'Ancient Rome': ['Wine', 'Bronze'],
    'Tea': ['Cup', 'China'],
    'Bronze': ['Bronze Age'],
    'Bronze Age': ['Tea'],
    'Wine': ['Grape'],
    'Banana': ['Fruit'],
}


class PathFinderTests(unittest.TestCase):
  def test_direct_link(self):
    result = finder(FakeWiki(GRAPH)).connect('Coin', 'Banana')
    self.assertEqual(result['status'], 'found')
    self.assertEqual(result['degrees'], 1)
    self.assertEqual(result['method'], 'direct')
    self.assertTrue(result['shortest'])

  def test_two_hop_paths_are_all_found_and_verified(self):
    fake = FakeWiki(GRAPH)
    result = finder(fake).connect('Coin', 'Tea')
    titles = {int(k): v['title'] for k, v in result['pages'].items()}
    middles = sorted(titles[p[1]] for p in result['paths'])
    self.assertEqual(middles, ['Copper', 'Metal'])
    self.assertEqual(result['degrees'], 2)
    self.assertTrue(result['shortest'])
    self.assertEqual(result['method'], 'two_hop_exhaustive')
    for path in result['paths']:
      for left, right in zip(path, path[1:]):
        self.assertIn(titles[right], GRAPH[titles[left]], 'every edge must exist')

  def test_directed_paths_respect_direction(self):
    # Tea links to Cup, but no path from Cup reaches Coin.
    result = finder(FakeWiki(GRAPH)).connect('Cup', 'Coin')
    self.assertEqual(result['status'], 'not_found')
    self.assertEqual(result['paths'], [])
    self.assertFalse(result['shortest'])

  def test_three_hop_bounded_search_is_labelled(self):
    result = finder(FakeWiki(GRAPH)).connect('Cup', 'Bronze Age')
    titles = {int(k): v['title'] for k, v in result['pages'].items()}
    self.assertEqual(result['degrees'], 3)
    self.assertEqual([titles[i] for i in result['paths'][0]],
                     ['Cup', 'Copper', 'Bronze', 'Bronze Age'])
    self.assertEqual(result['method'], 'three_hop_bounded')
    # Depth two was exhaustively ruled out, so length three is provably shortest.
    self.assertTrue(result['shortest'])
    self.assertFalse(result['exhaustive'])

  def test_redirect_links_count_as_links(self):
    graph = {'Spoon': ['Silverware'], 'Cutlery': [], 'Fork': ['Cutlery']}
    fake = FakeWiki(graph, redirects={'Silverware': 'Cutlery'})
    result = finder(fake).connect('Spoon', 'Cutlery')
    self.assertEqual(result['degrees'], 1)
    result = finder(fake).connect('spoon', 'Fork')
    self.assertEqual(result['status'], 'not_found')
    self.assertEqual(result['source']['title'], 'Spoon')

  def test_shared_topics_exclude_endpoints_and_rank_generic_last(self):
    result = finder(FakeWiki(GRAPH)).connect('Coin', 'Cup')
    titles = {int(k): v['title'] for k, v in result['pages'].items()}
    shared = [titles[i] for i in result['sharedTopics']]
    self.assertEqual(shared, ['Copper', 'ISBN'])
    self.assertEqual([titles[i] for i in result['genericTopics']], ['ISBN'])
    self.assertTrue(result['sharedComplete'])

  def test_same_article(self):
    fake = FakeWiki(GRAPH, redirects={'Coins': 'Coin'})
    result = finder(fake).connect('Coins', 'Coin')
    self.assertEqual(result['status'], 'same_article')
    self.assertTrue(result['source']['redirected'])

  def test_missing_article(self):
    with self.assertRaises(WikiError) as error:
      finder(FakeWiki(GRAPH)).connect('Coin', 'Nonexistent thing')
    self.assertEqual(error.exception.code, 'missing_article')

  def test_large_backlink_lists_fall_back_to_exact_checks(self):
    graph = {'A': [f'X{n}' for n in range(30)], 'B': []}
    for n in range(30):
      graph[f'X{n}'] = ['B'] if n == 17 else []
    for n in range(40):                       # Many other pages link to B.
      graph[f'Other{n}'] = ['B']
    fake = FakeWiki(graph, page_size=5)       # Backlinks need more pages than allowed.
    result = finder(fake).connect('A', 'B')
    self.assertFalse(result['linkCounts']['targetIncomingComplete'])
    self.assertEqual(result['pathCount'], 1)
    self.assertTrue(result['shortest'], 'pltitles checks make depth two exact')

  def test_budget_limits_are_reported(self):
    graph = {'A': [f'X{n}' for n in range(200)], 'B': []}
    for n in range(200):
      graph[f'X{n}'] = []
    graph['Y'] = ['B']
    fake = FakeWiki(graph, page_size=20)
    result = finder(fake, max_requests=12).connect('A', 'B')
    self.assertEqual(result['status'], 'not_found')
    self.assertFalse(result['exhaustive'])
    self.assertFalse(result['linkCounts']['sourceOutgoingComplete'])
    self.assertLessEqual(result['stats']['requests'], 12)
    result = finder(FakeWiki(graph, page_size=20), max_requests=4).connect('A', 'B')
    self.assertTrue(result['stats']['budgetExhausted'])
    self.assertLessEqual(result['stats']['requests'], 4)

  def test_cache_avoids_repeat_requests(self):
    fake = FakeWiki(GRAPH)
    path_finder = finder(fake)
    path_finder.connect('Coin', 'Tea')
    calls = len(fake.calls)
    again = path_finder.connect('Coin', 'Tea')
    self.assertEqual(len(fake.calls), calls)
    self.assertEqual(again['stats']['requests'], 0)

  def test_resolve_prefers_articles_over_disambiguation(self):
    graph = {'Mouse': [], 'Computer mouse': [], 'Mouse (disambiguation)': []}
    fake = FakeWiki(graph, disambiguation={'Mouse'})
    result = finder(fake).resolve('mouse')
    self.assertEqual(result['candidates'][0]['title'], 'Mouse')
    self.assertTrue(result['candidates'][0]['disambiguation'])
    self.assertEqual(result['best']['title'], 'Computer mouse')

  def test_generic_titles(self):
    self.assertTrue(is_generic('Doi (identifier)'))
    self.assertTrue(is_generic('Oxford University Press'))
    self.assertTrue(is_generic('List of fruits'))
    self.assertFalse(is_generic('Copper'))

  def test_title_validation(self):
    with self.assertRaises(WikiError):
      finder(FakeWiki(GRAPH)).connect('', 'Coin')
    with self.assertRaises(WikiError):
      finder(FakeWiki(GRAPH)).connect('Coin|Cup', 'Coin')


class BlueprintTests(unittest.TestCase):
  def setUp(self):
    app = Flask(__name__)
    app.register_blueprint(create_blueprint(finder(FakeWiki(GRAPH))))
    self.client = app.test_client()

  def test_connect_endpoint(self):
    response = self.client.post('/wiki/connect', json={'source': 'Coin', 'target': 'Tea'})
    self.assertEqual(response.status_code, 200)
    self.assertEqual(response.get_json()['degrees'], 2)

  def test_errors_are_json(self):
    response = self.client.post('/wiki/connect', json={'source': 'Coin', 'target': 'Nope'})
    self.assertEqual(response.status_code, 404)
    self.assertIn('error', response.get_json())
    response = self.client.post('/wiki/connect', data='not json')
    self.assertEqual(response.status_code, 400)

  def test_rejects_other_origins(self):
    response = self.client.get('/wiki/resolve?q=coin', headers={'Origin': 'https://evil.example'})
    self.assertEqual(response.status_code, 403)

  def test_resolve_endpoint(self):
    response = self.client.get('/wiki/resolve?q=cup')
    self.assertEqual(response.get_json()['best']['title'], 'Cup')


if __name__ == '__main__':
  unittest.main()
