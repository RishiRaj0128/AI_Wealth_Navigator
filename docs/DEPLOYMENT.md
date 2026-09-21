# Deployment

The application is container-ready. This describes the intended AWS footprint and what still has to be done before a real deployment. **Nothing has been deployed** — these artifacts have been built and reviewed, not run against AWS.

---

## Target architecture

Deliberately small. Three services, one database, no orchestration layer the product does not need.

```
                    ┌──────────────────────────────┐
  Browser  ────────▶│  CloudFront  +  S3           │   React build (static)
                    └──────────────┬───────────────┘
                                   │  /api/*
                    ┌──────────────▼───────────────┐
                    │  App Runner  (or ECS Fargate)│   FastAPI container
                    └──────┬────────────────┬──────┘
                           │                │
              ┌────────────▼──────┐   ┌─────▼─────────────┐
              │ RDS PostgreSQL    │   │ Secrets Manager   │
              │ (private subnet)  │   │ DB URL, API key   │
              └───────────────────┘   └───────────────────┘
                           │
                    ┌──────▼───────┐
                    │  CloudWatch  │   logs + health alarms
                    └──────────────┘
```

**Why App Runner over ECS:** the backend is one stateless container with no sidecars and no service mesh. App Runner gives HTTPS, autoscaling and deploy-on-push without a load balancer, target group and task definition to maintain. ECS Fargate is the drop-in alternative if VPC-level control is required — the container is identical.

---

## Building the images

```bash
# Backend — context is the REPOSITORY ROOT (the image includes scripts/ for seeding)
docker build -f backend/Dockerfile -t wealth-navigator-api .

# Frontend — the API URL is baked in at build time
docker build \
  --build-arg VITE_API_BASE=https://api.your-domain.com/api \
  -t wealth-navigator-web frontend/
```

`VITE_API_BASE` matters: Vite inlines `import.meta.env` at build time, so this cannot be
supplied as a runtime environment variable. Building without it falls back to
`http://localhost:8000/api`, which is correct for local use and wrong everywhere else.

Run locally to verify the images:

```bash
docker run --rm -p 8000:8000 \
  -e DATABASE_URL="postgresql://user:pass@host:5432/moneyops_v2" \
  -e GEMINI_API_KEY="..." \
  wealth-navigator-api

docker run --rm -p 8080:80 wealth-navigator-web
```

---

## Database

RDS PostgreSQL 14+, `db.t4g.micro` is sufficient for a demo. Private subnet, no public
accessibility, security group open only to the backend service.

**No migration step is required.** `init_db()` runs on application startup and creates every
table with `CREATE TABLE IF NOT EXISTS`, adding columns with `ALTER TABLE ... ADD COLUMN IF
NOT EXISTS`. Deploying against an empty database builds the schema; deploying against an
existing one upgrades it in place without dropping data.

Seeding demo data into a deployed environment runs the same script, inside the container:

```bash
python scripts/seed_wealth_demo.py
```

It only ever writes the Wealth Navigator demo account. It cannot touch the operations tables —
a test parses the script's SQL and fails the build if an unpredicated `DELETE` or a `TRUNCATE`
appears.

---

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | From Secrets Manager. Never an environment literal in a task definition. |
| `GEMINI_API_KEY` | no | Absent ⇒ Wealth AI shows an explicit unavailable state; every deterministic feature still works. |
| `GEMINI_MODEL` | no | Defaults to the configured model. |
| `AI_PROVIDER` | no | `gemini` by default. |
| `RAZORPAY_*` | no | Only for the inherited operations screens. |

See `.env.example` for the full annotated list.

**Secrets handling.** Inject `DATABASE_URL` and `GEMINI_API_KEY` from Secrets Manager as
runtime secrets, not build arguments — a build argument is recorded in the image history. The
repository has been checked and contains no committed credentials; `.gitignore` excludes
`.env`, `.env.*` and `*.env`, and `.dockerignore` keeps them out of every build context.

---

## Health and observability

`GET /api/health` runs `SELECT 1` against PostgreSQL and reports what it observed:

```json
{
  "backend": "online",
  "database_status": "online",
  "ai": "not_configured",
  "status": "healthy"
}
```

It returns `"degraded"` with `database_status: "offline"` when the database is unreachable, so
it is a genuine health check — use it as the App Runner / ALB health path. The container's own
`HEALTHCHECK` calls the same endpoint. The response contains no secrets; a test asserts the
API key and connection string never appear in it.

Logs go to stdout and are picked up by CloudWatch automatically. Worth alarming on: health
check failures, 5xx rate, and RDS connection count — the app opens a short-lived psycopg2
connection per request and does not pool, which is the first thing that will strain under load.

---

## Before this is production-ready

Honest list. None of these are demo blockers; all are real gaps.

1. **Authentication.** There is none. No login, no per-user data partitioning — all data belongs
   to one implicit user. This is the single largest gap before real users.
2. **CORS.** `CORS_ORIGINS` includes `"*"`. Restrict it to the frontend origin.
3. **Connection pooling.** A psycopg2 connection is opened and closed per request. Fine at demo
   scale; add PgBouncer or a pool before meaningful traffic.
4. **Pin dependencies.** `requirements.txt` uses `>=` ranges, so a rebuild can resolve different
   minor versions than the ones the tests passed against. Pin them, or add a lockfile.
5. **CI/CD.** Tests, lint and build are run manually. A pipeline running `pytest`, `npm run lint`
   and `npm run build` on push, then building and pushing both images, is the natural next step.
6. **Rate limiting** on `/api/financial/copilot/ask`, which spends money per call.
7. **Backups.** Enable automated RDS snapshots and set a retention window.

---

## Rough cost

Demo-scale, `ap-south-1`, order of magnitude only:

| Service | Configuration | Monthly |
|---|---|---|
| App Runner | 1 vCPU / 2 GB, scales to zero when idle | ~$5–25 |
| RDS PostgreSQL | db.t4g.micro, 20 GB gp3 | ~$15 |
| S3 + CloudFront | static build, low traffic | ~$1–3 |
| Secrets Manager | 2 secrets | ~$1 |
| CloudWatch | basic logs | ~$1 |

Gemini API usage is billed separately and only when the Wealth AI tab is used; every other
feature makes no external calls.
