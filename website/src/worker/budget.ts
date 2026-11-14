import {withDatabase} from './store';
import type {Env} from './types';

// Shared daily cap on model-backed requests (recognition, discovery cards, research), counted in
// MongoDB Atlas so it applies across all visitors and sessions. Cookies do not reset it.
export const DEFAULT_DAILY_MODEL_LIMIT = 200;

export type ModelReservation =
  {allowed: true} | {allowed: false; reason: 'disabled' | 'daily_limit' | 'budget_unavailable'};

export async function reserveModelCall(env: Env): Promise<ModelReservation> {
  // Kill switch: MODEL_ENABLED=false turns off every Gemini-backed route without a redeploy.
  if (env.MODEL_ENABLED === 'false') return {allowed: false, reason: 'disabled'};
  const configured = Number(env.DAILY_MODEL_LIMIT);
  const limit =
    Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_DAILY_MODEL_LIMIT;
  const day = new Date().toISOString().slice(0, 10);
  try {
    const doc: any = await withDatabase(env, (db) =>
      db
        .collection('usage')
        .findOneAndUpdate(
          {_id: `model-${day}` as any},
          {$inc: {count: 1}},
          {upsert: true, returnDocument: 'after'}
        )
    );
    const count = Number(doc?.count ?? doc?.value?.count ?? 0);
    return count > limit ? {allowed: false, reason: 'daily_limit'} : {allowed: true};
  } catch {
    // If the shared counter cannot be read, do not spend model quota.
    return {allowed: false, reason: 'budget_unavailable'};
  }
}

export const MODEL_UNAVAILABLE_MESSAGES: Record<string, string> = {
  disabled: 'AI features are paused right now. Path and shared-topic results still work.',
  daily_limit: "AI features have reached today's limit. They reset tomorrow (UTC).",
  budget_unavailable: 'AI features are temporarily unavailable. Try again shortly.',
};
