"""
scripts/seed_wealth_demo.py

Deterministic synthetic personal-finance seed for the AI Wealth Navigator demo.

Why this exists
---------------
The Copilot's financial tables were previously populated only from
payment-gateway-flavoured CSVs (merchant names, gateway captures, refunds).
That data cannot demonstrate a personal-wellness product: there is no salary,
no rent, no dining trend, and `balance_after` is never populated, so
_compute_savings_projection falls back to its less accurate
"net_transaction_sum" path.

This script writes ONE coherent synthetic financial life (Alex Sharma) into the
existing financial_accounts / financial_documents / financial_transactions /
financial_goals tables. It introduces no new schema and no new engine — the
deterministic tools in financial_tools.py read it exactly as they read an
uploaded statement.

Safety
------
* Scoped deletes only. It removes rows belonging to its OWN demo account id
  and nothing else, so MoneyOps payments/orders/refunds/incidents and any
  user-uploaded documents are never touched.
* Re-runnable. Running it twice produces byte-identical data rather than
  duplicate transactions.

Determinism
-----------
A fixed RNG seed plus a fixed month anchor. `--as-of YYYY-MM` pins the final
month explicitly; without it the anchor is the most recent COMPLETE calendar
month, so the demo never shows a half-finished month whose partial totals would
make month-over-month comparisons meaningless.

Usage
-----
    python scripts/seed_wealth_demo.py
    python scripts/seed_wealth_demo.py --as-of 2026-08
    python scripts/seed_wealth_demo.py --clear
"""

import argparse
import csv
import io
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = REPO_ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.engine.database import get_db_connection, init_db  # noqa: E402

# ---------------------------------------------------------------------------
# Identity of the seeded demo dataset. Every delete in this script is filtered
# by these ids, which is what keeps the seed from touching anything else.
# ---------------------------------------------------------------------------
DEMO_ACCOUNT_ID = "facc_demo_alex_sharma"
DEMO_DOCUMENT_ID = "fdoc_demo_alex_sharma"
DEMO_GOAL_PREFIX = "fgoal_demo_"
DEMO_SEED = 20260921

MONTHS_OF_HISTORY = 6
OPENING_BALANCE = 120000.00
MONTHLY_SALARY = 85000.00

# Dining and Shopping rise across the window. This is the behaviour the
# deterministic recommendation engine is designed to surface (>15% MoM), so the
# demo has something real to detect rather than a fabricated alert.
# Index 0 = oldest month, index 5 = most recent complete month.
DINING_BUDGET = [4200, 4350, 4500, 4700, 5600, 7200]
SHOPPING_BUDGET = [3000, 3600, 3200, 3800, 3400, 5200]
GROCERY_BUDGET = [8100, 7850, 8250, 8000, 8150, 8300]
TRANSPORT_BUDGET = [4050, 3900, 4200, 4100, 3950, 4300]

GROCERY_MERCHANTS = ["BigBasket", "DMart", "Nature's Basket", "Ratnadeep Supermarket"]
DINING_MERCHANTS = ["Swiggy", "Zomato", "Third Wave Coffee", "Barbeque Nation", "Chai Point"]
TRANSPORT_MERCHANTS = ["Uber India", "Namma Metro", "Indian Oil Fuel", "Rapido"]
SHOPPING_MERCHANTS = ["Myntra", "Amazon India", "Decathlon", "Croma"]

# (day, merchant, amount, category, description)
FIXED_DEBITS = [
    (3, "Sunrise Residency", 18000.00, "Rent", "Monthly house rent"),
    (5, "IndiaFirst Mutual Fund", 5000.00, "Investments", "Monthly SIP contribution"),
    (7, "Netflix India", 649.00, "Subscriptions", "Netflix monthly subscription"),
    (9, "Spotify India", 149.00, "Subscriptions", "Spotify Premium subscription"),
    (12, "Cult.fit", 899.00, "Subscriptions", "Gym membership"),
    (14, "ACT Fibernet", 999.00, "Utilities", "Broadband bill"),
    (16, "Airtel Postpaid", 599.00, "Utilities", "Mobile postpaid bill"),
]

# Irregular real-life events, keyed by month index. Keeps the history from
# looking like a repeating template without making it non-deterministic.
OCCASIONAL = {
    0: [(22, "Apollo Pharmacy", 2400.00, "Healthcare", "Medicines and health checkup")],
    1: [(18, "PVR Cinemas", 1200.00, "Entertainment", "Movie tickets and snacks")],
    2: [(11, "MakeMyTrip", 9500.00, "Travel", "Weekend trip flight booking")],
    3: [(24, "Practo Care", 1800.00, "Healthcare", "Dental consultation")],
    4: [(20, "BookMyShow", 1500.00, "Entertainment", "Concert tickets")],
    5: [(19, "Urban Company", 1600.00, "Other", "Home deep cleaning service")],
}

GOAL_SPECS = [
    {
        "suffix": "emergency",
        "goal_name": "Emergency Fund",
        "target_amount": 200000.00,
        "current_amount": 120000.00,
        "months_out": 9,
        "risk_preference": "conservative",
    },
    {
        "suffix": "car",
        "goal_name": "Car Purchase",
        "target_amount": 800000.00,
        "current_amount": 350000.00,
        "months_out": 30,
        "risk_preference": "moderate",
    },
    {
        "suffix": "vacation",
        "goal_name": "Japan Vacation",
        "target_amount": 80000.00,
        "current_amount": 42000.00,
        "months_out": 8,
        "risk_preference": "conservative",
    },
]


def _last_complete_month(today: datetime) -> tuple:
    """Returns (year, month) of the most recent fully-elapsed calendar month."""
    first_of_this_month = today.replace(day=1)
    last_month_end = first_of_this_month - timedelta(days=1)
    return last_month_end.year, last_month_end.month


def _add_months(year: int, month: int, delta: int) -> tuple:
    idx = (year * 12 + (month - 1)) + delta
    return idx // 12, (idx % 12) + 1


def _split_amount(rng: random.Random, total: float, parts: int) -> list:
    """Splits a monthly budget into `parts` uneven but plausible amounts that
    sum back to exactly `total`, so the monthly category figure the
    recommendation engine reads is the number this script intended."""
    weights = [rng.uniform(0.7, 1.3) for _ in range(parts)]
    scale = total / sum(weights)
    amounts = [round(w * scale, 2) for w in weights]
    drift = round(total - sum(amounts), 2)
    amounts[-1] = round(amounts[-1] + drift, 2)
    return amounts


def build_transactions(anchor_year: int, anchor_month: int) -> list:
    """Builds the full deterministic transaction list, oldest first.

    Returns dicts WITHOUT balance_after; the running balance is applied after
    sorting, so the ledger reconciles regardless of construction order.
    """
    rng = random.Random(DEMO_SEED)
    rows = []

    for m_idx in range(MONTHS_OF_HISTORY):
        delta = -(MONTHS_OF_HISTORY - 1 - m_idx)
        year, month = _add_months(anchor_year, anchor_month, delta)

        def at(day, hour=10, minute=0):
            return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)

        rows.append({
            "date": at(1, 9, 30),
            "description": "Monthly salary credit",
            "merchant": "Lumen Technologies India",
            "amount": MONTHLY_SALARY,
            "type": "credit",
            "category": "Salary",
        })

        for day, merchant, amount, category, description in FIXED_DEBITS:
            rows.append({
                "date": at(day, 11, 0),
                "description": description,
                "merchant": merchant,
                "amount": float(amount),
                "type": "debit",
                "category": category,
            })

        electricity = round(2100 + rng.uniform(-250, 450), 2)
        rows.append({
            "date": at(15, 12, 0),
            "description": "Electricity bill",
            "merchant": "BESCOM",
            "amount": electricity,
            "type": "debit",
            "category": "Utilities",
        })

        for i, amt in enumerate(_split_amount(rng, GROCERY_BUDGET[m_idx], 4)):
            rows.append({
                "date": at(4 + i * 7, 18, 15),
                "description": "Weekly grocery shopping",
                "merchant": GROCERY_MERCHANTS[i % len(GROCERY_MERCHANTS)],
                "amount": amt,
                "type": "debit",
                "category": "Groceries",
            })

        for i, amt in enumerate(_split_amount(rng, DINING_BUDGET[m_idx], 6)):
            rows.append({
                "date": at(2 + i * 4, 20, 30),
                "description": "Restaurant / food delivery order",
                "merchant": DINING_MERCHANTS[i % len(DINING_MERCHANTS)],
                "amount": amt,
                "type": "debit",
                "category": "Dining",
            })

        for i, amt in enumerate(_split_amount(rng, TRANSPORT_BUDGET[m_idx], 5)):
            rows.append({
                "date": at(3 + i * 5, 9, 0),
                "description": "Commute and travel",
                "merchant": TRANSPORT_MERCHANTS[i % len(TRANSPORT_MERCHANTS)],
                "amount": amt,
                "type": "debit",
                "category": "Transport",
            })

        for i, amt in enumerate(_split_amount(rng, SHOPPING_BUDGET[m_idx], 2)):
            rows.append({
                "date": at(10 + i * 11, 16, 45),
                "description": "Retail purchase",
                "merchant": SHOPPING_MERCHANTS[i % len(SHOPPING_MERCHANTS)],
                "amount": amt,
                "type": "debit",
                "category": "Shopping",
            })

        for day, merchant, amount, category, description in OCCASIONAL.get(m_idx, []):
            rows.append({
                "date": at(day, 13, 20),
                "description": description,
                "merchant": merchant,
                "amount": float(amount),
                "type": "debit",
                "category": category,
            })

    rows.sort(key=lambda r: r["date"])

    # Running balance, applied post-sort so opening + credits - debits == closing.
    balance = OPENING_BALANCE
    for r in rows:
        balance += r["amount"] if r["type"] == "credit" else -r["amount"]
        r["balance_after"] = round(balance, 2)

    return rows


def _build_csv(rows: list) -> bytes:
    """Renders the same ledger as a CSV stored on the document row, so the
    demo dataset has a downloadable source artefact like any real upload."""
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Date", "Description", "Merchant", "Category", "Debit", "Credit", "Balance"])
    for r in rows:
        w.writerow([
            r["date"].strftime("%Y-%m-%d"),
            r["description"],
            r["merchant"],
            r["category"],
            f'{r["amount"]:.2f}' if r["type"] == "debit" else "",
            f'{r["amount"]:.2f}' if r["type"] == "credit" else "",
            f'{r["balance_after"]:.2f}',
        ])
    return buf.getvalue().encode("utf-8")


def clear_demo_data(conn) -> None:
    """Removes ONLY the rows this script owns.

    Every statement is predicated on the demo account id or the demo document
    id. There is no TRUNCATE and no unpredicated DELETE anywhere in this file,
    so MoneyOps / Incident Lab data (payments, orders, refunds, webhooks,
    incidents, investigations, governed actions, audit logs) is never touched.

    Goals are cleared by ACCOUNT, not by the `fgoal_demo_` id prefix. Clearing
    by prefix left behind any goal a user had created by hand through the UI
    on the demo account, so a reseed produced the canonical three goals plus
    whatever strays existed — which is exactly how an unexpected extra goal
    ended up skewing the demo totals. Every goal on the demo account is demo
    data by definition, so the account is the correct boundary.
    """
    c = conn.cursor()
    c.execute("""
        DELETE FROM wealth_recommendations
        WHERE goal_id IN (SELECT goal_id FROM financial_goals WHERE account_id = %s)
           OR goal_id LIKE %s;
    """, (DEMO_ACCOUNT_ID, DEMO_GOAL_PREFIX + "%"))
    c.execute("DELETE FROM financial_goals WHERE account_id = %s OR goal_id LIKE %s;",
              (DEMO_ACCOUNT_ID, DEMO_GOAL_PREFIX + "%"))
    c.execute("DELETE FROM financial_transactions WHERE account_id = %s;", (DEMO_ACCOUNT_ID,))
    c.execute("DELETE FROM financial_document_chunks WHERE document_id = %s;", (DEMO_DOCUMENT_ID,))
    c.execute("DELETE FROM financial_documents WHERE document_id = %s;", (DEMO_DOCUMENT_ID,))
    c.execute("DELETE FROM financial_accounts WHERE account_id = %s;", (DEMO_ACCOUNT_ID,))
    conn.commit()
    c.close()


def seed(as_of: str = None, quiet: bool = False) -> dict:
    """Seeds the demo dataset and returns a summary. Idempotent."""
    init_db()

    if as_of:
        try:
            parsed = datetime.strptime(as_of, "%Y-%m")
        except ValueError:
            raise ValueError(f"--as-of must be YYYY-MM, got '{as_of}'")
        anchor_year, anchor_month = parsed.year, parsed.month
    else:
        anchor_year, anchor_month = _last_complete_month(datetime.now(timezone.utc))

    rows = build_transactions(anchor_year, anchor_month)
    csv_bytes = _build_csv(rows)
    now_str = datetime.now(timezone.utc).isoformat()

    conn = get_db_connection()
    clear_demo_data(conn)
    c = conn.cursor()

    c.execute("""
        INSERT INTO financial_accounts (account_id, name, institution, account_type, currency, metadata_json, created_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s);
    """, (
        DEMO_ACCOUNT_ID, "Alex Sharma — Primary Savings", "Meridian Bank", "bank", "INR",
        '{"source": "wealth_demo_seed", "synthetic": true}', now_str
    ))

    c.execute("""
        INSERT INTO financial_documents
            (document_id, filename, document_type, source, account_id, processing_status, uploaded_at, metadata_json, raw_content, content_type)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s);
    """, (
        DEMO_DOCUMENT_ID, "alex-sharma-bank-statement.csv", "bank_statement", "demo_seed",
        DEMO_ACCOUNT_ID, "ready", now_str,
        '{"source": "wealth_demo_seed", "synthetic": true}',
        psycopg2_binary(csv_bytes), "text/csv"
    ))

    for i, r in enumerate(rows):
        c.execute("""
            INSERT INTO financial_transactions
                (transaction_id, account_id, document_id, transaction_date, description, merchant,
                 amount, transaction_type, category, reference, balance_after, metadata_json, created_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s);
        """, (
            f"ftxn_demo_{i:04d}", DEMO_ACCOUNT_ID, DEMO_DOCUMENT_ID, r["date"].isoformat(),
            r["description"], r["merchant"], r["amount"], r["type"], r["category"],
            f"REF{i:06d}", r["balance_after"], '{"source": "wealth_demo_seed"}', now_str
        ))

    today = datetime.now(timezone.utc).date()
    for spec in GOAL_SPECS:
        target_date = today + timedelta(days=int(30.4375 * spec["months_out"]))
        c.execute("""
            INSERT INTO financial_goals
                (goal_id, account_id, goal_name, target_amount, current_amount, target_date, risk_preference, status, created_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, 'active', %s);
        """, (
            DEMO_GOAL_PREFIX + spec["suffix"], DEMO_ACCOUNT_ID, spec["goal_name"],
            spec["target_amount"], spec["current_amount"], target_date.isoformat(),
            spec["risk_preference"], now_str
        ))

    conn.commit()
    c.close()
    conn.close()

    credits = sum(r["amount"] for r in rows if r["type"] == "credit")
    debits = sum(r["amount"] for r in rows if r["type"] == "debit")
    closing = rows[-1]["balance_after"]
    reconciles = abs((OPENING_BALANCE + credits - debits) - closing) < 0.01

    summary = {
        "account_id": DEMO_ACCOUNT_ID,
        "months": MONTHS_OF_HISTORY,
        "first_month": rows[0]["date"].strftime("%Y-%m"),
        "last_month": rows[-1]["date"].strftime("%Y-%m"),
        "transactions": len(rows),
        "goals": len(GOAL_SPECS),
        "opening_balance": OPENING_BALANCE,
        "total_credits": round(credits, 2),
        "total_debits": round(debits, 2),
        "closing_balance": closing,
        "ledger_reconciles": reconciles,
    }

    if not quiet:
        print("Wealth Navigator demo data seeded")
        print(f"  account         : {summary['account_id']}")
        print(f"  history         : {summary['months']} complete months "
              f"({summary['first_month']} to {summary['last_month']})")
        print(f"  transactions    : {summary['transactions']}")
        print(f"  goals           : {summary['goals']}")
        print(f"  opening balance : Rs {summary['opening_balance']:,.2f}")
        print(f"  total credits   : Rs {summary['total_credits']:,.2f}")
        print(f"  total debits    : Rs {summary['total_debits']:,.2f}")
        print(f"  closing balance : Rs {summary['closing_balance']:,.2f}")
        print(f"  ledger reconciles: {summary['ledger_reconciles']}")

    if not reconciles:
        raise AssertionError("Ledger did not reconcile: opening + credits - debits != closing balance")

    return summary


def psycopg2_binary(data: bytes):
    """Wraps bytes for a BYTEA column without importing psycopg2 at module
    import time (keeps this script importable in environments that only need
    build_transactions for testing)."""
    import psycopg2
    return psycopg2.Binary(data)


def main():
    parser = argparse.ArgumentParser(description="Seed deterministic synthetic personal-finance demo data.")
    parser.add_argument("--as-of", dest="as_of", default=None,
                        help="Pin the most recent month of history, format YYYY-MM. "
                             "Defaults to the most recent complete calendar month.")
    parser.add_argument("--clear", action="store_true",
                        help="Remove the demo dataset and exit without reseeding.")
    parser.add_argument("--quiet", action="store_true", help="Suppress summary output.")
    args = parser.parse_args()

    if args.clear:
        init_db()
        conn = get_db_connection()
        clear_demo_data(conn)
        conn.close()
        print(f"Wealth Navigator demo data cleared (account {DEMO_ACCOUNT_ID}).")
        return

    seed(as_of=args.as_of, quiet=args.quiet)


if __name__ == "__main__":
    main()
