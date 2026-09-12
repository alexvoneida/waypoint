# Deploying Waypoint

Signup is already closed by design (waitlist only, accounts created by invite
redemption) -- nothing about that needs to change for a public deploy. What's
left is standing up the four external services the app depends on and
pointing Vercel at them.

## 1. Neon (Postgres + PostGIS)

1. Create a Neon project on Postgres 16.
2. Connect with the owner (default) role and run:
   ```sql
   create extension if not exists postgis;
   ```
3. Create the unprivileged app role. This is the same split as local dev
   (`db/migrations/0003_rls.sql`): the app connects as a role that owns
   nothing, which is what makes row-level security actually apply to it.
   Migration `0003_rls.sql` creates `waypoint_app` itself with a dev-only
   password -- on Neon, create the role yourself first with a real password
   before running that migration, then skip its `create role` line (or let
   it fail harmlessly if the role already exists, and re-run the rest):
   ```sql
   create role waypoint_app login password '<a real generated password>';
   ```
4. Run every migration in order against the **owner** connection string.
   There's no migration runner in this repo -- local dev relies on
   Postgres's `docker-entrypoint-initdb.d` running them automatically on
   first init, which Neon doesn't have:
   ```sh
   for f in $(ls db/migrations/*.sql | sort); do
     psql "<owner connection string>" -v ON_ERROR_STOP=1 -f "$f"
   done
   ```
   If you pre-created `waypoint_app` in step 3, edit or skip the
   `create role` line in `0003_rls.sql` before running it, so it doesn't
   collide with the role you already made.
5. Run the RLS test suite against Neon before anything real touches this
   database:
   ```sh
   DATABASE_URL="<pooled app-role connection string>" node scripts/test-rls.mjs
   ```
   It connects as `waypoint_app`, creates its own throwaway accounts, and
   asserts cross-account isolation actually holds -- exactly what you want
   confirmed before this database is reachable from the internet.
6. You now have two connection strings:
   - **`DATABASE_URL`** -- the **pooled** one, for Vercel's serverless
     functions.
   - **`DATABASE_ADMIN_URL`** -- the **direct** (unpooled), owner one, for
     migrations and admin scripts only. **Never set this in Vercel.** Nothing
     in the deployed app is supposed to touch it -- the one route that
     references it (`/api/invites/dev-issue`) 404s whenever
     `NODE_ENV=production`, before it would ever reach for it.

## 2. Cloudflare R2

1. Create a bucket.
2. Create an R2 API token scoped to that bucket only, with Object Read &
   Write, for `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`.
3. Set:
   ```
   S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   S3_REGION=auto
   S3_BUCKET=<your bucket name>
   ```
   Leave `S3_FORCE_PATH_STYLE` unset. The code only enables path-style
   addressing when that variable is the literal string `"true"`
   (`apps/web/src/lib/storage.ts`), which is a MinIO-only need for local dev.

## 3. Inngest

1. Sign up and create an app.
2. Set `INNGEST_SIGNING_KEY` and `INNGEST_EVENT_KEY` from the app's page on
   inngest.com. `/api/inngest` already exists and verifies incoming requests
   against the signing key; without it set, calls to that route in
   production won't be authenticated as coming from Inngest.
3. Inngest's Vercel integration auto-syncs the `/api/inngest` route on
   deploy -- no separate registration step once the env vars are set.

## 4. MapTiler

Free-tier key -> `MAPTILER_API_KEY` and `NEXT_PUBLIC_MAPTILER_API_KEY` (the
map components read the `NEXT_PUBLIC_` one client-side; it's meant to be
public -- MapTiler keys are scoped by referrer, not secrecy).

## 5. Strava

The app is already registered with Strava. Before deploying:

1. Point `STRAVA_REDIRECT_URI` at the production callback:
   `https://<your domain>/api/strava/callback`.
2. Update the authorized callback domain in Strava's app settings
   (strava.com/settings/api) to match, or the OAuth flow will fail at the
   redirect step with a domain mismatch.

## 6. Vercel

Import the repo, set every env var above plus:

- `SESSION_SECRET` and `STRAVA_TOKEN_ENCRYPTION_KEY`, both generated the way
  `.env.example` describes:
  ```sh
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```
  Losing or rotating `STRAVA_TOKEN_ENCRYPTION_KEY` makes every stored Strava
  connection undecryptable -- the only recovery is for each user to
  reconnect. Keep it somewhere durable outside Vercel's dashboard too.

Then deploy.

### Post-deploy check

Hit `GET /api/health` on the deployed URL. It checks Postgres and the R2
bucket are actually reachable with the environment's configured credentials
(not just that the process started), and returns `503` naming which
dependency failed if not:

```sh
curl https://<your domain>/api/health
```

There's no equivalent single-request check for Inngest; confirm the worker
side from Inngest's own dashboard instead.

## 7. Bootstrap your account

There's no signup UI by design. Creating an account is: mint an invite code
with the owner connection, then redeem it.

```sh
DATABASE_ADMIN_URL="<owner connection string>" node scripts/issue-invite.mjs
```

This prints a code (and its expiry). Redeem it:

```sh
curl -X POST https://<your domain>/api/invites/redeem \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "<the printed code>",
    "handle": "<your handle>",
    "email": "<your email>",
    "displayName": "<your name>",
    "password": "<at least 12 characters>"
  }'
```

Repeat `issue-invite.mjs` for anyone else you want to invite -- "someone" may
be only you for a while, but it's a repeatable command instead of hand-written
SQL each time.

## CI

`.github/workflows/ci.yml` runs on every push: lint, typecheck, the
correlation package's unit tests, the RLS isolation suite, a production
build, and the photo/social/visibility API suites against a real (ephemeral,
migrated) Postgres+PostGIS service container. It does not run
`scripts/test-trail-match.mjs` or `scripts/test-osm-names.mjs`, since both
need fixture files that are gitignored on purpose (personal photography and
GPS binaries -- see `fixtures/README.md`) and so aren't present in CI's
checkout.

## Rollback

Migrations in this repo are forward-only -- there's no scripted rollback.
For a bad deploy with no schema change, Vercel's own instant-rollback to the
previous deployment is the fastest recovery. For a bad deploy that included a
migration, the safest path is a forward-fixing migration rather than trying
to reverse one against a database that may already have real writes on it.
