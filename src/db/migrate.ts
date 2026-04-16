import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { sql } from './index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, 'migrations')

async function ensureMigrationsTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
}

async function appliedSet(): Promise<Set<string>> {
  // Neon HTTP driver returns Record<string, unknown>[]; cast to the projected shape.
  const rows = (await sql`SELECT name FROM schema_migrations`) as unknown as Array<{ name: string }>
  return new Set(rows.map((r) => r.name))
}

async function run() {
  await ensureMigrationsTable()
  const applied = await appliedSet()

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort()

  for (const name of files) {
    if (applied.has(name)) {
      console.log(`skip  ${name}`)
      continue
    }
    const body = await readFile(join(migrationsDir, name), 'utf8')
    console.log(`apply ${name}`)
    // neon HTTP driver: strip comment lines, then split on ';' and execute each statement.
    const stripped = body
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
    const statements = stripped
      .split(/;\s*(?:\n|$)/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    for (const stmt of statements) {
      await sql.query(stmt)
    }
    await sql`INSERT INTO schema_migrations (name) VALUES (${name})`
  }
  console.log('done')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
