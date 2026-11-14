import {MongoClient, type Db} from 'mongodb';

import type {Article, Connection, Env, Evidence, PathInfo} from './types';

export interface Finding {
  status: 'Supported finding' | 'Hypothesis' | 'Insufficient evidence';
  finding: string;
  claims: {claim: string; evidenceIds: string[]}[];
  uncertainty: string;
  followUp: string;
}

export interface InvestigationSummary {
  id: string;
  source: Article;
  target: Article;
  path?: PathInfo;
  question: string;
  createdAt: string;
  updatedAt: string;
  runStatus: string;
  finding?: Finding;
  version?: number;
}

function databaseName(env: Env) {
  return env.MONGODB_DATABASE || 'whatsbetween';
}

export async function withDatabase<T>(env: Env, action: (db: Db) => Promise<T>) {
  if (!env.MONGODB_URI) throw new Error('MongoDB Atlas is not configured. Add MONGODB_URI.');
  const uri = env.MONGODB_URI;
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 6000,
    connectTimeoutMS: 6000,
  } as any);
  try {
    await client.connect();
    return await action(client.db(databaseName(env)));
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function ensureIndexes(db: Db) {
  await Promise.all([
    db.collection('investigations').createIndex({ownerSessionId: 1, updatedAt: -1}),
    db.collection('findings').createIndex({investigationId: 1, version: -1}, {unique: true}),
    db.collection('evidence').createIndex({investigationId: 1, sourceArticleId: 1, revisionId: 1}),
    db.collection('runs').createIndex({investigationId: 1, createdAt: -1}),
  ]);
}

function boundedEvidence(evidence: Evidence[]) {
  return evidence.map((item) => ({...item, excerpt: item.excerpt.slice(0, 1200)}));
}

function publicSummary(record: any): InvestigationSummary {
  return {
    id: record.id,
    source: record.source,
    target: record.target,
    question: record.question,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    runStatus: record.runStatus,
    finding: record.finding,
    version: record.version,
    ...(record.path ? {path: record.path} : {}),
  };
}

export async function saveInvestigation(
  env: Env,
  ownerSessionId: string,
  connection: Connection,
  question: string,
  finding?: Finding
) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const evidence = boundedEvidence(
    Object.values(connection.evidenceByTopic)
      .flat()
      .filter((item, index, all) => all.findIndex((other) => other.id === item.id) === index)
  );
  const storedFinding = finding || {
    status: 'Insufficient evidence' as const,
    finding: '',
    claims: [],
    uncertainty: 'A deeper investigation has not been completed.',
    followUp: 'Dig deeper into this connection.',
  };
  const record = {
    id,
    ownerSessionId,
    source: connection.source,
    target: connection.target,
    selectedArticleIds: [connection.source.id, connection.target.id],
    path: connection.path ?? null,
    question: question.slice(0, 1200),
    createdAt: now,
    updatedAt: now,
    runStatus: 'saved',
    version: 1,
  };
  await withDatabase(env, async (db) => {
    await ensureIndexes(db);
    await db.collection('investigations').insertOne(record);
    if (evidence.length)
      await db
        .collection('evidence')
        .insertMany(
          evidence.map((item) => ({
            ...item,
            investigationId: id,
            ownerSessionId,
            findingVersion: 1,
          }))
        );
    const storedCard = {
      ...storedFinding,
      finding: finding
        ? storedFinding.finding
        : connection.sharedTopics[0]?.title || 'Shared topic',
      claims: finding?.claims || [],
    };
    await db
      .collection('findings')
      .insertOne({
        investigationId: id,
        ownerSessionId,
        version: 1,
        parentVersion: null,
        finding: storedCard,
        evidenceIds: storedFinding.claims.flatMap((claim) => claim.evidenceIds),
        createdAt: now,
        modelVersion: env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
        promptVersion: 'discovery-v1',
      });
  });
  return {...publicSummary({...record, finding: storedFinding}), evidenceCount: evidence.length};
}

export async function appendFindingVersion(
  env: Env,
  ownerSessionId: string,
  investigationId: string,
  finding: Finding,
  evidence: Evidence[],
  run: {
    toolActions: string[];
    durationMs: number;
    requestCount: number;
    modelCalls: number;
    status: string;
    stopReason?: string;
  }
) {
  return withDatabase(env, async (db) => {
    await ensureIndexes(db);
    const collection = db.collection('investigations');
    const current = await collection.findOne({id: investigationId, ownerSessionId});
    if (!current) return null;
    const version = Number(current.version || 1) + 1;
    const now = new Date().toISOString();
    const bounded = boundedEvidence(evidence);
    if (bounded.length)
      await db
        .collection('evidence')
        .insertMany(
          bounded.map((item) => ({
            ...item,
            investigationId,
            ownerSessionId,
            findingVersion: version,
          }))
        );
    await db
      .collection('findings')
      .insertOne({
        investigationId,
        ownerSessionId,
        version,
        parentVersion: version - 1,
        finding,
        evidenceIds: finding.claims.flatMap((claim) => claim.evidenceIds),
        createdAt: now,
        modelVersion: env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
        promptVersion: 'investigation-v1',
      });
    await db
      .collection('runs')
      .insertOne({investigationId, ownerSessionId, ...run, createdAt: now});
    await collection.updateOne(
      {id: investigationId, ownerSessionId},
      {$set: {updatedAt: now, runStatus: run.status, version}}
    );
    const updated = await collection.findOne({id: investigationId, ownerSessionId});
    return updated
      ? {...publicSummary({...updated, finding, version}), evidenceCount: bounded.length}
      : null;
  });
}

export async function loadInvestigation(env: Env, ownerSessionId: string, id: string) {
  return withDatabase(env, async (db) => {
    const record = await db.collection('investigations').findOne({id, ownerSessionId});
    if (!record) return null;
    const findings = await db
      .collection('findings')
      .find({investigationId: id, ownerSessionId})
      .sort({version: -1})
      .limit(2)
      .toArray();
    const evidence = await db
      .collection('evidence')
      .find({investigationId: id, ownerSessionId, findingVersion: findings[0]?.version || 1})
      .sort({retrievedAt: -1})
      .limit(24)
      .toArray();
    return {...publicSummary({...record, finding: findings[0]?.finding}), findings, evidence};
  });
}

export async function listInvestigations(env: Env, ownerSessionId: string) {
  return withDatabase(env, async (db) => {
    const rows = await db
      .collection('investigations')
      .find({ownerSessionId})
      .sort({updatedAt: -1})
      .limit(100)
      .toArray();
    return rows.map(publicSummary);
  });
}

export async function deleteInvestigation(env: Env, ownerSessionId: string, id: string) {
  return withDatabase(env, async (db) => {
    const result = await db.collection('investigations').deleteOne({id, ownerSessionId});
    if (!result.deletedCount) return false;
    await Promise.all([
      db.collection('evidence').deleteMany({investigationId: id, ownerSessionId}),
      db.collection('findings').deleteMany({investigationId: id, ownerSessionId}),
      db.collection('runs').deleteMany({investigationId: id, ownerSessionId}),
    ]);
    return true;
  });
}
