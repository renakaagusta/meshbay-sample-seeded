# meshbay-sample-seeded

Meshbay fixture (MESH-154): **Node.js + Prisma + Postgres where every deploy migrates and then seeds
the database**. It is the common Railway pattern — `prisma migrate deploy && prisma db seed` in a
pre-deploy hook — and it exists to prove that repeated deploys neither duplicate reference data nor
leave a half-applied rollout behind.

```
     deploy ──► pre_deploy (new revision's image, before it starts)
                    │
                    ├─ npx prisma migrate deploy   pending migrations in prisma/migrations
                    │       │  fails ───────────────► hook exits non-zero
                    │       ▼                            │
                    ├─ npx prisma db seed          upsert 3 plans + 1 demo admin, count the run
                    │       │  FAIL_SEED=1 ─────────────┤
                    │       ▼                            ▼
                    └─ exit 0                     rollout stops, old revision keeps serving
                            │
                            ▼
                    new revision starts on :8080
                    /health · /plans · /meta · /api/items
```

## Repository layout

```
meshbay-sample-seeded
├── meshbay.toml                api service: pre_deploy migrate+seed, /health, port 8080
├── prisma
│   ├── schema.prisma           Plan, User, Item, SeedState
│   ├── migrations             0001 init tables, 0002 items.note + created_at index
│   └── seed.js                 idempotent upsert seeder, FAIL_SEED=1 exits 1
├── src
│   ├── server.js               node:http router (health, plans, meta, items CRUD)
│   └── database.js             PrismaClient
└── scripts/smoke.sh            health, seeded plans, meta, CRUD; prints OK
```

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | `200` `{"status":"ok","database":"ok"}`; `503` when Postgres is unreachable |
| GET | `/version` | `version` of the deployed revision: `v1`, `v2` or `v3-broken` |
| GET | `/plans` | JSON array of the seeded plans, `priceCents` included |
| GET | `/meta` | `lastMigration`, `lastMigrationAt`, `seedRuns`, `lastSeedAt`, `plans` |
| GET | `/api/items` (also `/items`) | JSON array of items |
| POST | `/api/items` | `{"name":"...","note":"..."}` → `201`; `note` optional |
| GET | `/api/items/{id}` | `200`, `404` when missing |
| PUT | `/api/items/{id}` | `{"name":"...","note":"..."}` → `200`, `404` when missing |
| DELETE | `/api/items/{id}` | `204`, `404` when missing |

The `/api/items` path is deliberate: `meshbay/scripts/smoke-crud.sh` drives it unchanged.

## Environment

| Variable | Used by | Required | Default | Description |
|---|---|---|---|---|
| `DATABASE_URL` | app, migrate, seed | yes | none | Postgres URL, e.g. `postgres://user:password@host:5432/app` |
| `PORT` | app | no | `8080` | Injected by Meshbay from the container port |
| `FAIL_SEED` | seed | no | empty | `1` makes the seeder exit non-zero on purpose |

`meshbay.toml` only *names* `DATABASE_URL`; the value is the project variable that points at the
Postgres database attached to the project.

## Migrations and seeding

`prisma/migrations/` holds three plain-SQL migrations:

* `20261116090000_init` — `plans`, `users`, `items` and `seed_state`.
* `20261116090100_items_note` — adds `items.note` and an index on `items.created_at`.
* `20261116100000_items_labels` — the v2 upgrade: adds the nullable `items.labels` column.
* `20261116110000_items_labels_broken` — v3-broken only: an intentionally invalid migration, so the
  rollout stops in pre-deploy and the previous revision keeps serving.`prisma migrate deploy` records each applied migration in `_prisma_migrations`, and `/meta` reports
the newest `migration_name` from that table.

`prisma/seed.js` upserts fixed reference data:

* 3 plans — `starter` (0), `growth` (2900), `scale` (9900) — keyed by `code`;
* 1 demo admin — `admin@example.com`, keyed by `email`, **with no password column at all**;
* one `seed_state` row whose `run_count` grows by one per seeder invocation.

Because every write is an upsert keyed on a natural column, redeploying leaves `/plans` at exactly 3
while `/meta` shows `seedRuns` one higher. That is the idempotency proof.

## Test scenario (what the coordinator runs on the jkt cluster)

1. Create a project from `https://github.com/renakaagusta/meshbay-sample-seeded`, branch `main`.
2. Add a **Postgres** database and attach it (Meshbay provides `DATABASE_URL`).
3. Deploy. Expected deploy log:
   * `prisma migrate deploy` applies `20261116090000_init` and `20261116090100_items_note`;
   * `seed` logs `seeded 3 plans and 1 demo admin`;
   * the new revision logs `listening on port 8080`.
4. Smoke the deployment:

   ```sh
   bash scripts/smoke.sh https://<project>-api.renakaagusta.dev
   ```

   Ends with `OK plans=3 seedRuns=1 migration=20261116090100_items_note on https://...`.
5. Redeploy `main` (no new commit needed — trigger a deploy). Expected: the log shows no migration
   applied, one seed execution, and the smoke script stays at `plans=3` while `seedRuns` becomes 2:

   ```sh
   bash scripts/smoke.sh https://<project>-api.renakaagusta.dev 2
   ```

6. CRUD is covered by the same script; the repository's `/api/items` contract is also the one
   `meshbay/scripts/smoke-crud.sh` exercises.
7. **Failure toggle.** Add the project variable `FAIL_SEED=1` and deploy. Expected:
   * `prisma migrate deploy` succeeds (or reports nothing pending);
   * `prisma db seed` fails with `FAIL_SEED=1: refusing to seed (failure simulation)` and the deploy
     is marked failed;
   * the previous revision keeps serving: the smoke script against the same URL is still green and
     `/meta` reports the same `seedRuns` as before the failed deploy.
   * Remove `FAIL_SEED` (or set it to anything but `1`) and deploy again to recover.

## Run locally

`prisma validate` only needs `DATABASE_URL` to be *set*, not reachable:

```sh
npm install
DATABASE_URL=postgres://user:password@localhost:5432/app npx prisma validate
npm run check
```

The full flow needs a reachable Postgres:

```sh
DATABASE_URL=postgres://postgres:postgres@localhost:5432/app npx prisma migrate deploy
DATABASE_URL=postgres://postgres:postgres@localhost:5432/app npx prisma db seed
DATABASE_URL=postgres://postgres:postgres@localhost:5432/app PORT=8080 node src/server.js
bash scripts/smoke.sh http://localhost:8080
```

`FAIL_SEED=1 npx prisma db seed` exits 1 without touching the database.

## Upgrade and rollback branches

`main` stays the stable fixture. Three branches off it exist for the MESH-160
upgrade/rollback scenario (`meshbay/scripts/scenarios/upgrade-rollback.sh`):

| Branch | `/version` | Migration | Purpose |
|---|---|---|---|
| `v1` | `v1` | none beyond `main` | the revision to upgrade from and roll back to |
| `v2` | `v2` | `20261116100000_items_labels` adds the nullable `items.labels` column | the compatible upgrade |
| `v3-broken` | `v3-broken` | `20261116110000_items_labels_broken` is deliberately invalid SQL | the upgrade whose rollout must stop |

Both `v1` and `v2` ship `scripts/pre-deploy.sh` as their pre-deploy hook. It
marks the broken `v3-broken` migration as rolled back when a previous rollout
left it failed, so a failed experiment does not block every later deploy with
Prisma's P3009 guard; it then runs `prisma migrate deploy` and `prisma db seed`
exactly like `main` did inline.

`v2` only adds a nullable column, so `v1` data stays readable after the upgrade
and after a rollback. `/version` is hardcoded per branch: the image, not the
database, decides what reports `v1` or `v2`.

## Notes and known Meshbay gaps

* `prisma` is a **production** dependency, not a dev one: `pre_deploy` runs inside the runtime image,
  after Railpack has pruned dev dependencies, so the CLI must survive the prune.
* `pre_deploy` semantics (once per deploy or once per replica) are still undocumented in Meshbay.
  This sample is safe either way: migrations are ordered and locked by Prisma, seeding is upsert-only,
  and `run_count` simply counts the invocations.
* A seeder failure is not transactional across rows. A mid-run crash can leave some plans written;
  the next deploy's upsert converges them, which is the point of the fixture.
* `meshbay.toml` cannot reference the project's database, so `DATABASE_URL` must be a project variable
  even though the service only names it.
