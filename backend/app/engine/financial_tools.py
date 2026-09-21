"""
backend/app/engine/financial_tools.py

Authoritative, backend-executed tools for the Financial Copilot Gemini agent.
Every tool is strictly parameterized and executes real parameterized SQL or
in-process cosine-similarity retrieval against PostgreSQL — Gemini selects a
tool and arguments, but never writes, sees, or executes SQL itself. This is
the concrete enforcement of "Gemini must never execute arbitrary SQL":
calculate_financial_metric in particular only accepts a name from a closed
whitelist, not a free-form expression.
"""

import json
import math
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from app.engine.database import get_db_connection
from app.engine.embeddings import generate_embedding, cosine_similarity

_ALLOWED_METRICS = {"total_spend", "average_transaction", "largest_expense", "transaction_count"}


def _date_filter_clauses(col: str, start_date: Optional[str], end_date: Optional[str], params: list) -> List[str]:
    """Returns zero or more bare condition fragments (no leading AND) for the
    caller to append to its own clause list before joining with " AND ".
    Casts both sides to a bare date so a date-only filter (e.g. '2026-08-10')
    matches the whole calendar day regardless of the TIMESTAMPTZ column's
    stored time-of-day/timezone — a plain '<=' comparison against a date
    string is timezone-sensitive and can silently exclude same-day rows."""
    clauses = []
    if start_date:
        clauses.append(f"{col}::date >= %s::date")
        params.append(start_date)
    if end_date:
        clauses.append(f"{col}::date <= %s::date")
        params.append(end_date)
    return clauses


# Months of history averaged to establish the income/expense/savings baseline.
# Three is the shortest window that smooths a one-off month without reaching so
# far back that a recent, real change in behaviour gets averaged away.
BASELINE_MONTHS = 3

# Average days per month (365.25 / 12). Used consistently everywhere a month
# count is converted to a date so two code paths can never disagree by a day.
DAYS_PER_MONTH = 30.4375

# Deterministic risk personalization. This is a PLANNING-PRIORITY model, not an
# investment model: no tier changes any projected return, because the engine
# models no returns at all. A tier only changes (a) how aggressively spending
# reductions are proposed and (b) which opportunity is ranked first.
RISK_PROFILES = {
    "conservative": {
        "trim_pct": 0.25,
        "label": "Conservative",
        "priority": "stability",
        "summary": "Prioritises a cash buffer and predictable goal funding over acceleration.",
        "scenario_ladder": [2000, 5000, 7500],
    },
    "moderate": {
        "trim_pct": 0.25,
        "label": "Moderate",
        "priority": "balanced",
        "summary": "Balances steady saving with controlled trimming of discretionary spending.",
        "scenario_ladder": [5000, 10000, 15000],
    },
    "aggressive": {
        "trim_pct": 0.50,
        "label": "Aggressive",
        "priority": "acceleration",
        "summary": "Prioritises reaching goals sooner by proposing larger discretionary cuts.",
        "scenario_ladder": [10000, 15000, 25000],
    },
}

# Categories treated as discretionary — the only ones a spending-reduction
# action is ever proposed against. Rent, utilities and salary are excluded
# because recommending someone "trim" their rent is not actionable advice.
DISCRETIONARY_CATEGORIES = {
    "dining", "shopping", "entertainment", "subscriptions", "travel", "other", "uncategorized"
}

# Categories that represent money moving into savings rather than being
# consumed, so they are never proposed as something to cut.
SAVINGS_CATEGORIES = {"investments", "savings", "sip"}


def _inr(value: Optional[float]) -> str:
    """Formats a rupee amount for human-readable text, rounding HALF-UP.

    Python's f-string `:,.0f` uses banker's rounding, so 32680.5 renders as
    "32,680" while the browser's Number.toLocaleString renders the same value
    as "32,681". That produced a visible one-rupee disagreement between a
    sentence generated here and the figure shown beside it. Both sides now
    round the same way.
    """
    if value is None:
        return "—"
    rounded = math.floor(float(value) + 0.5) if value >= 0 else -math.floor(-float(value) + 0.5)
    return f"₹{rounded:,}"


def _normalise_risk(risk_preference: Optional[str]) -> str:
    r = (risk_preference or "moderate").strip().lower()
    return r if r in RISK_PROFILES else "moderate"


def _resolve_account_id(c, account_id: Optional[str]) -> Optional[str]:
    """Falls back to the most recently created account when the caller did not
    name one. Centralised so the position, projection and recommendation paths
    can never silently resolve to different accounts for the same request."""
    if account_id:
        return account_id
    c.execute("SELECT account_id FROM financial_accounts ORDER BY created_at DESC LIMIT 1;")
    row = c.fetchone()
    return row["account_id"] if row else None


def _compute_financial_position(account_id: Optional[str] = None, months: int = BASELINE_MONTHS) -> Dict[str, Any]:
    """Authoritative financial-position engine: current balance, and average
    monthly income / expenses / savings over the most recent `months` of real
    transactions.

    This is the single source of truth for every one of those numbers. The
    projection engine and the recommendation engine both read it rather than
    recomputing, which is what guarantees the balance quoted on the dashboard
    is the same balance a what-if scenario projects forward from.
    """
    months = max(1, int(months or BASELINE_MONTHS))

    conn = get_db_connection()
    c = conn.cursor()
    resolved_account_id = _resolve_account_id(c, account_id)

    clauses = ["1=1"]
    params: list = []
    if resolved_account_id:
        clauses.append("account_id = %s")
        params.append(resolved_account_id)
    where = " AND ".join(clauses)

    # 1. Current balance. The reported statement balance is authoritative when
    # present; the net sum of credits minus debits is a clearly-labelled
    # fallback, never silently presented as if it were a real balance.
    c.execute(f"""
        SELECT balance_after, transaction_date
        FROM financial_transactions
        WHERE {where} AND balance_after IS NOT NULL
        ORDER BY transaction_date DESC, transaction_id DESC LIMIT 1;
    """, tuple(params))
    latest_bal_row = c.fetchone()

    balance_as_of = None
    if latest_bal_row and latest_bal_row["balance_after"] is not None:
        current_balance = float(latest_bal_row["balance_after"])
        balance_method = "statement_balance"
        td = latest_bal_row["transaction_date"]
        balance_as_of = td.strftime("%Y-%m-%d") if hasattr(td, "strftime") else str(td)
        balance_assumption = (
            f"Current balance is the latest reported statement balance of "
            f"₹{current_balance:,.2f} (as of {balance_as_of})."
        )
    else:
        c.execute(f"""
            SELECT COALESCE(SUM(CASE WHEN transaction_type = 'credit' THEN amount ELSE -amount END), 0) as net_balance
            FROM financial_transactions WHERE {where};
        """, tuple(params))
        net_row = c.fetchone()
        current_balance = float(net_row["net_balance"]) if net_row else 0.0
        balance_method = "net_transaction_sum"
        balance_assumption = (
            f"Current balance is estimated from net transaction history "
            f"(credits minus debits: ₹{current_balance:,.2f}) because no statement "
            f"balance was recorded on these transactions."
        )

    # 2. Monthly income / expenses / savings, averaged over whole months only.
    c.execute(f"""
        SELECT TO_CHAR(transaction_date, 'YYYY-MM') as ym,
               COALESCE(SUM(CASE WHEN transaction_type = 'credit' THEN amount ELSE 0 END), 0) as credits,
               COALESCE(SUM(CASE WHEN transaction_type = 'debit' THEN amount ELSE 0 END), 0) as debits
        FROM financial_transactions
        WHERE {where}
        GROUP BY ym ORDER BY ym DESC LIMIT %s;
    """, tuple(params) + (months,))
    month_rows = [dict(r) for r in c.fetchall()]
    c.close()
    conn.close()

    n_months = len(month_rows)
    if n_months == 0:
        return {
            "account_id": resolved_account_id,
            "has_data": False,
            "current_balance": current_balance,
            "balance_method": balance_method,
            "balance_as_of": balance_as_of,
            "monthly_income": 0.0,
            "monthly_expenses": 0.0,
            "monthly_savings": 0.0,
            "savings_rate_pct": None,
            "months_analyzed": 0,
            "months_used": [],
            "basis": "No transaction history is available for this account.",
            "assumptions": [
                balance_assumption,
                "No monthly income, expense or savings figures could be calculated: "
                "this account has no transactions yet.",
            ],
        }

    monthly_income = round(sum(float(r["credits"]) for r in month_rows) / n_months, 2)
    monthly_expenses = round(sum(float(r["debits"]) for r in month_rows) / n_months, 2)
    monthly_savings = round(monthly_income - monthly_expenses, 2)
    savings_rate_pct = round((monthly_savings / monthly_income) * 100, 1) if monthly_income > 0 else None

    month_labels = [datetime.strptime(r["ym"], "%Y-%m").strftime("%b %Y") for r in reversed(month_rows)]
    basis = (
        f"Averaged over the last {n_months} month(s) of recorded transactions "
        f"({', '.join(month_labels)})."
    )

    assumptions = [balance_assumption, basis]
    if n_months < months:
        assumptions.append(
            f"Only {n_months} month(s) of history are available (requested {months}); "
            f"these figures are an early estimate and will sharpen as more statements are added."
        )
    if monthly_savings < 0:
        assumptions.append(
            "Average monthly spending currently exceeds average monthly income, so the "
            "baseline monthly saving is negative."
        )

    return {
        "account_id": resolved_account_id,
        "has_data": True,
        "current_balance": current_balance,
        "balance_method": balance_method,
        "balance_as_of": balance_as_of,
        "monthly_income": monthly_income,
        "monthly_expenses": monthly_expenses,
        "monthly_savings": monthly_savings,
        "savings_rate_pct": savings_rate_pct,
        "months_analyzed": n_months,
        "months_used": month_labels,
        "basis": basis,
        "assumptions": assumptions,
    }


def _months_between(start_date, end_date) -> Optional[float]:
    """Whole-day difference expressed in months. Returns None if either side is
    missing so callers must handle 'no deadline' explicitly rather than
    silently treating it as zero."""
    if not start_date or not end_date:
        return None
    return (end_date - start_date).days / DAYS_PER_MONTH


def _derive_goal_metrics(goal: Dict[str, Any], monthly_savings: float, today=None) -> Dict[str, Any]:
    """Computes every derived goal figure deterministically in the backend.

    Nothing here is stored on the row: amount remaining, progress, months
    remaining, required monthly saving and status are all recalculated from
    (target_amount, current_amount, target_date) plus the account's real
    monthly saving capacity, so they can never drift out of sync with the
    underlying values the way a cached column would.

    The LLM never decides any of this — it only explains what this returns.
    """
    today = today or datetime.now(timezone.utc).date()

    try:
        target_amount = float(goal.get("target_amount") or 0.0)
    except (TypeError, ValueError):
        target_amount = 0.0
    try:
        current_amount = float(goal.get("current_amount") or 0.0)
    except (TypeError, ValueError):
        current_amount = 0.0

    amount_remaining = round(max(0.0, target_amount - current_amount), 2)
    progress_percent = round(min(100.0, max(0.0, (current_amount / target_amount) * 100)), 1) if target_amount > 0 else 0.0

    # Parse the target date defensively: it may be a date, a string, or absent.
    raw_date = goal.get("target_date")
    target_date = None
    if raw_date:
        if isinstance(raw_date, str):
            try:
                target_date = datetime.strptime(raw_date[:10], "%Y-%m-%d").date()
            except ValueError:
                target_date = None
        elif isinstance(raw_date, datetime):
            target_date = raw_date.date()
        else:
            target_date = raw_date

    raw_months = _months_between(today, target_date)
    months_remaining = round(raw_months, 1) if raw_months is not None else None

    stored_status = (goal.get("status") or "active").lower()
    available = float(monthly_savings or 0.0)

    required_monthly_saving = None
    projected_completion_date = None
    months_to_goal_at_current_rate = None
    status = "active"
    status_reason = ""

    if stored_status in ("completed", "cancelled", "paused"):
        # An explicit user decision always wins over a derived judgement.
        status = stored_status
        status_reason = f"Goal is marked '{stored_status}'."
        if stored_status == "completed":
            required_monthly_saving = 0.0

    elif amount_remaining <= 0:
        status = "completed"
        status_reason = "The target amount has already been reached."
        required_monthly_saving = 0.0
        months_to_goal_at_current_rate = 0

    elif months_remaining is None:
        # No deadline: a required monthly amount is undefined, but a completion
        # date at the current saving rate is still meaningful.
        if available > 0:
            exact_months = amount_remaining / available
            months_to_goal_at_current_rate = math.ceil(exact_months)
            # Date from the EXACT timeline, not the ceiled month count, so this
            # matches the date _compute_savings_projection reports for the same
            # goal at the same rate.
            projected_completion_date = (today + timedelta(days=DAYS_PER_MONTH * exact_months)).isoformat()
            status = "no_deadline"
            status_reason = (
                f"No target date is set. At the current saving rate of {_inr(available)}/month "
                f"this goal would be reached in about {months_to_goal_at_current_rate} month(s)."
            )
        else:
            status = "at_risk"
            status_reason = (
                "No target date is set and the current monthly saving rate is not positive, "
                "so no completion date can be projected."
            )

    elif months_remaining <= 0:
        # Deadline has passed with money still outstanding.
        status = "overdue"
        required_monthly_saving = amount_remaining
        status_reason = (
            f"The target date has passed with {_inr(amount_remaining)} still outstanding."
        )
        if available > 0:
            exact_months = amount_remaining / available
            months_to_goal_at_current_rate = math.ceil(exact_months)
            projected_completion_date = (today + timedelta(days=DAYS_PER_MONTH * exact_months)).isoformat()

    else:
        # The normal case. months_remaining is strictly positive here, so this
        # division cannot raise.
        required_monthly_saving = round(amount_remaining / months_remaining, 2)
        if available > 0:
            exact_months = amount_remaining / available
            months_to_goal_at_current_rate = math.ceil(exact_months)
            projected_completion_date = (today + timedelta(days=DAYS_PER_MONTH * exact_months)).isoformat()
            ratio = required_monthly_saving / available
            if ratio <= 0.8:
                status = "ahead"
                status_reason = (
                    f"Needs {_inr(required_monthly_saving)}/month and {_inr(available)}/month is "
                    f"currently being saved — comfortably ahead of schedule."
                )
            elif ratio <= 1.0:
                status = "on_track"
                status_reason = (
                    f"Needs {_inr(required_monthly_saving)}/month and {_inr(available)}/month is "
                    f"currently being saved — on track."
                )
            else:
                status = "behind"
                shortfall = round(required_monthly_saving - available, 2)
                status_reason = (
                    f"Needs {_inr(required_monthly_saving)}/month but only {_inr(available)}/month is "
                    f"currently being saved — a shortfall of {_inr(shortfall)}/month."
                )
        else:
            status = "behind"
            status_reason = (
                f"Needs {_inr(required_monthly_saving)}/month but the current monthly saving rate "
                f"is not positive."
            )

    return {
        "target_amount": round(target_amount, 2),
        "current_amount": round(current_amount, 2),
        "amount_remaining": amount_remaining,
        "progress_percent": progress_percent,
        "months_remaining": months_remaining,
        "required_monthly_saving": required_monthly_saving,
        "months_to_goal_at_current_rate": months_to_goal_at_current_rate,
        "projected_completion_date": projected_completion_date,
        "derived_status": status,
        "status_reason": status_reason,
        "monthly_savings_basis": round(available, 2),
        "risk_preference": _normalise_risk(goal.get("risk_preference")),
    }


class FinancialTools:

    @staticmethod
    def get_financial_position(account_id: Optional[str] = None, months: int = BASELINE_MONTHS) -> Dict[str, Any]:
        """Returns the user's deterministic financial position: current balance,
        average monthly income, expenses, savings and savings rate, with the
        calculation basis and assumptions stated explicitly."""
        return _compute_financial_position(account_id=account_id, months=months)

    @staticmethod
    def search_financial_documents(query: str, document_type: Optional[str] = None, limit: int = 5) -> Dict[str, Any]:
        """Semantic search over uploaded financial document chunks (real embeddings, cosine-ranked)."""
        if not query:
            return {"error": "Missing query parameter"}
        limit = min(max(1, limit), 20)

        query_vec = generate_embedding(query)
        if query_vec is None:
            return {"error": "Embedding generation is unavailable (Gemini not configured or request failed)."}

        conn = get_db_connection()
        c = conn.cursor()
        if document_type:
            c.execute("""
                SELECT ch.chunk_id, ch.content, ch.embedding_json, ch.page_number, ch.section,
                       d.document_id, d.filename, d.document_type
                FROM financial_document_chunks ch
                JOIN financial_documents d ON d.document_id = ch.document_id
                WHERE ch.embedding_json IS NOT NULL AND d.document_type = %s;
            """, (document_type,))
        else:
            c.execute("""
                SELECT ch.chunk_id, ch.content, ch.embedding_json, ch.page_number, ch.section,
                       d.document_id, d.filename, d.document_type
                FROM financial_document_chunks ch
                JOIN financial_documents d ON d.document_id = ch.document_id
                WHERE ch.embedding_json IS NOT NULL;
            """)
        rows = c.fetchall()
        c.close()
        conn.close()

        scored = []
        for r in rows:
            row = dict(r)
            try:
                vec = json.loads(row["embedding_json"])
            except Exception:
                continue
            score = cosine_similarity(query_vec, vec)
            scored.append({
                "chunk_id": row["chunk_id"],
                "content": row["content"],
                "page_number": row["page_number"],
                "section": row["section"],
                "document_id": row["document_id"],
                "filename": row["filename"],
                "document_type": row["document_type"],
                "similarity_score": round(score, 4)
            })
        scored.sort(key=lambda x: x["similarity_score"], reverse=True)
        return {"query": query, "results_returned": len(scored[:limit]), "results": scored[:limit]}

    @staticmethod
    def search_financial_policy(query: str, limit: int = 5) -> Dict[str, Any]:
        """Semantic search restricted to uploaded fee-policy documents."""
        return FinancialTools.search_financial_documents(query, document_type="fee_policy", limit=limit)

    @staticmethod
    def get_transactions(
        account_id: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        merchant: Optional[str] = None,
        category: Optional[str] = None,
        min_amount: Optional[float] = None,
        max_amount: Optional[float] = None,
        limit: int = 50
    ) -> Dict[str, Any]:
        """Retrieves persisted financial transactions with optional filters. Parameterized SQL only."""
        limit = min(max(1, limit), 200)
        clauses = ["1=1"]
        params: list = []

        if account_id:
            clauses.append("account_id = %s")
            params.append(account_id)
        if merchant:
            clauses.append("merchant ILIKE %s")
            params.append(f"%{merchant}%")
        if category:
            clauses.append("category = %s")
            params.append(category)
        if min_amount is not None:
            clauses.append("amount >= %s")
            params.append(min_amount)
        if max_amount is not None:
            clauses.append("amount <= %s")
            params.append(max_amount)
        clauses.extend(_date_filter_clauses("transaction_date", start_date, end_date, params))

        query = f"SELECT * FROM financial_transactions WHERE {' AND '.join(clauses)} ORDER BY transaction_date DESC LIMIT %s;"
        params.append(limit)

        conn = get_db_connection()
        c = conn.cursor()
        c.execute(query, tuple(params))
        rows = [dict(r) for r in c.fetchall()]
        c.close()
        conn.close()
        return {"transactions_returned": len(rows), "transactions": rows}

    @staticmethod
    def get_transaction_details(transaction_id: str) -> Dict[str, Any]:
        """Retrieves a single transaction, its source document, and a best-effort match against
        an existing MoneyOps incident on the same merchant name (for cross-linking to Investigation)."""
        if not transaction_id:
            return {"error": "Missing transaction_id parameter"}

        conn = get_db_connection()
        c = conn.cursor()
        c.execute("SELECT * FROM financial_transactions WHERE transaction_id = %s;", (transaction_id,))
        tx = c.fetchone()
        if not tx:
            c.close()
            conn.close()
            return {"error": f"Transaction '{transaction_id}' not found"}
        tx = dict(tx)

        document = None
        if tx.get("document_id"):
            c.execute("SELECT document_id, filename, document_type FROM financial_documents WHERE document_id = %s;", (tx["document_id"],))
            doc_row = c.fetchone()
            if doc_row:
                document = dict(doc_row)

        matched_incident = None
        if tx.get("merchant"):
            c.execute("""
                SELECT incident_id, title, type, status, target_entity_id
                FROM incidents WHERE target_entity_id ILIKE %s ORDER BY detected_at DESC LIMIT 1;
            """, (f"%{tx['merchant']}%",))
            inc_row = c.fetchone()
            if inc_row:
                matched_incident = dict(inc_row)

        c.close()
        conn.close()
        return {"transaction": tx, "document": document, "matched_incident": matched_incident}

    @staticmethod
    def get_spending_summary(
        account_id: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        group_by: str = "category"
    ) -> Dict[str, Any]:
        """SQL aggregation of spend, grouped by category or merchant."""
        group_col = "category" if group_by not in ("category", "merchant") else group_by
        clauses = ["transaction_type = 'debit'"]
        params: list = []
        if account_id:
            clauses.append("account_id = %s")
            params.append(account_id)
        clauses.extend(_date_filter_clauses("transaction_date", start_date, end_date, params))

        query = f"""
            SELECT COALESCE({group_col}, 'uncategorized') as group_key, SUM(amount) as total, COUNT(*) as txn_count
            FROM financial_transactions WHERE {' AND '.join(clauses)}
            GROUP BY group_key ORDER BY total DESC;
        """
        conn = get_db_connection()
        c = conn.cursor()
        c.execute(query, tuple(params))
        rows = [dict(r) for r in c.fetchall()]
        c.execute(f"SELECT COALESCE(SUM(amount),0) as total_spend, COUNT(*) as total_txns FROM financial_transactions WHERE {' AND '.join(clauses)};", tuple(params))
        totals = dict(c.fetchone())
        c.close()
        conn.close()
        return {"group_by": group_col, "breakdown": rows, "total_spend": float(totals["total_spend"]), "total_transactions": totals["total_txns"]}

    @staticmethod
    def compare_periods(
        account_id: Optional[str],
        period_a_start: str,
        period_a_end: str,
        period_b_start: str,
        period_b_end: str
    ) -> Dict[str, Any]:
        """Deterministic two-period spend comparison. All arithmetic performed here, not by Gemini."""
        if not (period_a_start and period_a_end and period_b_start and period_b_end):
            return {"error": "period_a_start, period_a_end, period_b_start, period_b_end are all required"}

        def _period_summary(start: str, end: str) -> Dict[str, Any]:
            clauses = ["transaction_type = 'debit'", "transaction_date::date >= %s::date", "transaction_date::date <= %s::date"]
            params: list = [start, end]
            if account_id:
                clauses.append("account_id = %s")
                params.append(account_id)
            conn = get_db_connection()
            c = conn.cursor()
            c.execute(f"SELECT COALESCE(SUM(amount),0) as total, COUNT(*) as cnt FROM financial_transactions WHERE {' AND '.join(clauses)};", tuple(params))
            totals = dict(c.fetchone())
            c.execute(f"""
                SELECT COALESCE(category, 'uncategorized') as group_key, SUM(amount) as total
                FROM financial_transactions WHERE {' AND '.join(clauses)}
                GROUP BY group_key ORDER BY total DESC LIMIT 10;
            """, tuple(params))
            breakdown = [dict(r) for r in c.fetchall()]
            c.close()
            conn.close()
            return {"total_spend": float(totals["total"]), "transaction_count": totals["cnt"], "breakdown": breakdown}

        period_a = _period_summary(period_a_start, period_a_end)
        period_b = _period_summary(period_b_start, period_b_end)
        delta = round(period_b["total_spend"] - period_a["total_spend"], 2)
        pct_change = round((delta / period_a["total_spend"]) * 100, 2) if period_a["total_spend"] > 0 else None

        return {
            "period_a": {"start": period_a_start, "end": period_a_end, **period_a},
            "period_b": {"start": period_b_start, "end": period_b_end, **period_b},
            "delta_inr": delta,
            "percent_change": pct_change
        }

    @staticmethod
    def find_duplicate_transactions(account_id: Optional[str] = None, amount_tolerance: float = 0.01, date_window_days: int = 3) -> Dict[str, Any]:
        """SQL self-join: same merchant + amount within a date window — a real duplicate-charge signature."""
        clauses = ["a.transaction_id < b.transaction_id", "a.merchant = b.merchant",
                   "ABS(a.amount - b.amount) <= %s",
                   "ABS(EXTRACT(EPOCH FROM (a.transaction_date - b.transaction_date))) <= %s"]
        params: list = [amount_tolerance, date_window_days * 86400]
        if account_id:
            clauses.append("a.account_id = %s AND b.account_id = %s")
            params.extend([account_id, account_id])

        query = f"""
            SELECT a.transaction_id as txn_a, b.transaction_id as txn_b, a.merchant, a.amount,
                   a.transaction_date as date_a, b.transaction_date as date_b
            FROM financial_transactions a
            JOIN financial_transactions b ON {' AND '.join(clauses)}
            WHERE a.merchant IS NOT NULL
            ORDER BY a.transaction_date DESC LIMIT 100;
        """
        conn = get_db_connection()
        c = conn.cursor()
        c.execute(query, tuple(params))
        rows = [dict(r) for r in c.fetchall()]
        c.close()
        conn.close()
        return {"duplicate_pairs_found": len(rows), "duplicates": rows}

    @staticmethod
    def find_recurring_transactions(account_id: Optional[str] = None, min_occurrences: int = 3) -> Dict[str, Any]:
        """SQL grouping by merchant + rounded amount, counting occurrences — a real recurring-payment signature."""
        clauses = ["merchant IS NOT NULL"]
        params: list = []
        if account_id:
            clauses.append("account_id = %s")
            params.append(account_id)

        query = f"""
            SELECT merchant, ROUND(amount::numeric, 2) as rounded_amount, COUNT(*) as occurrences,
                   MIN(transaction_date) as first_seen, MAX(transaction_date) as last_seen
            FROM financial_transactions WHERE {' AND '.join(clauses)}
            GROUP BY merchant, rounded_amount
            HAVING COUNT(*) >= %s
            ORDER BY occurrences DESC;
        """
        params.append(min_occurrences)
        conn = get_db_connection()
        c = conn.cursor()
        c.execute(query, tuple(params))
        rows = [dict(r) for r in c.fetchall()]
        c.close()
        conn.close()
        return {"recurring_patterns_found": len(rows), "recurring": rows}

    @staticmethod
    def calculate_financial_metric(metric: str, account_id: Optional[str] = None, start_date: Optional[str] = None, end_date: Optional[str] = None) -> Dict[str, Any]:
        """Computes one whitelisted deterministic metric. Rejects any metric name not on the
        whitelist rather than falling through to arbitrary computation — this is the boundary
        that keeps Gemini from ever specifying its own SQL/calculation."""
        if metric not in _ALLOWED_METRICS:
            return {"error": f"Unknown metric '{metric}'. Allowed: {sorted(_ALLOWED_METRICS)}"}

        clauses = ["transaction_type = 'debit'"]
        params: list = []
        if account_id:
            clauses.append("account_id = %s")
            params.append(account_id)
        clauses.extend(_date_filter_clauses("transaction_date", start_date, end_date, params))
        where = " AND ".join(clauses)

        conn = get_db_connection()
        c = conn.cursor()
        if metric == "total_spend":
            c.execute(f"SELECT COALESCE(SUM(amount),0) as value FROM financial_transactions WHERE {where};", tuple(params))
            value = float(c.fetchone()["value"])
        elif metric == "average_transaction":
            c.execute(f"SELECT COALESCE(AVG(amount),0) as value FROM financial_transactions WHERE {where};", tuple(params))
            value = round(float(c.fetchone()["value"]), 2)
        elif metric == "largest_expense":
            c.execute(f"SELECT merchant, amount, transaction_date FROM financial_transactions WHERE {where} ORDER BY amount DESC LIMIT 1;", tuple(params))
            row = c.fetchone()
            c.close()
            conn.close()
            return {"metric": metric, "result": dict(row) if row else None}
        elif metric == "transaction_count":
            c.execute(f"SELECT COUNT(*) as value FROM financial_transactions WHERE {where};", tuple(params))
            value = c.fetchone()["value"]
        c.close()
        conn.close()
        return {"metric": metric, "value": value}

    @staticmethod
    def create_financial_goal(
        account_id: Optional[str],
        goal_name: str,
        target_amount: float,
        target_date: Optional[str] = None,
        risk_preference: str = "moderate"
    ) -> Dict[str, Any]:
        """Creates a new financial goal row in PostgreSQL."""
        if not goal_name or not goal_name.strip():
            return {"error": "goal_name is required"}
        try:
            target_amount = float(target_amount)
            if target_amount <= 0:
                return {"error": "target_amount must be greater than zero"}
        except (ValueError, TypeError):
            return {"error": "target_amount must be a valid positive number"}

        if risk_preference not in ("conservative", "moderate", "aggressive"):
            risk_preference = "moderate"

        goal_id = f"fgoal_{uuid.uuid4().hex[:10]}"
        now_str = datetime.now(timezone.utc).isoformat()

        conn = get_db_connection()
        c = conn.cursor()
        c.execute("""
            INSERT INTO financial_goals (goal_id, account_id, goal_name, target_amount, current_amount, target_date, risk_preference, status, created_at)
            VALUES (%s, %s, %s, %s, 0, %s, %s, 'active', %s)
            RETURNING *;
        """, (goal_id, account_id or None, goal_name.strip(), target_amount, target_date or None, risk_preference, now_str))
        row = dict(c.fetchone())
        conn.commit()
        c.close()
        conn.close()
        if row.get("target_date"):
            row["target_date"] = str(row["target_date"])
        if row.get("created_at"):
            row["created_at"] = str(row["created_at"])
        return {"status": "created", "goal": row}

    @staticmethod
    def get_financial_goals(
        account_id: Optional[str] = None,
        status: Optional[str] = "active"
    ) -> Dict[str, Any]:
        """Lists financial goals with optional filters, each enriched with
        backend-derived metrics: amount remaining, progress %, months remaining,
        required monthly saving, projected completion date and an on-track /
        behind / ahead / completed / overdue status.

        Those values are computed here rather than stored on the row, so they
        cannot go stale, and they are computed by this function rather than by
        the model, so the AI can never decide whether a goal is on track."""
        clauses = ["1=1"]
        params: list = []
        if account_id:
            clauses.append("account_id = %s")
            params.append(account_id)
        if status and status != "all":
            clauses.append("status = %s")
            params.append(status)

        query = f"SELECT * FROM financial_goals WHERE {' AND '.join(clauses)} ORDER BY created_at DESC;"
        conn = get_db_connection()
        c = conn.cursor()
        c.execute(query, tuple(params))
        raw_rows = [dict(r) for r in c.fetchall()]
        c.close()
        conn.close()

        # One position lookup for the whole list rather than one per goal.
        position = _compute_financial_position(account_id=account_id)
        monthly_savings = position["monthly_savings"]

        rows = []
        for d in raw_rows:
            derived = _derive_goal_metrics(d, monthly_savings)
            if d.get("target_date"):
                d["target_date"] = str(d["target_date"])
            if d.get("created_at"):
                d["created_at"] = str(d["created_at"])
            d.update(derived)
            rows.append(d)

        # Portfolio view. Per-goal status asks "could I hit this goal if I
        # focused my whole saving capacity on it?", which is optimistic when
        # several goals compete for the same rupees. Reporting the combined
        # requirement alongside it keeps that from reading as a promise that
        # every goal is simultaneously on track.
        active = [g for g in rows if g["derived_status"] not in ("completed", "cancelled", "paused")]
        total_required = round(sum(g["required_monthly_saving"] or 0.0 for g in active), 2)
        all_goals_affordable = total_required <= monthly_savings if active else True
        combined_shortfall = round(max(0.0, total_required - monthly_savings), 2)

        return {
            "goals_returned": len(rows),
            "goals": rows,
            "monthly_savings_basis": monthly_savings,
            "total_required_monthly_saving": total_required,
            "all_goals_affordable": all_goals_affordable,
            "combined_monthly_shortfall": combined_shortfall,
            "basis": position["basis"],
            "assumptions": [
                position["basis"],
                "Each goal's status compares the monthly amount it still needs against the "
                "account's current average monthly saving, assuming the full saving capacity "
                "could be directed at that one goal.",
                (f"Funding every active goal at once would need {_inr(total_required)}/month against "
                 f"a current capacity of {_inr(monthly_savings)}/month"
                 + ("." if all_goals_affordable else
                    f" — a combined shortfall of {_inr(combined_shortfall)}/month.")),
            ],
        }

    @staticmethod
    def update_financial_goal(
        goal_id: str,
        current_amount: Optional[float] = None,
        status: Optional[str] = None
    ) -> Dict[str, Any]:
        """Updates progress (current_amount) or status of a financial goal."""
        if not goal_id:
            return {"error": "goal_id is required"}

        updates = []
        params = []
        if current_amount is not None:
            try:
                amt = max(0.0, float(current_amount))
                updates.append("current_amount = %s")
                params.append(amt)
            except (ValueError, TypeError):
                return {"error": "current_amount must be a valid number"}
        if status is not None:
            if status in ("active", "completed", "paused", "cancelled"):
                updates.append("status = %s")
                params.append(status)
            else:
                return {"error": f"Invalid status '{status}'"}

        if not updates:
            return {"error": "No updates specified"}

        params.append(goal_id)
        query = f"UPDATE financial_goals SET {', '.join(updates)} WHERE goal_id = %s RETURNING *;"

        conn = get_db_connection()
        c = conn.cursor()
        c.execute(query, tuple(params))
        row = c.fetchone()
        if not row:
            c.close()
            conn.close()
            return {"error": f"Goal '{goal_id}' not found"}
        updated = dict(row)
        conn.commit()
        c.close()
        conn.close()
        if updated.get("target_date"):
            updated["target_date"] = str(updated["target_date"])
        if updated.get("created_at"):
            updated["created_at"] = str(updated["created_at"])
        return {"status": "updated", "goal": updated}

    @staticmethod
    def simulate_savings_scenario(
        account_id: Optional[str] = None,
        monthly_extra_savings: float = 0.0,
        months: int = 12,
        goal_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """Deterministic savings projection tool. Computes forward balance and goal acceleration
        using verified historical transactions and explicit assumptions."""
        return _compute_savings_projection(
            account_id=account_id,
            monthly_extra_savings=monthly_extra_savings,
            months=months,
            goal_id=goal_id
        )

    @staticmethod
    def recommend_next_actions(
        account_id: Optional[str] = None,
        goal_id: Optional[str] = None,
        risk_preference: Optional[str] = None
    ) -> Dict[str, Any]:
        """Deterministic, rule-based next-best actions.

        Detects month-over-month increases in DISCRETIONARY spending categories,
        converts each into a concrete reduction with a rupee value, and prices
        the goal impact through the same _compute_savings_projection engine the
        what-if simulator uses - so an action's "2 months earlier" claim and the
        simulator's are produced by identical arithmetic.

        Personalization is deterministic and limited: the risk tier changes the
        recommended reduction size and the ranking order. It never changes a
        projected number, and no investment return is ever introduced.
        """
        conn = get_db_connection()
        c = conn.cursor()
        resolved_account_id = _resolve_account_id(c, account_id)

        clauses = ["transaction_type = 'debit'"]
        params: list = []
        if resolved_account_id:
            clauses.append("account_id = %s")
            params.append(resolved_account_id)
        where = " AND ".join(clauses)

        # Risk tier: explicit argument wins, else inherit it from the goal being
        # accelerated, else default to moderate.
        goal_row = None
        if goal_id:
            c.execute("SELECT * FROM financial_goals WHERE goal_id = %s;", (goal_id,))
            g = c.fetchone()
            goal_row = dict(g) if g else None
        if risk_preference is None and goal_row:
            risk_preference = goal_row.get("risk_preference")
        risk = _normalise_risk(risk_preference)
        profile = RISK_PROFILES[risk]
        trim_pct = profile["trim_pct"]

        # Two most recent months that actually have spending recorded.
        c.execute(f"""
            SELECT TO_CHAR(transaction_date, 'YYYY-MM') as ym
            FROM financial_transactions
            WHERE {where}
            GROUP BY ym ORDER BY ym DESC LIMIT 2;
        """, tuple(params))
        month_rows = [r["ym"] for r in c.fetchall()]

        def _spend_by_category(ym: Optional[str]) -> Dict[str, float]:
            if ym is None:
                c.execute(f"""
                    SELECT COALESCE(category, 'Uncategorized') as cat, SUM(amount) as spend
                    FROM financial_transactions WHERE {where}
                    GROUP BY cat ORDER BY spend DESC;
                """, tuple(params))
            else:
                c.execute(f"""
                    SELECT COALESCE(category, 'Uncategorized') as cat, SUM(amount) as spend
                    FROM financial_transactions
                    WHERE {where} AND TO_CHAR(transaction_date, 'YYYY-MM') = %s
                    GROUP BY cat ORDER BY spend DESC;
                """, tuple(params) + (ym,))
            return {r["cat"]: float(r["spend"]) for r in c.fetchall()}

        latest_ym = month_rows[0] if month_rows else None
        prior_ym = month_rows[1] if len(month_rows) > 1 else None
        latest_spend_map = _spend_by_category(latest_ym)
        prior_spend_map = _spend_by_category(prior_ym) if prior_ym else {}

        c.close()
        conn.close()

        # Build candidate opportunities. Only discretionary categories are ever
        # proposed for reduction; rent, utilities and salary are excluded because
        # telling someone to "trim rent" is not an action they can take.
        candidates = []
        for cat, latest_spend in latest_spend_map.items():
            cat_key = cat.strip().lower()
            if cat_key in SAVINGS_CATEGORIES or cat_key not in DISCRETIONARY_CATEGORIES:
                continue
            if latest_spend < 500:
                continue

            prior_spend = prior_spend_map.get(cat, 0.0)
            if prior_spend > 0:
                pct_increase = round(((latest_spend - prior_spend) / prior_spend) * 100, 1)
            else:
                pct_increase = 0.0
            mom_increase = round(latest_spend - prior_spend, 2) if prior_spend > 0 else 0.0

            is_surge = prior_spend > 0 and pct_increase > 15.0
            candidates.append({
                "category": cat,
                "latest_spend": round(latest_spend, 2),
                "prior_spend": round(prior_spend, 2),
                "mom_increase_inr": mom_increase,
                "pct_increase": pct_increase,
                "is_surge": is_surge,
                "latest_month": latest_ym or "all_time",
                "prior_month": prior_ym or "not available (single month of data)",
            })

        # Ranking. A genuine month-over-month surge always outranks a merely
        # large category, because a surge is evidence of a recent, reversible
        # change in behaviour. Within that, the tier decides the tie-break:
        # acceleration ranks by the absolute rupees freed up, stability ranks by
        # the size of the recent increase (undoing the drift), balanced ranks by
        # the saving actually achievable at the tier's reduction rate.
        if profile["priority"] == "acceleration":
            candidates.sort(key=lambda x: (x["is_surge"], x["latest_spend"]), reverse=True)
        elif profile["priority"] == "stability":
            candidates.sort(key=lambda x: (x["is_surge"], x["mom_increase_inr"]), reverse=True)
        else:
            candidates.sort(key=lambda x: (x["is_surge"], x["latest_spend"] * trim_pct), reverse=True)

        selected = candidates[:3]

        actions = []
        for opp in selected:
            cat = opp["category"]
            spend = opp["latest_spend"]
            monthly_saving = round(spend * trim_pct, 2)
            annual_saving = round(monthly_saving * 12, 2)

            if opp["is_surge"]:
                why = (
                    f"{cat} spending rose {opp['pct_increase']}% "
                    f"({_inr(opp['prior_spend'])} to {_inr(opp['latest_spend'])}, "
                    f"an increase of {_inr(opp['mom_increase_inr'])}) between "
                    f"{opp['prior_month']} and {opp['latest_month']}."
                )
                action_text = (
                    f"Reduce {cat} spending by {int(trim_pct * 100)}% to free up "
                    f"{_inr(monthly_saving)} a month."
                )
            else:
                why = (
                    f"{cat} is one of your largest discretionary categories at "
                    f"{_inr(spend)} in {opp['latest_month']}."
                )
                action_text = (
                    f"Trim {cat} by {int(trim_pct * 100)}% to free up "
                    f"{_inr(monthly_saving)} a month."
                )

            # Goal impact priced by the shared projection engine - never a
            # separate formula, so these months can never drift from the
            # simulator's months for the same rupee amount.
            goal_impact = None
            if goal_id:
                proj = _compute_savings_projection(
                    account_id=resolved_account_id,
                    monthly_extra_savings=monthly_saving,
                    months=12,
                    goal_id=goal_id
                )
                gp = proj.get("goal_projection")
                if gp:
                    goal_impact = {
                        "goal_id": gp["goal_id"],
                        "goal_name": gp["goal_name"],
                        "months_saved": gp["months_saved"],
                        "months_saved_label": gp["months_saved_label"],
                        "baseline_projected_date": gp["baseline_projected_date"],
                        "new_projected_date": gp["new_projected_date"],
                    }

            # reduction_options is retained for backward compatibility with the
            # existing Goals UI, which renders a 25%/50% pair.
            save_25 = round(spend * 0.25, 2)
            save_50 = round(spend * 0.50, 2)

            actions.append({
                "category": cat,
                "action": action_text,
                "why": why,
                "rationale": why,
                "opportunity_type": "spending_surge" if opp["is_surge"] else "top_discretionary_expense",
                "current_monthly_spend": spend,
                "prior_monthly_spend": opp["prior_spend"],
                "mom_increase_inr": opp["mom_increase_inr"],
                "pct_increase": opp["pct_increase"],
                "recommended_reduction_pct": int(trim_pct * 100),
                "monthly_saving": monthly_saving,
                "annual_saving": annual_saving,
                "goal_impact": goal_impact,
                "reduction_options": {
                    "trim_25_pct": {"monthly_saving": save_25, "annual_saving": round(save_25 * 12, 2)},
                    "trim_50_pct": {"monthly_saving": save_50, "annual_saving": round(save_50 * 12, 2)},
                },
            })

        # Conservative tier only: a cash-buffer action, ranked first. This is the
        # one place the risk tier adds an action rather than re-ranking one, and
        # it is still entirely deterministic - an emergency-fund target of three
        # months of real average expenses, compared against the real balance.
        position = _compute_financial_position(account_id=resolved_account_id)
        if risk == "conservative" and position["has_data"] and position["monthly_expenses"] > 0:
            buffer_target = round(position["monthly_expenses"] * 3, 2)
            buffer_gap = round(buffer_target - position["current_balance"], 2)
            if buffer_gap > 0:
                actions.insert(0, {
                    "category": "Emergency Buffer",
                    "action": (
                        f"Build your cash buffer to {_inr(buffer_target)} "
                        f"(3 months of expenses) before accelerating other goals."
                    ),
                    "why": (
                        f"Your balance of {_inr(position['current_balance'])} is "
                        f"{_inr(buffer_gap)} short of three months of average expenses "
                        f"({_inr(position['monthly_expenses'])}/month)."
                    ),
                    "rationale": "Conservative risk preference prioritises a cash buffer over goal acceleration.",
                    "opportunity_type": "emergency_buffer",
                    "current_monthly_spend": position["monthly_expenses"],
                    "prior_monthly_spend": 0.0,
                    "mom_increase_inr": 0.0,
                    "pct_increase": 0.0,
                    "recommended_reduction_pct": 0,
                    "monthly_saving": 0.0,
                    "annual_saving": 0.0,
                    "buffer_target": buffer_target,
                    "buffer_gap": buffer_gap,
                    "goal_impact": None,
                    "reduction_options": {},
                })

        return {
            "account_id": resolved_account_id,
            "goal_id": goal_id,
            "goal_name": goal_row.get("goal_name") if goal_row else None,
            "risk_preference": risk,
            "risk_label": profile["label"],
            "risk_strategy": profile["summary"],
            "recommended_reduction_pct": int(trim_pct * 100),
            "suggested_scenario_amounts": profile["scenario_ladder"],
            "actions_identified": len(actions),
            "recommendations": actions,
            "analysis_window": {"latest_month": latest_ym, "prior_month": prior_ym},
            "rule_applied": (
                f"Discretionary categories with a >15% month-over-month spend increase and at least "
                f"₹500 of monthly volume are flagged as savings opportunities. A {risk} risk preference "
                f"proposes a {int(trim_pct * 100)}% reduction and ranks by {profile['priority']}."
            ),
            "assumptions": [
                "Assumes discretionary category spending can be voluntarily reduced without penalty.",
                "Only discretionary categories are proposed for reduction; rent, utilities and "
                "existing savings contributions are excluded.",
                "Goal impact is priced by the same deterministic cash-flow engine used by the "
                "what-if simulator, with no interest, investment return or inflation modelled.",
                "This is a synthetic planning model for a hackathon demonstration, not regulated "
                "financial advice.",
            ],
        }


def _compute_savings_projection(
    account_id: Optional[str],
    monthly_extra_savings: float = 0.0,
    months: int = 12,
    goal_id: Optional[str] = None
) -> Dict[str, Any]:
    """Authoritative what-if projection engine, shared by simulate_savings_scenario
    and recommend_next_actions so the two can never disagree by a rupee.

    Balance and baseline monthly saving are NOT recomputed here — they come from
    _compute_financial_position, the single source of truth also used by the
    dashboard. This function only does the forward arithmetic:

        projected balance = current balance + (baseline + extra) x months

    No interest, no investment return, no inflation and no tax is modelled.
    That is a deliberate limitation, stated in the returned assumptions rather
    than hidden, because the engine has no verified basis for any of them.
    """
    monthly_extra_savings = max(0.0, float(monthly_extra_savings or 0.0))
    months = max(1, int(months or 12))

    position = _compute_financial_position(account_id=account_id)
    resolved_account_id = position["account_id"]
    current_balance = position["current_balance"]
    baseline_monthly_savings = position["monthly_savings"]

    total_monthly_savings = round(baseline_monthly_savings + monthly_extra_savings, 2)
    projected_balance = round(current_balance + (total_monthly_savings * months), 2)
    baseline_projected_balance = round(current_balance + (baseline_monthly_savings * months), 2)
    total_extra_saved = round(monthly_extra_savings * months, 2)

    # Goal impact: baseline timeline vs scenario timeline for the same goal.
    goal_info = None
    if goal_id:
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("SELECT * FROM financial_goals WHERE goal_id = %s;", (goal_id,))
        g_row = c.fetchone()
        c.close()
        conn.close()

        if g_row:
            g = dict(g_row)
            derived = _derive_goal_metrics(g, baseline_monthly_savings)
            remaining_needed = derived["amount_remaining"]
            today = datetime.now(timezone.utc).date()

            def _timeline(rate: float):
                """Months needed (whole months, and the exact fractional value)
                plus the completion date at a given monthly rate. Returns Nones
                when the goal is unreachable at that rate rather than inventing
                a date."""
                if remaining_needed <= 0:
                    return 0, 0.0, today.isoformat()
                if rate <= 0:
                    return None, None, None
                exact = remaining_needed / rate
                n = math.ceil(exact)
                # The DATE is built from the exact fractional timeline, not the
                # rounded-up month count. Using `n` here would render two
                # genuinely different timelines as the same calendar date and
                # contradict the "X days earlier" figure shown beside it.
                return n, exact, (today + timedelta(days=DAYS_PER_MONTH * exact)).isoformat()

            baseline_months_needed, baseline_exact, baseline_completion_date = _timeline(baseline_monthly_savings)
            new_months_needed, new_exact, new_completion_date = _timeline(total_monthly_savings)

            # Measured on the exact fractional timelines, not the rounded-up
            # whole months. Rounding each side up first would report a genuine
            # three-week improvement as "0 months earlier" whenever both sides
            # happen to land inside the same calendar month.
            if baseline_exact is not None and new_exact is not None:
                exact_saved = max(0.0, baseline_exact - new_exact)
                months_saved = round(exact_saved, 1)
                days_saved = int(round(exact_saved * DAYS_PER_MONTH))
                if months_saved >= 1:
                    months_saved_label = f"about {months_saved} month(s) earlier"
                elif days_saved > 0:
                    months_saved_label = f"about {days_saved} day(s) earlier"
                else:
                    months_saved_label = "no measurable change to the goal date"
            elif baseline_exact is None and new_exact is not None:
                months_saved = None
                days_saved = None
                months_saved_label = (
                    "Unreachable at the current saving rate, but reachable with the extra saving"
                )
            else:
                months_saved = 0
                days_saved = 0
                months_saved_label = "Not reachable at either saving rate"

            goal_info = {
                "goal_id": g["goal_id"],
                "goal_name": g["goal_name"],
                "target_amount": derived["target_amount"],
                "current_amount": derived["current_amount"],
                "remaining_needed": remaining_needed,
                "goal_gap": remaining_needed,
                "progress_percent": derived["progress_percent"],
                "target_date": str(g["target_date"]) if g.get("target_date") else None,
                "required_monthly_saving": derived["required_monthly_saving"],
                "derived_status": derived["derived_status"],
                "status_reason": derived["status_reason"],
                "risk_preference": derived["risk_preference"],
                "days_saved": days_saved,
                "baseline_months_to_goal": baseline_months_needed,
                "baseline_projected_date": baseline_completion_date
                    or "Unreachable at the baseline saving rate (net monthly cash flow is not positive)",
                "new_months_to_goal": new_months_needed,
                "new_projected_date": new_completion_date
                    or "Unreachable even with the extra saving (net monthly cash flow is not positive)",
                "months_saved": months_saved if months_saved is not None else months_saved_label,
                "months_saved_label": months_saved_label,
            }

    assumptions = list(position["assumptions"]) + [
        f"Projection horizon is {months} month(s).",
        (f"Assumes an additional {_inr(monthly_extra_savings)} is saved every month on top of "
         f"the {_inr(baseline_monthly_savings)}/month baseline."
         if monthly_extra_savings > 0 else
         "No additional monthly saving is applied in this scenario — this is the current plan."),
        "Assumes income and all other spending stay unchanged for the whole horizon.",
        "Excludes investment returns, interest, inflation, taxes and one-off emergencies — "
        "none of these are modelled, so the projection is a plain cash-flow estimate, not a forecast.",
    ]

    return {
        "account_id": resolved_account_id,
        "has_data": position["has_data"],
        "current_balance": current_balance,
        "balance_method": position["balance_method"],
        "balance_as_of": position["balance_as_of"],
        "monthly_income": position["monthly_income"],
        "monthly_expenses": position["monthly_expenses"],
        # Named both ways on purpose: `current_monthly_savings` is what the UI and
        # the agent read, `avg_monthly_net_savings` is retained so existing
        # callers and stored recommendation records keep working unchanged.
        "current_monthly_savings": baseline_monthly_savings,
        "avg_monthly_net_savings": baseline_monthly_savings,
        "monthly_extra_savings": monthly_extra_savings,
        "total_monthly_savings": total_monthly_savings,
        "new_monthly_savings": total_monthly_savings,
        "projection_months": months,
        "projected_balance": projected_balance,
        "baseline_projected_balance": baseline_projected_balance,
        "projected_balance_difference": round(projected_balance - baseline_projected_balance, 2),
        "total_extra_saved": total_extra_saved,
        "goal_projection": goal_info,
        "assumptions": assumptions
    }


GEMINI_FINANCIAL_TOOL_DECLARATIONS = [
    {
        "name": "get_financial_position",
        "description": (
            "Returns the user's deterministic financial position: current balance, average monthly "
            "income, average monthly expenses, average monthly savings and savings rate, plus the "
            "calculation basis and assumptions. ALWAYS call this before discussing the user's "
            "financial situation, affordability, or savings capacity — never estimate these yourself."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "account_id": {"type": "STRING", "description": "Optional account to analyse; defaults to the most recent account."},
                "months": {"type": "INTEGER", "description": "How many recent months to average over (default 3)."}
            },
            "required": []
        }
    },
    {
        "name": "search_financial_documents",
        "description": "Semantic search over all uploaded financial documents (statements, invoices, policies) using real embeddings. Use for textual/explanatory questions.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "query": {"type": "STRING", "description": "The natural-language search query."},
                "document_type": {"type": "STRING", "description": "Optional filter: 'bank_statement', 'credit_card_statement', 'fee_policy', 'invoice', 'refund_report'."},
                "limit": {"type": "INTEGER", "description": "Max chunks to return (default 5)."}
            },
            "required": ["query"]
        }
    },
    {
        "name": "search_financial_policy",
        "description": "Semantic search restricted to uploaded fee/policy documents only — use when the user asks whether a fee/charge is supported by policy.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "query": {"type": "STRING", "description": "The policy question to search for."},
                "limit": {"type": "INTEGER", "description": "Max chunks to return (default 5)."}
            },
            "required": ["query"]
        }
    },
    {
        "name": "get_transactions",
        "description": "Retrieves structured financial transactions with optional filters (date range, merchant, category, amount range).",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "account_id": {"type": "STRING"},
                "start_date": {"type": "STRING", "description": "ISO date, e.g. '2026-08-01'."},
                "end_date": {"type": "STRING", "description": "ISO date, e.g. '2026-08-31'."},
                "merchant": {"type": "STRING", "description": "Partial merchant name to filter by."},
                "category": {"type": "STRING"},
                "min_amount": {"type": "NUMBER"},
                "max_amount": {"type": "NUMBER"},
                "limit": {"type": "INTEGER"}
            },
            "required": []
        }
    },
    {
        "name": "get_transaction_details",
        "description": "Retrieves full detail for one transaction by ID, including its source document and any matching MoneyOps incident.",
        "parameters": {
            "type": "OBJECT",
            "properties": {"transaction_id": {"type": "STRING"}},
            "required": ["transaction_id"]
        }
    },
    {
        "name": "get_spending_summary",
        "description": "Aggregates spend grouped by category or merchant over an optional date range.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "account_id": {"type": "STRING"},
                "start_date": {"type": "STRING"},
                "end_date": {"type": "STRING"},
                "group_by": {"type": "STRING", "description": "'category' or 'merchant'."}
            },
            "required": []
        }
    },
    {
        "name": "compare_periods",
        "description": "Deterministic comparison of total spend and category breakdown between two date ranges (e.g. this month vs last month). All math computed by the backend, not estimated.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "account_id": {"type": "STRING"},
                "period_a_start": {"type": "STRING"},
                "period_a_end": {"type": "STRING"},
                "period_b_start": {"type": "STRING"},
                "period_b_end": {"type": "STRING"}
            },
            "required": ["period_a_start", "period_a_end", "period_b_start", "period_b_end"]
        }
    },
    {
        "name": "find_duplicate_transactions",
        "description": "Finds transaction pairs with the same merchant and amount within a short date window — a duplicate-charge signature.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "account_id": {"type": "STRING"},
                "amount_tolerance": {"type": "NUMBER"},
                "date_window_days": {"type": "INTEGER"}
            },
            "required": []
        }
    },
    {
        "name": "find_recurring_transactions",
        "description": "Finds merchant+amount combinations that repeat at least min_occurrences times — a recurring-subscription/payment signature.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "account_id": {"type": "STRING"},
                "min_occurrences": {"type": "INTEGER"}
            },
            "required": []
        }
    },
    {
        "name": "calculate_financial_metric",
        "description": "Computes one deterministic financial metric from a fixed whitelist: 'total_spend', 'average_transaction', 'largest_expense', 'transaction_count'. Reject any other metric name.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "metric": {"type": "STRING", "description": "One of: total_spend, average_transaction, largest_expense, transaction_count."},
                "account_id": {"type": "STRING"},
                "start_date": {"type": "STRING"},
                "end_date": {"type": "STRING"}
            },
            "required": ["metric"]
        }
    },
    {
        "name": "create_financial_goal",
        "description": "Creates a new personal financial goal with a target amount and target date.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "account_id": {"type": "STRING", "description": "Optional account identifier to link this goal to."},
                "goal_name": {"type": "STRING", "description": "Name or purpose of the goal (e.g. 'Emergency Fund', 'House Down Payment')."},
                "target_amount": {"type": "NUMBER", "description": "The target savings amount in INR."},
                "target_date": {"type": "STRING", "description": "Target completion date in YYYY-MM-DD format."},
                "risk_preference": {"type": "STRING", "description": "Risk preference: 'conservative', 'moderate', or 'aggressive'."}
            },
            "required": ["goal_name", "target_amount"]
        }
    },
    {
        "name": "get_financial_goals",
        "description": "Retrieves the user's active or past financial goals, including target amounts and current progress.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "account_id": {"type": "STRING", "description": "Optional account filter."},
                "status": {"type": "STRING", "description": "Goal status filter: 'active', 'completed', 'paused', or 'all' (default 'active')."}
            },
            "required": []
        }
    },
    {
        "name": "simulate_savings_scenario",
        "description": "Deterministic 'what-if' savings projection. Calculates projected account balance and goal timeline acceleration given an extra monthly savings amount and month duration. Never calculate projections yourself — use this tool's exact figures and assumptions.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "account_id": {"type": "STRING", "description": "Account to evaluate."},
                "monthly_extra_savings": {"type": "NUMBER", "description": "Additional monthly amount to save in INR (e.g. 5000)."},
                "months": {"type": "INTEGER", "description": "Projection horizon in months (default 12)."},
                "goal_id": {"type": "STRING", "description": "Optional goal ID to project completion date acceleration for."}
            },
            "required": ["monthly_extra_savings"]
        }
    },
    {
        "name": "recommend_next_actions",
        "description": (
            "Deterministic rule-based next-best-action tool. Analyses month-over-month increases in "
            "discretionary spending categories, computes the exact monthly and annual saving from a "
            "recommended reduction, and prices how that accelerates a goal. The risk preference "
            "changes the recommended reduction size and ranking only — it never changes a projected "
            "number and introduces no investment return. Never invent recommendation numbers or "
            "percentages: quote this tool's exact figures."
        ),
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "account_id": {"type": "STRING", "description": "Account to evaluate."},
                "goal_id": {"type": "STRING", "description": "Optional goal ID to calculate timeline acceleration for."},
                "risk_preference": {"type": "STRING", "description": "Optional override: 'conservative', 'moderate' or 'aggressive'. Defaults to the goal's own risk preference."}
            },
            "required": []
        }
    }
]

FINANCIAL_TOOL_REGISTRY = {
    "get_financial_position": FinancialTools.get_financial_position,
    "search_financial_documents": FinancialTools.search_financial_documents,
    "search_financial_policy": FinancialTools.search_financial_policy,
    "get_transactions": FinancialTools.get_transactions,
    "get_transaction_details": FinancialTools.get_transaction_details,
    "get_spending_summary": FinancialTools.get_spending_summary,
    "compare_periods": FinancialTools.compare_periods,
    "find_duplicate_transactions": FinancialTools.find_duplicate_transactions,
    "find_recurring_transactions": FinancialTools.find_recurring_transactions,
    "calculate_financial_metric": FinancialTools.calculate_financial_metric,
    "create_financial_goal": FinancialTools.create_financial_goal,
    "get_financial_goals": FinancialTools.get_financial_goals,
    "simulate_savings_scenario": FinancialTools.simulate_savings_scenario,
    "recommend_next_actions": FinancialTools.recommend_next_actions,
}
