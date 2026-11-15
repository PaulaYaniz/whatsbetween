import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {parseEnv} from 'node:util';

import {MongoClient} from 'mongodb';

export async function migrateDates(db, apply = false) {
  const report = [];
  for (const [name, fields] of [
    ['investigations', ['createdAt', 'updatedAt']],
    ['findings', ['createdAt']],
    ['runs', ['createdAt']],
  ]) {
    const collection = db.collection(name);
    for (const field of fields) {
      const filter = {[field]: {$type: 'string'}};
      const count = await collection.countDocuments(filter);
      if (apply && count)
        await collection.updateMany(filter, [
          {
            $set: {
              [field]: {
                $convert: {
                  input: '$' + field,
                  to: 'date',
                  onError: '$' + field,
                  onNull: '$' + field,
                },
              },
            },
          },
        ]);
      report.push({collection: name, field, stringsFound: count});
    }
  }
  const runs = db.collection('runs');
  const missingExpiry = {createdAt: {$type: 'date'}, expiresAt: {$exists: false}};
  const count = await runs.countDocuments(missingExpiry);
  if (apply) {
    // Give existing logs at least 30 days from migration; avoid immediate historical deletion.
    const minimumExpiry = new Date(Date.now() + 30 * 86400_000);
    await runs.updateMany(missingExpiry, [
      {$set: {expiresAt: {$max: [{$add: ['$createdAt', 30 * 86400_000]}, minimumExpiry]}}},
    ]);
    await runs.createIndex({expiresAt: 1}, {expireAfterSeconds: 0});
  }
  report.push({collection: 'runs', missingExpiry: count, applied: apply});
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = parseEnv(readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8'));
  const client = new MongoClient(env.MONGODB_URI, {serverSelectionTimeoutMS: 6000});
  try {
    await client.connect();
    console.log(
      JSON.stringify(
        await migrateDates(
          client.db(env.MONGODB_DATABASE || 'whatsbetween'),
          process.argv.includes('--apply')
        ),
        null,
        2
      )
    );
  } finally {
    await client.close();
  }
}
