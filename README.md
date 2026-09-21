# Wealth Navigator AI

**A personal financial wellness platform.** Understand where your money stands, see whether your goals are on track, test what happens if you change your saving — and get the reasoning behind every number.

Built for the AI Wealth Navigator problem statement: *people struggle to understand their financial position, explore "what-if" scenarios, and decide what to do next.*

---

## The problem

Financial tools show balances and charts. They rarely answer the questions people actually have: *Can I afford this? When will I get there? What should I change?*

Generic AI assistants answer those questions fluently and often wrongly — inventing projections, assuming interest rates, and presenting a guess with the same confidence as a fact. In personal finance a confident wrong number is worse than no number.

## The approach

**The backend calculates. The AI explains.**

Every financial figure in this product — balance, income, expenses, savings rate, goal progress, required monthly saving, projected dates, scenario impact — is computed by deterministic Python against real rows in PostgreSQL. Gemini chooses which tools to call and turns their output into plain language. It is never the source of a number.

Three properties follow from that split, and each is covered by a test:

- **One source of truth.** The dashboard, the Goals page, the what-if simulator and the AI all read the same position engine, so they cannot disagree.
- **No fabricated growth.** The projection is linear cash flow. No interest, no investment return, no inflation — stated as an assumption rather than hidden.
- **Assumptions are visible.** Every projection carries the list of things it assumed, shown in the UI, not buried in prose.

---

## The journey

```
Overview          Where do I stand?          balance, income, spending, savings
   ↓
Goals             What am I working toward?  progress, required monthly saving, on-track status
   ↓
What-if           What if I save more?       current plan vs scenario, impact, assumptions
   ↓
Next actions      What should I do?          detected spending changes priced against the goal
   ↓
Wealth AI         Explain it to me.          multi-step agent over the same deterministic tools
   ↓
Data              Show me the evidence.      the accounts, transactions and statements behind it
```

---

## Architecture

```
React 19 + Vite  ──▶  FastAPI  ──▶  Deterministic financial engine  ──▶  PostgreSQL
                                             │
                                             ▼
                                    Gemini agent (tool-calling)
                                             │
                                             ▼
                              Explanation grounded in tool output
```

The agent may only call a fixed registry of 14 backend tools. It never writes SQL, never sees a connection, and cannot request a calculation that is not on the list — `calculate_financial_metric` accepts a metric name from a closed whitelist, not an expression.

Full detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Tech stack

| Layer | Choice |
|---|---|
| Frontend | React 19, Vite 8, framer-motion, lucide-react (no CSS framework — a token-based design system in `index.css`) |
| Backend | FastAPI, Pydantic v2, psycopg2, raw parameterised SQL (no ORM) |
| Database | PostgreSQL 14+ |
| AI | Gemini via REST (`httpx`), multi-turn tool calling |
| Retrieval | Gemini embeddings, cosine similarity in Python (no pgvector dependency) |
| Tests | pytest, 130 tests against an isolated `_test` database |

---

## Local setup

**Prerequisites:** Python 3.11+, Node 20+, PostgreSQL running locally.

```bash
# 1. Clone and enter the project
cd "Insurence Insight Nexus"

# 2. Backend dependencies
python -m venv venv
venv/Scripts/python -m pip install -r backend/requirements.txt   # Windows
# source venv/bin/activate && pip install -r backend/requirements.txt   # macOS/Linux

# 3. Configuration
cp .env.example backend/.env
#    then edit backend/.env — DATABASE_URL is required, GEMINI_API_KEY is optional

# 4. Frontend dependencies
cd frontend && npm install && cd ..
```

### Database

Create an empty database; the app builds its own schema on startup.

```bash
createdb moneyops_v2
```

There are no migration files — `backend/app/engine/database.py` creates every table with
`CREATE TABLE IF NOT EXISTS` and adds columns with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`,
so starting the server against an existing database upgrades it in place without dropping data.

### Demo data

```bash
venv/Scripts/python scripts/seed_wealth_demo.py
```

Creates one synthetic profile — Alex Sharma, ₹85,000/month income, six complete months of
rent, groceries, dining, transport, utilities, subscriptions and SIP transactions, plus three
goals (Emergency Fund, Car Purchase, Japan Vacation).

The seed is:

- **Deterministic** — fixed RNG seed; two runs produce byte-identical data.
- **Idempotent** — re-running replaces the demo dataset rather than duplicating it.
- **Isolated** — every `DELETE` is scoped to the demo account or document id. It never touches
  the inherited MoneyOps / Incident Lab tables. A test parses the script's SQL and fails the
  build if an unpredicated `DELETE` or a `TRUNCATE` ever appears.

```bash
python scripts/seed_wealth_demo.py --as-of 2026-08   # pin the final month
python scripts/seed_wealth_demo.py --clear           # remove demo data, leave everything else
```

Re-run the seed at any time to reset the demo to its canonical state — including removing
goals created by hand through the UI.

### Running

```bash
# Backend  (http://127.0.0.1:8000, docs at /docs)
cd backend
PYTHONPATH=. ../venv/Scripts/python -m uvicorn app.main:app --reload --port 8000

# Frontend (http://localhost:5173)
cd frontend && npm run dev
```

On Windows, `run_project.ps1` starts PostgreSQL, the backend and the frontend together.

### AI configuration

Set `GEMINI_API_KEY` in `backend/.env` to enable the Wealth AI tab.

**Without a key the product still works.** Position, goals, scenarios and recommendations are
all deterministic and unaffected. The Wealth AI tab shows an explicit "currently unavailable"
notice and the header reads `AI: Unavailable`. No placeholder answer is ever displayed.

---

## Wealth AI

A multi-turn tool-calling loop, not a prompt wrapper. For *"How can I reach my car goal faster?"*
the agent typically runs:

```
get_financial_goals      → the goals and their derived status
get_financial_position   → balance, income, expenses, savings capacity
recommend_next_actions   → spending changes priced against that goal
simulate_savings_scenario→ the impact of acting on the best one
→ explanation, with the tools' own assumptions attached
```

Each step executes real SQL and returns real rows. The agent's response is a structured object
the UI renders as sections — position, goal progress, scenario, next actions, assumptions —
never raw JSON.

**Guardrails** (in `financial_copilot_agent.py`, asserted by tests): numbers must come from
tools; projections must be labelled as projections and carry their assumptions; the assistant
must not claim to be a regulated adviser; and it must never state an interest rate or rate of
return, because the engine models none.

---

## Testing

```bash
# Backend — 130 tests, isolated automatically onto <database>_test
cd backend && ../venv/Scripts/python -m pytest -q

# Frontend
cd frontend && npm run lint && npm run build
```

The test suite refuses to run against a database whose name does not end in `_test`, because
several fixtures delete rows during setup.

There is no committed end-to-end suite. Browser verification for this release was done with a
headless Chromium script covering all four pages, refresh behaviour, search, pagination,
responsive layout at 390px, console errors and the Incident Lab — see the QA section of the
handover notes.

---

## Deployment

The app is container-ready and targets a small AWS footprint:
frontend as static files behind CloudFront/S3 or Amplify, backend as a container on App Runner
or ECS Fargate, database on RDS PostgreSQL, secrets in Secrets Manager, logs in CloudWatch.

Dockerfiles and the full walkthrough: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## Inherited operations tooling

This product was built on an existing payment-operations platform (MoneyOps). That system is
**intact and still functional** — anomaly detection, the incident investigation agent, the Action
Governor approval workflow, case memory, the money graph, merchant memory, the Razorpay
integration and the Incident Lab synthetic-data generator are all unchanged and still tested.

It has been moved out of the product surface, not deleted. Everything is reachable under
**Platform → Operations Monitor / Investigation / Operations Data / Audit Log**. The Incident
Lab remains fully usable for synthetic-data testing.

The separation is deliberate: a personal-finance user should never meet a gateway metric or a
payment incident, but none of that engineering had to be thrown away to achieve it.

---

## Known limitations

- **Single user, no authentication.** There is no login, no per-user data partitioning, and CORS
  is permissive. Fine for a demo; not deployable to real users as-is.
- **The AI path is unverified in this environment.** No `GEMINI_API_KEY` was configured, so the
  tool registry, dispatch and response schema are tested but the model's live natural-language
  output has not been exercised.
- **No investment modelling.** Projections are linear cash flow. Risk preference changes which
  actions are recommended and how aggressively, never a projected return.
- **Goal status is per-goal optimistic.** It asks "could I reach this goal if I focused my whole
  saving capacity on it?" The combined requirement across all goals is reported alongside it so
  this cannot be misread.
- **Demo-scale data.** Six months of one synthetic account. The Data page loads up to 500 rows
  and paginates client-side; a real statement history would need server-side paging.
- **No CI pipeline.** Tests, lint and build are run manually.
- **Dependency ranges are unpinned** in `requirements.txt`, so a clean install elsewhere may
  resolve different minor versions than the ones these tests passed against.
