export class WikiError extends Error {
  constructor(message: string, public status = 502, public code = 'wikipedia_error', public retryAfterSeconds?: number) {
    super(message);
  }
}

export class RequestBudget {
  used = 0;
  cacheHits = 0;
  readonly actions: string[] = [];
  constructor(public readonly limit: number, public readonly deadline: number, public readonly signal?: AbortSignal) {}
  check() {
    if (this.signal?.aborted) throw new WikiError('Search cancelled.', 499, 'cancelled');
    if (Date.now() >= this.deadline) throw new WikiError('Search time limit reached.', 504, 'time_limit');
  }
  take(action: string) {
    this.check();
    if (this.used >= this.limit) throw new WikiError('Search request limit reached.', 429, 'request_limit');
    this.used += 1;
    this.actions.push(action);
  }
}

function pause(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {reject(new WikiError('Search cancelled.', 499, 'cancelled')); return;}
    const done = () => {signal?.removeEventListener('abort', cancel); resolve();};
    const timer = setTimeout(done, ms);
    const cancel = () => {clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(new WikiError('Search cancelled.', 499, 'cancelled'));};
    signal?.addEventListener('abort', cancel, {once: true});
  });
}

export function retryDelay(value: string | null, now = Date.now()) {
  if (!value) return 5000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1000, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1000, date - now) : 5000;
}

// An isolate shares this queue across all callers, not just one link traversal.
// Cross-isolate traffic is still subject to Wikimedia's own limits.
export class WikipediaTransport {
  private tail: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;
  private cooldownUntil = 0;
  constructor(private readonly fetcher: typeof fetch = (input, init) => fetch(input, init), private readonly spacingMs = 1000) {}

  request(url: string, budget: RequestBudget): Promise<any> {
    const result = this.tail.then(() => this.perform(url, budget));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async perform(url: string, budget: RequestBudget) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      budget.check();
      const waitMs = Math.max(0, this.nextRequestAt - Date.now(), this.cooldownUntil - Date.now());
      if (Date.now() + waitMs + 1000 >= budget.deadline) {
        if (this.cooldownUntil > Date.now()) throw this.throttled();
        throw new WikiError('Wikipedia search is busy. Try again shortly.', 503, 'upstream_busy', Math.ceil(waitMs / 1000));
      }
      if (waitMs) await pause(waitMs, budget.signal);
      budget.take('Wikipedia query');
      this.nextRequestAt = Date.now() + this.spacingMs;
      let response: Response;
      try {
        const timeout = AbortSignal.timeout(Math.max(1, Math.min(8000, budget.deadline - Date.now())));
        response = await this.fetcher(url, {
          headers: {'User-Agent': "WhatsBetween/2.1 (https://whatsbetween.us/; interactive source-backed research)", 'Api-User-Agent': "WhatsBetween/2.1 (https://whatsbetween.us/; interactive source-backed research)"},
          signal: budget.signal ? AbortSignal.any([timeout, budget.signal]) : timeout,
        });
      } catch (error) {
        console.warn('Wikipedia network request failed', {message: error instanceof Error ? error.message : 'network error'});
        budget.check();
        throw new WikiError('Wikipedia could not be reached. Your selected articles are still here.', 502, 'upstream_unavailable');
      }
      let data: any = null;
      if (response.ok) {
        try {data = await response.json();} catch {throw new WikiError('Wikipedia returned an unreadable response. Try again shortly.', 502, 'invalid_upstream_response');}
      }
      const code = data?.error?.code;
      const throttled = response.status === 429 || code === 'ratelimited';
      const busy = response.status === 503 || code === 'maxlag';
      if (throttled || busy) {
        const delay = retryDelay(response.headers.get('Retry-After'));
        this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + delay);
        console.warn('Wikipedia delayed request', {status: response.status, code: code || null, retryAfterSeconds: Math.ceil(delay / 1000)});
        // One retry only, inside the same request/time budgets. No retry loop.
        if (attempt === 0 && budget.used < budget.limit && Date.now() + delay + 1000 < budget.deadline) continue;
        throw throttled ? this.throttled() : new WikiError('Wikipedia is temporarily busy. Your selected articles are still here; try again shortly.', 503, 'upstream_busy', Math.ceil(delay / 1000));
      }
      if (!response.ok) throw new WikiError('Wikipedia returned an error. Your selected articles are still here.', 502);
      if (data?.error) throw new WikiError('Wikipedia rejected the request. Try another article.', 502);
      return data;
    }
    throw this.throttled();
  }

  private throttled() {
    const seconds = Math.max(1, Math.ceil((this.cooldownUntil - Date.now()) / 1000));
    return new WikiError(`Wikipedia asked us to pause. Your selected articles are still here; try again in ${seconds} seconds.`, 503, 'upstream_throttled', seconds);
  }
}
