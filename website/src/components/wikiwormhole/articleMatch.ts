import type {Article} from '../../worker/types';

const normalize = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[_\W]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

function editDistance(left: string, right: string) {
  let row = Array.from({length: right.length + 1}, (_, index) => index);
  for (let a = 0; a < left.length; a++) {
    const next = [a + 1];
    for (let b = 0; b < right.length; b++)
      next.push(Math.min(next[b] + 1, row[b + 1] + 1, row[b] + (left[a] === right[b] ? 0 : 1)));
    row = next;
  }
  return row[right.length];
}

export function rankArticleMatches(label: string, candidates: Article[]) {
  const query = normalize(label);
  const score = (article: Article) => {
    if (article.disambiguation || /\(disambiguation\)$/i.test(article.title)) return Infinity;
    const title = normalize(article.title);
    if (query === title) return 0;
    if (query === normalize(article.title.replace(/\s*\([^)]*\)/g, ''))) return 0.1;
    if (query.replace(/s$/, '') === title.replace(/s$/, '')) return 0.15;
    return 0.2 + editDistance(query, title) / Math.max(query.length, title.length, 1);
  };
  return [...new Map(candidates.map((article) => [article.id, article])).values()]
    .map((article, index) => ({article, index, score: score(article)}))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((item) => item.article);
}

export function closestArticle(label: string, candidates: Article[]) {
  return (
    rankArticleMatches(label, candidates).find(
      (article) => !article.disambiguation && !/\(disambiguation\)$/i.test(article.title)
    ) || null
  );
}
