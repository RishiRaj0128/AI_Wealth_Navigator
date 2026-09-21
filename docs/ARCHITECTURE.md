# Architecture

How Wealth Navigator AI is actually built. This documents the implementation as it exists, not an idealised design.

---

## 1. The core constraint

Every user-visible financial number is produced by Python, from rows in PostgreSQL. The LLM selects tools and writes prose. It has no database connection, no SQL, and no arithmetic authority.

```
USER
 │
 ▼
React 19 + Vite ......... presentation only — no financial arithmetic
 │  fetch()
 ▼
FastAPI ................. thin HTTP layer over the engines
 │
 ▼
Deterministic engines ... position · goals · projection · recommendations
 │  parameterised SQL
 ▼
PostgreSQL .............. the only source of financial fact
 │
 ▼
Gemini agent ............ chooses tools, reads their output, explains it
 │
 ▼
Structured answer ....... rendered as sections, never raw JSON
```

---

## 2. The engines

All four live in `backend/app/engine/financial_tools.py`. They form a dependency chain rather than four parallel implementations — this is what makes cross-screen agreement structural rather than a convention someone has to remember.

```
_compute_financial_position()          ← the one source of truth
        │
        ├──▶ _derive_goal_metrics()    ← goal status, required saving, dates
        │
        └──▶ _compute_savings_projection()
                     │
                     └──▶ recommend_next_actions()
```

### `_compute_financial_position(account_id, months=3)`

Returns current balance, average monthly income, expenses, savings and savings rate over the most recent whole months, plus the basis and assumptions.

- **Balance** is the latest reported `balance_after`. Only if no statement balance exists does it fall back to credits − debits, and it labels that fallback (`balance_method`) rather than passing an estimate off as a real balance.
- **Averages** use whole calendar months only. A partial current month would drag every average down and make month-over-month comparison meaningless.
- **Savings rate** is `None` when income is zero — never a divide-by-zero, never a fabricated `0%`.
- With no transactions it returns `has_data: false` and says so, instead of a confident set of zeroes.

### `_derive_goal_metrics(goal, monthly_savings)`

Computes `amount_remaining`, `progress_percent`, `months_remaining`, `required_monthly_saving`, `projected_completion_date`, `derived_status` and a plain-language `status_reason`.

Nothing derived is stored. A cached column would drift the moment a transaction or target changed; recomputing from `(target_amount, current_amount, target_date)` plus real capacity cannot.

Status is `ahead` (needs ≤ 80% of capacity), `on_track` (≤ 100%), `behind`, `overdue`, `completed`, or `no_deadline`. An explicit user decision (`paused`, `cancelled`) always wins over a derived one.

Edge cases handled explicitly, each with a test: target already reached; deadline in the past (the whole outstanding amount is due — no division by a negative); no target date (`required_monthly_saving` is `None`, not a fabricated figure); zero or negative saving capacity.

### `_compute_savings_projection(account_id, monthly_extra_savings, months, goal_id)`

```
projected_balance = current_balance + (baseline_savings + extra) × months
```

Strictly linear. No interest, no investment return, no inflation, no tax — a test asserts the output is exactly linear, so any compounding introduced later fails the build.

Balance and baseline come from the position engine; they are not recomputed here.

Goal impact compares the baseline timeline with the scenario timeline. Both are measured on **exact fractional months** and only then rounded for display: rounding each side up to whole months first reported a genuine three-week improvement as "0 months earlier". Completion dates are likewise built from the exact timeline, so the goal card and the simulator cannot show different dates for the same goal.

### `recommend_next_actions(account_id, goal_id, risk_preference)`

Compares the two most recent months per category and flags **discretionary** categories that rose more than 15% with at least ₹500 of monthly volume.

Only Dining, Shopping, Entertainment, Subscriptions, Travel and Other are candidates. Rent and Utilities are excluded because "trim your rent" is not an action anyone can take; Investments/SIP is excluded because it is saving, not consumption.

Goal impact is priced by calling `_compute_savings_projection` — the same engine the simulator uses. A test asserts an action's claimed months and date match the simulator's output for the same rupee amount exactly.

**Risk personalization** is deliberately minimal and deterministic. The tier changes *what* is recommended and *in what order*, never a projected number:

| Tier | Reduction | Ranking | Additional |
|---|---|---|---|
| Conservative | 25% | by size of the recent increase | emergency-buffer action first, only if balance < 3× monthly expenses |
| Moderate | 25% | by achievable saving | — |
| Aggressive | 50% | by absolute rupees freed | — |

No tier alters a return, because the engine models none.

---

## 3. The agent

`backend/app/engine/financial_copilot_agent.py` — a multi-turn REST loop against Gemini, `max_turns=10`.

```
question
   │
   ▼
Gemini ──── functionCall ────▶ FINANCIAL_TOOL_REGISTRY[name](**args)
   ▲                                      │
   └──────── functionResponse ◀───────────┘   (repeat)
   │
   ▼
final structured JSON → persisted to financial_analysis_runs → rendered as sections
```

**14 tools.** Position, goals (create/list/update), scenario, recommendations, spending summary, period comparison, duplicate and recurring detection, whitelisted metrics, and two semantic document searches. A test asserts the registry and the declarations are identical sets — a tool present in one but not the other would be invisible to the agent or crash it.

**Why the agent cannot fabricate a number:**

1. It has no database access. It emits a tool name and arguments; the backend executes.
2. Tools are parameterised SQL. Arguments are values, never fragments of a query.
3. `calculate_financial_metric` accepts a name from a four-item frozen whitelist, not an expression. Anything else is rejected before a query is built.
4. The system instruction binds each class of number to the tool that owns it, forbids stating an interest rate or rate of return, requires projections to be labelled as estimates with their assumptions attached, and requires the assistant to disclaim being a regulated adviser. Tests assert those phrases are still present so a future edit cannot quietly weaken them.

**Without an API key** the agent returns a structured `AI_NOT_CONFIGURED` error. The UI surfaces it as an explicit notice; no placeholder answer is shown, and every deterministic feature keeps working.

---

## 4. Data model

Wealth Navigator tables (PostgreSQL, created idempotently on startup by `database.py`):

| Table | Purpose |
|---|---|
| `financial_accounts` | Logical accounts |
| `financial_transactions` | Ledger rows — `transaction_type` (credit/debit), `category`, `balance_after` |
| `financial_goals` | Target amount, current amount, target date, risk preference, status |
| `financial_documents` | Uploaded statements, original bytes retained for preview |
| `financial_document_chunks` | Chunked text + embedding JSON for retrieval |
| `financial_analysis_runs` | One row per AI question — tools called, evidence, response |
| `wealth_recommendations` | Audit log of every scenario and recommendation run |

Thirteen further tables belong to the inherited operations platform (payments, orders, refunds, webhooks, incidents, investigations, governed actions, audit logs, evaluation ground truth, incident lab runs, embeddings, merchants). They are untouched by this product and are never read by a Wealth Navigator engine.

**Account scoping.** `/financial/summary` and `/financial/transactions` resolve to one account by default. Without it, the Data page listed the user's own rows mixed with rows imported from operations data, and disagreed with every other screen. `scope=all` remains available for the legacy screens.

---

## 5. Frontend

No router — `App.jsx` holds an `activeTab` string. Four product tabs (`overview`, `goals`, `copilot`, `mydata`); inherited tooling (`incidents`, `data`, `investigation`, `audit`) sits behind the header's Platform menu.

### Refresh

Previously the header's Refresh called a function that re-fetched only health, stats and incidents — data no wealth page reads — while each page loaded its own state in a mount-only `useEffect([])`. Pressing Refresh therefore did nothing visible.

Now `App` owns a `refreshToken` counter. Every page consumes it through `useRefreshableData`:

- `refreshToken` is an effect dependency, so one control refreshes whatever is on screen.
- An in-flight ref makes rapid clicks a no-op rather than stacking requests.
- A sequence number stops a slow earlier response overwriting a newer one.
- On failure the last good data is **kept** and an error is shown — a transient blip does not blank a working screen, and the UI never silently pretends the refresh succeeded.
- First load shows skeletons; a later refresh keeps the content and shows a spinner.

Incident polling is scoped to the operations tabs. A user on Overview no longer polls an incident feed every five seconds.

### Design system

Tokens are defined once at the top of `index.css`; the Wealth Navigator layer (`.wn-*`) composes them and adds nothing of its own:

| Role | Token |
|---|---|
| Accent (interaction only) | `--cc-accent` `#4C6FFF` |
| Positive (money in, on track) | `--state-verified` `#29D399` |
| Warning (behind) | `--sev-medium` `#F5C242` |
| Negative (money out, overdue) | `--sev-critical` `#FF4D5E` |
| Surfaces | `--ink-*` ramp, flat — no glow, no glassmorphism |

Spacing is a strict 4 / 8 / 12 / 16 / 24 / 32 / 48 scale. Exactly one figure per screen uses the lead size; savings rate is deliberately rendered quiet so it reads as context rather than a fifth headline. Status is always a word as well as a colour. Animations are 90–260 ms and every one is disabled under `prefers-reduced-motion`.

The whole-app background glow used to be tinted by incident severity — an unrelated payment incident literally turned the personal-finance product red. It is now the neutral accent on every product route; the severity tint survives only where it means something.

### Explainability

Three provenance tags distinguish claims that are genuinely different in kind:

- **Fact** — observed in the user's data (a reported statement balance).
- **Calculation** — deterministic arithmetic over those facts.
- **Projection** — forward-looking, valid only under stated assumptions.

Assumptions live behind a `<details>` "How this is calculated" disclosure: present on every screen that shows a derived number, but not competing with the answer itself.

---

## 6. Testing

130 backend tests. `conftest.py` rewrites `DATABASE_URL` to `<database>_test`, creates it on demand, and hard-fails before any test runs if that isolation did not take effect — several fixtures delete rows during setup.

Tests assert business behaviour, not implementation: that a surge is detected, that an action's goal impact equals the simulator's, that the projection is linear, that risk tiers change recommendations but not arithmetic, that the seed cannot touch operations data, and that the dashboard, summary, goals and scenario all quote the same balance and savings.
