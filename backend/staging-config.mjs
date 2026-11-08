// Emit a standalone Wrangler configuration. This command never contacts Cloudflare.
import { readFileSync } from 'node:fs';

try {
  const production = JSON.parse(readFileSync(new URL('./wrangler.jsonc', import.meta.url), 'utf8'));
  const databaseId = process.env.SHOPAI_STAGING_DB_ID || '';
  const accessAud = process.env.SHOPAI_STAGING_ACCESS_AUD || '';
  const existingDatabases = [...(production.d1_databases || []), ...(production.previews?.d1_databases || [])];
  const existingAudiences = [production.vars?.ACCESS_AUD, production.previews?.vars?.ACCESS_AUD];
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(databaseId)
      || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(databaseId)
      || existingDatabases.some(db => db.database_id.toLowerCase() === databaseId.toLowerCase())) {
    throw new Error('Staging cần SHOPAI_STAGING_DB_ID hợp lệ của DB riêng, khác production và PR preview.');
  }
  if (!/^[a-f0-9]{64}$/.test(accessAud) || existingAudiences.includes(accessAud)) {
    throw new Error('Staging cần SHOPAI_STAGING_ACCESS_AUD của ứng dụng Access riêng.');
  }
  const config = {
    name: 'shopai-staging',
    main: 'dist/app.js',
    build: { command: 'node build.mjs' },
    compatibility_date: production.compatibility_date,
    workers_dev: false,
    preview_urls: false,
    version_metadata: { binding: 'CF_VERSION_METADATA' },
    ai: { binding: 'AI' },
    ratelimits: [{ name: 'AI_RATE_LIMITER', namespace_id: '1003', simple: { limit: 10, period: 60 } }],
    vars: {
      ACCESS_TEAM_DOMAIN: 'restless-butterfly-687f.cloudflareaccess.com',
      ACCESS_AUD: accessAud,
      ALLOWED_ORIGINS: 'https://preview.shoppost.net',
      AI_MODEL: production.vars.AI_MODEL,
    },
    d1_databases: [{ binding: 'DB', database_name: 'shopai-drafts-staging', database_id: databaseId, migrations_dir: 'migrations' }],
    routes: [{ pattern: 'preview.shoppost.net', custom_domain: true }],
  };
  process.stdout.write(JSON.stringify(config, null, 2) + '\n');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
