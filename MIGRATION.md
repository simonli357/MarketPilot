# V1 To V2 Migration

V2 removes duplicated mutable state. Migration is archive-first and dry-run by default.

```bash
npm run project:migrate
npm run project:migrate -- --apply
npm run project:check
npm run project:status
```

The apply mode copies detected v1 files to `docs/legacy-v1/` without overwriting an existing archive and writes a migration report. It does not synthesize project decisions or delete the originals. Move durable facts into their v2 owners, compare them against the parity map, then remove obsolete v1 files in a reviewed commit.

The migration tool never reads, moves, or edits `human.md`.
