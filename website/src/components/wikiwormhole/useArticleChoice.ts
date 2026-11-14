import {useEffect, useState} from 'react';

import {searchArticles, type Article} from './api';
import {closestArticle, rankArticleMatches} from './articleMatch';

export function useArticleChoice() {
  const [query, setQueryValue] = useState('');
  // The text displayed in the box can change when an article is selected.
  // Only explicit typing/detection updates should start a new search.
  const [search, setSearch] = useState({label: ''});
  const [article, setArticle] = useState<Article | null>(null);
  const [candidates, setCandidates] = useState<Article[]>([]);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState('');
  function setQuery(value: string) {
    if (value === query) return;
    setQueryValue(value);
    setSearch({label: value});
    setArticle(null);
    setCandidates([]);
    setError('');
    setResolving(value.trim().length >= 2);
  }
  useEffect(() => {
    const label = search.label.trim();
    if (label.length < 2) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const result = await searchArticles(label);
        if (cancelled) return;
        const ranked = rankArticleMatches(label, result.candidates);
        const best = closestArticle(label, ranked);
        setCandidates(ranked);
        setArticle(best);
        if (best) setQueryValue(best.title);
        if (!ranked.length) setError('No article found. Try another name.');
        else if (!best) setError('Choose a more specific object name.');
      } catch (error) {
        if (!cancelled)
          setError(
            error instanceof Error ? error.message : 'Article search is unavailable. Try again.'
          );
      } finally {
        if (!cancelled) setResolving(false);
      }
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [search]);
  function choose(selected: Article) {
    setArticle(selected);
    setQueryValue(selected.title);
    setError('');
  }
  return {query, setQuery, article, choose, candidates, resolving, error};
}
