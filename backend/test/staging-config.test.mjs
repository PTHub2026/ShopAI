import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const script = new URL('../staging-config.mjs', import.meta.url).pathname;
const source = new URL('../wrangler.jsonc', import.meta.url);
const production = JSON.parse(readFileSync(source, 'utf8'));
const valid = {
  SHOPAI_STAGING_DB_ID: '11111111-2222-4333-8444-555555555555',
  SHOPAI_STAGING_ACCESS_AUD: 'a'.repeat(64),
};
const run = overrides => spawnSync(process.execPath, [script], {
  env: { ...process.env, ...valid, ...overrides }, encoding: 'utf8',
});

test('staging configuration targets only the approved hostname and a separate database', () => {
  const before = readFileSync(source, 'utf8');
  const result = run({});
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.name, 'shopai-staging');
  assert.deepEqual(config.routes, [{ pattern: 'preview.shoppost.net', custom_domain: true }]);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.d1_databases, [{
    binding: 'DB', database_name: 'shopai-drafts-staging',
    database_id: valid.SHOPAI_STAGING_DB_ID, migrations_dir: 'migrations',
  }]);
  assert.equal(config.vars.ACCESS_AUD, valid.SHOPAI_STAGING_ACCESS_AUD);
  assert.equal(config.vars.ACCESS_TEAM_DOMAIN, 'restless-butterfly-687f.cloudflareaccess.com');
  assert.equal(config.vars.ALLOWED_ORIGINS, 'https://preview.shoppost.net');
  assert.equal(config.ratelimits[0].namespace_id, '1003');
  assert.equal(config.previews, undefined);
  assert.equal(readFileSync(source, 'utf8'), before);
});

test('staging configuration refuses missing, malformed or shared resource identifiers', () => {
  const invalid = [
    { SHOPAI_STAGING_DB_ID: '' },
    { SHOPAI_STAGING_DB_ID: 'not-a-database' },
    { SHOPAI_STAGING_DB_ID: '00000000-0000-0000-0000-000000000000' },
    { SHOPAI_STAGING_ACCESS_AUD: '' },
    { SHOPAI_STAGING_ACCESS_AUD: 'not-an-audience' },
    ...production.d1_databases.map(db => ({ SHOPAI_STAGING_DB_ID: db.database_id })),
    ...production.previews.d1_databases.map(db => ({ SHOPAI_STAGING_DB_ID: db.database_id })),
    { SHOPAI_STAGING_ACCESS_AUD: production.vars.ACCESS_AUD },
  ];
  for (const overrides of invalid) {
    const result = run(overrides);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /staging/i);
  }
});
