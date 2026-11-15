import {RunnableLambda, type RunnableConfig} from '@langchain/core/runnables';
import {z} from 'zod';

const Claim = z.object({
  claim: z.string().max(500),
  evidenceIds: z.array(z.string()).min(1).max(6),
});
const Lead = z.object({
  angle: z.enum(['history', 'design']),
  claims: z.array(Claim).max(3),
  gaps: z.array(z.string().max(300)).max(3),
});
const Review = z.object({
  approved: z.array(Claim).max(6),
  rejected: z.array(z.string().max(500)).max(6),
  retry: z.object({angle: z.enum(['history', 'design']), question: z.string().max(300)}).nullable(),
});
export type TeamLead = z.infer<typeof Lead>;
export type TeamReview = z.infer<typeof Review>;

export function parseTeamLead(
  value: unknown,
  angle: 'history' | 'design',
  evidenceIds: Set<string>
) {
  const lead = Lead.parse(value);
  if (lead.angle !== angle) throw new Error('Investigator returned the wrong angle.');
  if (lead.claims.some((c) => c.evidenceIds.some((id) => !evidenceIds.has(id))))
    throw new Error('Investigator cited unrecorded evidence.');
  return lead;
}
export function parseTeamReview(value: unknown, leads: TeamLead[]) {
  const review = Review.parse(value);
  const proposed = leads.flatMap((lead) => lead.claims);
  if (
    review.approved.some(
      (c) =>
        !proposed.some(
          (p) => p.claim === c.claim && c.evidenceIds.every((id) => p.evidenceIds.includes(id))
        )
    )
  )
    throw new Error('Reviewer approved a claim outside the handoff.');
  return review;
}

export async function runResearchTeam(
  options: {
    investigate: (
      angle: 'history' | 'design',
      question?: string,
      config?: RunnableConfig
    ) => Promise<TeamLead>;
    verify: (leads: TeamLead[], config?: RunnableConfig) => Promise<unknown>;
    review: (
      leads: TeamLead[],
      verification: unknown,
      config?: RunnableConfig
    ) => Promise<TeamReview>;
    canRetry: () => boolean;
    activity: (message: string) => void;
  },
  config: RunnableConfig = {}
) {
  // Explicit orchestration gives each branch its own context and trace parent without
  // relying on the coordinator remembering to delegate. Exactly two initial leads.
  const researcher = RunnableLambda.from(async (_input: unknown, childConfig) => {
    options.activity('Connection researcher: investigating history and design leads');
    const settled = await Promise.allSettled(
      (['history', 'design'] as const).map((angle) =>
        RunnableLambda.from((_input, config) =>
          options.investigate(angle, undefined, config)
        ).invoke(
          {},
          {
            ...childConfig,
            runName: angle === 'history' ? 'Historical investigator' : 'Design investigator',
          }
        )
      )
    );
    return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  });
  const reviewer = RunnableLambda.from(async (leads: TeamLead[], childConfig) => {
    options.activity('Skeptical reviewer: checking competing explanations');
    const verification = await RunnableLambda.from((_input, config) =>
      options.verify(leads, config)
    ).invoke({}, {...childConfig, runName: 'Citation verifier'});
    return options.review(leads, verification, childConfig);
  });
  let leads = await researcher.invoke({}, {...config, runName: 'Connection researcher'});
  if (!leads.length) return {leads, review: null, retried: false};
  let review = await reviewer.invoke(leads, {...config, runName: 'Skeptical reviewer'});
  let retried = false;
  if (review.retry && options.canRetry()) {
    retried = true;
    const request = review.retry;
    options.activity('Revising the plan: one targeted investigation');
    const revised = await RunnableLambda.from((_input, config) =>
      options.investigate(request.angle, request.question, config)
    ).invoke({}, {...config, runName: 'Targeted reinvestigation'});
    leads = leads.filter((lead) => lead.angle !== request.angle).concat(revised);
    review = await reviewer.invoke(leads, {...config, runName: 'Final skeptical review'});
  }
  return {leads, review, retried};
}
