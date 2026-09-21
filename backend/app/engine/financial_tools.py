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


class FinancialTools:

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
        """Lists financial goals with optional filters by account and status."""
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
        rows = []
        for r in c.fetchall():
            d = dict(r)
            if d.get("target_date"):
                d["target_date"] = str(d["target_date"])
            if d.get("created_at"):
                d["created_at"] = str(d["created_at"])
            rows.append(d)
        c.close()
        conn.close()
        return {"goals_returned": len(rows), "goals": rows}

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
        goal_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """Deterministic rule-based recommendation tool. Detects spend surges (>15% MoM increase),
        computes savings impact, and evaluates goal timeline acceleration using the shared projection helper."""
        conn = get_db_connection()
        c = conn.cursor()

        clauses = ["transaction_type = 'debit'"]
        params: list = []
        if account_id:
            clauses.append("account_id = %s")
            params.append(account_id)

        # 1. Fetch distinct months of debit transactions
        c.execute(f"""
            SELECT TO_CHAR(transaction_date, 'YYYY-MM') as ym
            FROM financial_transactions
            WHERE {' AND '.join(clauses)}
            GROUP BY ym ORDER BY ym DESC LIMIT 2;
        """, tuple(params))
        month_rows = [r["ym"] for r in c.fetchall()]

        candidate_actions = []

        if len(month_rows) >= 2:
            latest_ym, prior_ym = month_rows[0], month_rows[1]

            params_latest = list(params) + [latest_ym]
            c.execute(f"""
                SELECT COALESCE(category, 'Uncategorized') as cat, SUM(amount) as spend
                FROM financial_transactions
                WHERE {' AND '.join(clauses)} AND TO_CHAR(transaction_date, 'YYYY-MM') = %s
                GROUP BY cat ORDER BY spend DESC;
            """, tuple(params_latest))
            latest_spend_map = {r["cat"]: float(r["spend"]) for r in c.fetchall()}

            params_prior = list(params) + [prior_ym]
            c.execute(f"""
                SELECT COALESCE(category, 'Uncategorized') as cat, SUM(amount) as spend
                FROM financial_transactions
                WHERE {' AND '.join(clauses)} AND TO_CHAR(transaction_date, 'YYYY-MM') = %s
                GROUP BY cat;
            """, tuple(params_prior))
            prior_spend_map = {r["cat"]: float(r["spend"]) for r in c.fetchall()}

            opportunities = []
            for cat, l_spend in latest_spend_map.items():
                p_spend = prior_spend_map.get(cat, 0.0)
                if p_spend > 0:
                    pct_increase = round(((l_spend - p_spend) / p_spend) * 100, 1)
                else:
                    pct_increase = 100.0 if l_spend > 0 else 0.0

                if pct_increase > 15.0 and l_spend >= 500:
                    opportunities.append({
                        "category": cat,
                        "latest_spend": round(l_spend, 2),
                        "prior_spend": round(p_spend, 2),
                        "mom_increase_inr": round(l_spend - p_spend, 2),
                        "pct_increase": pct_increase,
                        "latest_month": latest_ym,
                        "prior_month": prior_ym
                    })

            opportunities.sort(key=lambda x: x["mom_increase_inr"], reverse=True)
            candidate_actions = opportunities[:3]
        elif len(month_rows) == 1:
            latest_ym = month_rows[0]
            params_latest = list(params) + [latest_ym]
            c.execute(f"""
                SELECT COALESCE(category, 'Uncategorized') as cat, SUM(amount) as spend
                FROM financial_transactions
                WHERE {' AND '.join(clauses)} AND TO_CHAR(transaction_date, 'YYYY-MM') = %s
                GROUP BY cat ORDER BY spend DESC LIMIT 3;
            """, tuple(params_latest))
            for r in c.fetchall():
                spend = float(r["spend"])
                if spend >= 500:
                    candidate_actions.append({
                        "category": r["cat"],
                        "latest_spend": round(spend, 2),
                        "prior_spend": 0.0,
                        "mom_increase_inr": round(spend, 2),
                        "pct_increase": 0.0,
                        "latest_month": latest_ym,
                        "prior_month": "N/A (single month data)"
                    })
        else:
            c.execute(f"""
                SELECT COALESCE(category, 'Uncategorized') as cat, SUM(amount) as spend
                FROM financial_transactions
                WHERE {' AND '.join(clauses)}
                GROUP BY cat ORDER BY spend DESC LIMIT 3;
            """, tuple(params))
            for r in c.fetchall():
                spend = float(r["spend"])
                if spend >= 500:
                    candidate_actions.append({
                        "category": r["cat"],
                        "latest_spend": round(spend, 2),
                        "prior_spend": 0.0,
                        "mom_increase_inr": round(spend, 2),
                        "pct_increase": 0.0,
                        "latest_month": "all_time",
                        "prior_month": "N/A"
                    })

        c.close()
        conn.close()

        actions = []
        for opp in candidate_actions:
            cat = opp["category"]
            spend = opp["latest_spend"]
            save_25 = round(spend * 0.25, 2)
            save_50 = round(spend * 0.50, 2)

            goal_impact_25 = None
            goal_impact_50 = None
            if goal_id:
                # Calls the EXACT SAME projection helper to guarantee zero formula drift!
                proj_25 = _compute_savings_projection(account_id=account_id, monthly_extra_savings=save_25, months=12, goal_id=goal_id)
                proj_50 = _compute_savings_projection(account_id=account_id, monthly_extra_savings=save_50, months=12, goal_id=goal_id)
                gp_25 = proj_25.get("goal_projection")
                gp_50 = proj_50.get("goal_projection")
                if gp_25:
                    goal_impact_25 = {
                        "months_saved": gp_25.get("months_saved"),
                        "new_projected_date": gp_25.get("new_projected_date")
                    }
                if gp_50:
                    goal_impact_50 = {
                        "months_saved": gp_50.get("months_saved"),
                        "new_projected_date": gp_50.get("new_projected_date")
                    }

            actions.append({
                "category": cat,
                "current_monthly_spend": spend,
                "prior_monthly_spend": opp["prior_spend"],
                "mom_increase_inr": opp["mom_increase_inr"],
                "pct_increase": opp["pct_increase"],
                "opportunity_type": "spending_surge" if opp["pct_increase"] > 15 else "top_expense",
                "reduction_options": {
                    "trim_25_pct": {
                        "monthly_saving": save_25,
                        "annual_saving": round(save_25 * 12, 2),
                        "goal_impact": goal_impact_25
                    },
                    "trim_50_pct": {
                        "monthly_saving": save_50,
                        "annual_saving": round(save_50 * 12, 2),
                        "goal_impact": goal_impact_50
                    }
                }
            })

        return {
            "account_id": account_id,
            "goal_id": goal_id,
            "actions_identified": len(actions),
            "recommendations": actions,
            "rule_applied": "Categories with >15% month-over-month spend increase and min ₹500 volume flagged as savings opportunities.",
            "assumptions": [
                "Assumes category spending can be voluntarily reduced without penalty.",
                "Goal impact projections use the shared deterministic cash-flow engine with no interest or inflation modeled."
            ]
        }


def _compute_savings_projection(
    account_id: Optional[str],
    monthly_extra_savings: float = 0.0,
    months: int = 12,
    goal_id: Optional[str] = None
) -> Dict[str, Any]:
    """Authoritative projection engine shared by simulate_savings_scenario and
    recommend_next_actions. Guarantees deterministic arithmetic and identical numbers."""
    monthly_extra_savings = max(0.0, float(monthly_extra_savings or 0.0))
    months = max(1, int(months or 12))

    conn = get_db_connection()
    c = conn.cursor()

    resolved_account_id = account_id
    if not resolved_account_id:
        c.execute("SELECT account_id FROM financial_accounts ORDER BY created_at DESC LIMIT 1;")
        acc_row = c.fetchone()
        if acc_row:
            resolved_account_id = acc_row["account_id"]

    clauses = ["1=1"]
    params: list = []
    if resolved_account_id:
        clauses.append("account_id = %s")
        params.append(resolved_account_id)

    # 1. Current Balance Proxy
    c.execute(f"""
        SELECT balance_after, transaction_date
        FROM financial_transactions
        WHERE {' AND '.join(clauses)} AND balance_after IS NOT NULL
        ORDER BY transaction_date DESC, transaction_id DESC LIMIT 1;
    """, tuple(params))
    latest_bal_row = c.fetchone()

    if latest_bal_row and latest_bal_row["balance_after"] is not None:
        current_balance = float(latest_bal_row["balance_after"])
        balance_method = "statement_balance"
        bal_date_str = latest_bal_row["transaction_date"].strftime("%Y-%m-%d") if hasattr(latest_bal_row["transaction_date"], "strftime") else str(latest_bal_row["transaction_date"])
        balance_assumption = f"Based on latest reported statement balance of ₹{current_balance:,.2f} (as of {bal_date_str})."
    else:
        c.execute(f"""
            SELECT COALESCE(SUM(CASE WHEN transaction_type = 'credit' THEN amount ELSE -amount END), 0) as net_balance
            FROM financial_transactions WHERE {' AND '.join(clauses)};
        """, tuple(params))
        net_row = c.fetchone()
        current_balance = float(net_row["net_balance"]) if net_row else 0.0
        balance_method = "net_transaction_sum"
        balance_assumption = f"Estimated from net transaction history (sum of credits minus debits: ₹{current_balance:,.2f}) because statement balance was not reported in transaction records."

    # 2. Average Monthly Net Savings with graceful degradation
    c.execute(f"""
        SELECT TO_CHAR(transaction_date, 'YYYY-MM') as ym,
               COALESCE(SUM(CASE WHEN transaction_type = 'credit' THEN amount ELSE 0 END), 0) as credits,
               COALESCE(SUM(CASE WHEN transaction_type = 'debit' THEN amount ELSE 0 END), 0) as debits
        FROM financial_transactions
        WHERE {' AND '.join(clauses)}
        GROUP BY ym
        ORDER BY ym DESC
        LIMIT 3;
    """, tuple(params))
    month_rows = [dict(r) for r in c.fetchall()]

    n_months = len(month_rows)
    if n_months >= 3:
        avg_credits = sum(float(r["credits"]) for r in month_rows) / 3.0
        avg_debits = sum(float(r["debits"]) for r in month_rows) / 3.0
        avg_monthly_net_savings = round(avg_credits - avg_debits, 2)
        month_labels = [datetime.strptime(r["ym"], "%Y-%m").strftime("%b %Y") for r in reversed(month_rows)]
        history_assumption = f"Based on average of last 3 months' actual transactions ({', '.join(month_labels)}): avg income ₹{avg_credits:,.2f}/mo, avg spend ₹{avg_debits:,.2f}/mo."
    elif n_months > 0:
        avg_credits = sum(float(r["credits"]) for r in month_rows) / float(n_months)
        avg_debits = sum(float(r["debits"]) for r in month_rows) / float(n_months)
        avg_monthly_net_savings = round(avg_credits - avg_debits, 2)
        month_labels = [datetime.strptime(r["ym"], "%Y-%m").strftime("%b %Y") for r in reversed(month_rows)]
        history_assumption = f"Based on {n_months} available month(s) of actual transaction data ({', '.join(month_labels)}) — projection is an initial estimate; requires more historical statements for higher accuracy."
    else:
        avg_credits = 0.0
        avg_debits = 0.0
        avg_monthly_net_savings = 0.0
        history_assumption = "No historical transactions found for this account; baseline monthly net savings assumed to be ₹0."

    total_monthly_savings = round(avg_monthly_net_savings + monthly_extra_savings, 2)
    projected_balance = round(current_balance + (total_monthly_savings * months), 2)
    total_extra_saved = round(monthly_extra_savings * months, 2)

    # 3. Goal Impact Calculation
    goal_info = None
    if goal_id:
        c.execute("SELECT * FROM financial_goals WHERE goal_id = %s;", (goal_id,))
        g_row = c.fetchone()
        if g_row:
            g = dict(g_row)
            target_amount = float(g["target_amount"])
            current_amount = float(g.get("current_amount") or 0.0)
            remaining_needed = max(0.0, target_amount - current_amount)

            if avg_monthly_net_savings > 0 and remaining_needed > 0:
                baseline_months_needed = math.ceil(remaining_needed / avg_monthly_net_savings)
                baseline_completion_date = (datetime.now(timezone.utc) + timedelta(days=30.4375 * baseline_months_needed)).strftime("%Y-%m-%d")
            elif remaining_needed == 0:
                baseline_months_needed = 0
                baseline_completion_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            else:
                baseline_months_needed = None
                baseline_completion_date = "Unreachable at baseline savings rate (net cash flow is ≤ ₹0)"

            if total_monthly_savings > 0 and remaining_needed > 0:
                new_months_needed = math.ceil(remaining_needed / total_monthly_savings)
                new_completion_date = (datetime.now(timezone.utc) + timedelta(days=30.4375 * new_months_needed)).strftime("%Y-%m-%d")
            elif remaining_needed == 0:
                new_months_needed = 0
                new_completion_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            else:
                new_months_needed = None
                new_completion_date = "Unreachable even with extra savings (net cash flow is ≤ ₹0)"

            if baseline_months_needed is not None and new_months_needed is not None:
                months_saved = max(0, baseline_months_needed - new_months_needed)
            elif baseline_months_needed is None and new_months_needed is not None:
                months_saved = "Accelerates goal to reachable timeline"
            else:
                months_saved = 0

            goal_info = {
                "goal_id": g["goal_id"],
                "goal_name": g["goal_name"],
                "target_amount": target_amount,
                "current_amount": current_amount,
                "remaining_needed": remaining_needed,
                "target_date": str(g["target_date"]) if g.get("target_date") else None,
                "baseline_months_to_goal": baseline_months_needed,
                "baseline_projected_date": baseline_completion_date,
                "new_months_to_goal": new_months_needed,
                "new_projected_date": new_completion_date,
                "months_saved": months_saved
            }

    c.close()
    conn.close()

    assumptions = [
        balance_assumption,
        history_assumption,
        "Assumes no other spending, income, or lifestyle changes occur during the projection window.",
        "Does not account for inflation, interest, investment returns, taxes, or irregular one-off emergencies."
    ]

    return {
        "account_id": resolved_account_id,
        "current_balance": current_balance,
        "balance_method": balance_method,
        "avg_monthly_net_savings": avg_monthly_net_savings,
        "monthly_extra_savings": monthly_extra_savings,
        "total_monthly_savings": total_monthly_savings,
        "projection_months": months,
        "projected_balance": projected_balance,
        "total_extra_saved": total_extra_saved,
        "goal_projection": goal_info,
        "assumptions": assumptions
    }


GEMINI_FINANCIAL_TOOL_DECLARATIONS = [
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
        "description": "Deterministic rule-based recommendation tool. Analyzes category spend increases (>15% MoM) and computes how reducing expenses accelerates financial goals. Never invent recommendation numbers — quote this tool's exact figures.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "account_id": {"type": "STRING", "description": "Account to evaluate."},
                "goal_id": {"type": "STRING", "description": "Optional goal ID to calculate timeline acceleration for."}
            },
            "required": []
        }
    }
]

FINANCIAL_TOOL_REGISTRY = {
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
