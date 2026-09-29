import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationPath = new URL(
  '../supabase/migrations/20260929160000_create_compaction_runs.sql',
  import.meta.url,
);

describe('cloud dashboard schema', () => {
  it('stores bounded metrics behind RLS without public table policies', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toContain('create table public.compaction_runs');
    expect(sql).toContain('enable row level security');
    expect(sql).toContain('revoke all on table public.compaction_runs from anon, authenticated');
    expect(sql).toContain('grant select, insert on table public.compaction_runs to service_role');
    expect(sql).not.toMatch(/create\s+policy/i);
    expect(sql).not.toMatch(/^\s*(prompt|transcript|tool_name|tool_input|tool_output|private_path)\s+/im);
  });
});
