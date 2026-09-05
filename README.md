# Waypoint

Dedicated cameras take the best photographs and record the worst metadata. A mirrorless body
writes a capture timestamp and nothing else; the GPS track of the same walk lives in a watch.
Waypoint joins the two — it correlates photo capture times against a GPS track to place every
frame on the route, then builds a journal of outings and trail pages that accumulate visits
over time.

Signup is closed while the product is in beta; accounts are created from invite codes.

## Stack

| Concern | Choice |
|---|---|
| Application | Next.js (TypeScript, App Router) |
| Database | Postgres 16 + PostGIS |
| Object storage | Cloudflare R2 |
| Maps | MapLibre GL + MapTiler |
| Background jobs | Inngest |

The correlation engine is a dependency-free TypeScript library with no database or DOM
coupling, so it is unit-testable against fixtures and can later run on a native client.

## Layout

```
apps/web/            Next.js application
packages/            shared libraries (correlation engine and friends)
db/migrations/       SQL migrations, applied on first boot of the dev database
scripts/             development and verification tooling
fixtures/            GPX tracks and JPGs used by the test suite (untracked)
```

## Getting started

Requires Node 20+, Docker, and `exiftool` (`brew install exiftool`).

```sh
npm install
cp .env.example .env
npm run db:up      # Postgres 16 + PostGIS; first run builds the image (~1 min)
npm run verify     # checks the toolchain, the database, and the fixtures
npm run dev
```

`npm run verify` is the machine-checked half of the current build phase; see
[PHASE-0.md](PHASE-0.md) for the rest.
