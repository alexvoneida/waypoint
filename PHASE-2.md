# Phase 2: Accounts and ingest pipeline

## What exists

| Piece | Where |
|---|---|
| Schema | `db/migrations/0002_schema.sql` - 15 tables, PostGIS geometry, the §6 model |
| Row-level security | `db/migrations/0003_rls.sql` - 19 policies, `visible_entries`, `public_profiles` |
| Narrow definer functions | `0004`-`0007` - the four operations RLS cannot express |
| Database access | `apps/web/src/lib/db.ts` - `withUser`, transaction-scoped `app.user_id` |
| Auth | `apps/web/src/lib/auth.ts` - argon2, sessions, cookie and bearer |
| Object storage | `apps/web/src/lib/storage.ts` - S3 API, MinIO in dev, R2 in production |
| Media worker | `apps/web/src/lib/jobs/` - `exif.extract` then `derive`, via Inngest |
| Waitlist | `apps/web/src/app/signup` |

```sh
npm run db:up                       # Postgres + PostGIS + MinIO
node --test scripts/test-rls.mjs    # 14 access-control tests
node scripts/test-pipeline.mjs      # the 50-photo gate
```

## Gate

Both halves met.

**A 50-photo batch produces all three derivatives without a timeout.**

```
uploaded via presigned PUT     2440 ms   peak concurrency 12
derivatives generated         15365 ms   peak concurrency 8
total                         18110 ms
4160x5200  ->  full 2048x2560 · web 1024x1280 · thumb 320x400
```

Uploads go through real presigned PUT URLs rather than a direct SDK call, so
what the test exercises is what will run. Derivatives carry no EXIF at all -
verified with `exiftool` against an object pulled back out of the bucket, not
asserted from the code that wrote it.

**A second account cannot read the first account's drafts.** Fourteen tests,
all connecting as the application role, covering drafts, published entries,
cross-account writes, the anonymous case, both visibility switches, session and
invite isolation, and that `app.user_id` cannot leak between pooled connections.

## The thing that would have made every policy useless

`DATABASE_URL` pointed at the role that *owns* the tables. In Postgres an owner
bypasses its own row-level security unless the table forces it, so every policy
would have read correctly and enforced nothing, and every test written against
that connection would have passed.

The application now connects as `waypoint_app`, which owns nothing, and the
first access-control test asserts the connecting role is neither a superuser nor
`BYPASSRLS`. That assertion is the one that catches this class of mistake, and
it is worth more than the thirteen tests after it.

## Where RLS cannot reach, and why that is four functions rather than a weaker policy

Four operations have no acting user by definition, so no policy can match them:
signing in, redeeming an invite, resolving a bearer token, and revoking one.
Each is a `security definer` function with a pinned `search_path`, a static
body, execute granted only to the application role, and a return surface of
exactly what the caller needs. The alternative in each case was widening a
policy - which would have let any anonymous request read any account row, or
enumerate live invite codes.

They are owned by `waypoint_definer`, a role that cannot log in and holds rights
on three tables. Owned by the migration role they would have run as a superuser,
which is authority they do not need and a much larger blast radius if any of
those bodies ever stopped being static.

## Known simplifications

- **Rate limiting is an in-process map.** It does not survive more than one
  instance and must become Redis or Postgres before this is deployed to more
  than one node.
- **`/api/invites/dev-issue` returns 404 in production** but exists at all only
  so the invite flow is walkable locally.
- The upload batch's namespace uuid is not the eventual `entries.id`; entries
  are created after upload, so `photos.key_original` is the source of truth for
  which object belongs to which photo.
