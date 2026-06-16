#!/usr/bin/env node
// scripts/migrate.js
// Simple forward-only migration runner. Applies every *.sql in ./sql in
// lexical order, tracked in the schema_migrations table.
//
// Usage:
//   node scripts/migrate.js
//
// Idempotent: already-applied files are skipped.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../src/db');

async function ensureMigrationsTable() {
  await db.query(`
    create table if not exists schema_migrations (
      filename   text primary key,
      applied_at timestamptz not null default now()
    )
  `);
}

async function appliedFiles() {
  const r = await db.query('select filename from schema_migrations');
  return new Set(r.rows.map((row) => row.filename));
}

async function run() {
  if (!db.isEnabled()) {
    console.error('[migrate] DATABASE_URL is not set. Aborting.');
    process.exit(1);
  }

  const sqlDir = path.resolve(__dirname, '..', 'sql');
  if (!fs.existsSync(sqlDir)) {
    console.error(`[migrate] sql directory not found: ${sqlDir}`);
    process.exit(1);
  }

  await ensureMigrationsTable();
  const already = await appliedFiles();

  const files = fs
    .readdirSync(sqlDir)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort();

  if (!files.length) {
    console.log('[migrate] no .sql files found, nothing to do');
    return;
  }

  let applied = 0;
  for (const file of files) {
    if (already.has(file)) {
      console.log(`[migrate] skip   ${file} (already applied)`);
      continue;
    }
    const fullPath = path.join(sqlDir, file);
    const sql = fs.readFileSync(fullPath, 'utf8');
    console.log(`[migrate] apply  ${file}`);
    await db.withClient(async (client) => {
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query(
          'insert into schema_migrations (filename) values ($1)',
          [file]
        );
        await client.query('commit');
      } catch (e) {
        await client.query('rollback');
        throw e;
      }
    });
    applied += 1;
  }
  console.log(`[migrate] done. applied ${applied} new migration(s).`);
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[migrate] failed:', e.message);
    process.exit(1);
  });
