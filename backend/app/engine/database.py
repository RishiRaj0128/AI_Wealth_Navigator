import os
import re
import psycopg2
from psycopg2.extras import RealDictCursor
from typing import Optional
from app.core.config import settings

# Guards against exactly the mistake made twice in this project's development
# history: an ad-hoc debug script (run directly with `python -c` or similar,
# outside pytest — so tests/conftest.py's database-name redirect never fires)
# containing a blanket DELETE/TRUNCATE/DROP against the real dev database,
# wiping incident/investigation/audit history. This is a runtime guard, not
# just a comment: it inspects every statement executed against a non-`_test`
# database and refuses the destructive ones outright unless explicitly
# overridden. It only covers the core demo tables — eval_ground_truth's own
# idempotent re-seed (from fixed source-code scenario constants, never
# randomized) and other legitimate scoped operations are unaffected.
_GUARDED_TABLES = (
    "merchants", "orders", "payments", "refunds", "webhook_events",
    "incidents", "ai_investigations", "ai_investigation_steps",
    "governed_actions", "audit_logs", "incident_lab_runs", "incident_embeddings"
)
_DESTRUCTIVE_PATTERN = re.compile(
    r"\b(DELETE\s+FROM|TRUNCATE(\s+TABLE)?|DROP\s+TABLE)\b",
    re.IGNORECASE
)


class _GuardedCursor:
    """Wraps a real cursor; blocks unscoped destructive SQL against guarded
    tables on a non-test database unless MONEYOPS_ALLOW_DESTRUCTIVE_SQL=1."""

    def __init__(self, real_cursor, db_name: str):
        self._cursor = real_cursor
        self._db_name = db_name

    def execute(self, query, params=None):
        if not self._db_name.endswith("_test") and os.environ.get("MONEYOPS_ALLOW_DESTRUCTIVE_SQL") != "1":
            if _DESTRUCTIVE_PATTERN.search(query) and any(t in query.lower() for t in _GUARDED_TABLES):
                raise RuntimeError(
                    f"SAFETY GUARD: refusing to run a destructive statement against "
                    f"database '{self._db_name}' (not a '_test' database): {query.strip()[:200]!r}. "
                    f"If this is genuinely intended (e.g. a deliberately gated CLI --force-clean "
                    f"flow), set MONEYOPS_ALLOW_DESTRUCTIVE_SQL=1 for that process explicitly — "
                    f"never as a standing default. For exploratory/debug scripts, connect to the "
                    f"isolated '_test' database instead (see tests/conftest.py)."
                )
        return self._cursor.execute(query, params) if params is not None else self._cursor.execute(query)

    def __getattr__(self, name):
        return getattr(self._cursor, name)

    def __iter__(self):
        return iter(self._cursor)


class _GuardedConnection:
    """Wraps a real psycopg2 connection so every cursor() it hands out is guarded."""

    def __init__(self, real_conn, db_name: str):
        self._conn = real_conn
        self._db_name = db_name

    def cursor(self, *args, **kwargs):
        return _GuardedCursor(self._conn.cursor(*args, **kwargs), self._db_name)

    def __getattr__(self, name):
        return getattr(self._conn, name)


def get_db_connection():
    """Returns a guarded connection to the PostgreSQL database with RealDictCursor."""
    conn = psycopg2.connect(
        settings.DATABASE_URL,
        cursor_factory=RealDictCursor
    )
    db_name = settings.DATABASE_URL.rstrip("/").split("/")[-1].split("?")[0]
    return _GuardedConnection(conn, db_name)

def init_db():
    """Initializes the clean V2 9-table relational financial schema in PostgreSQL."""
    conn = get_db_connection()
    cursor = conn.cursor()

    # 1. Merchants Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS merchants (
        merchant_id VARCHAR(100) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        category VARCHAR(100) DEFAULT 'general',
        baseline_refund_rate DOUBLE PRECISION DEFAULT 0.015,
        created_at TIMESTAMPTZ NOT NULL
    );
    """)

    # 2. Orders Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS orders (
        order_id VARCHAR(100) PRIMARY KEY,
        merchant_id VARCHAR(100) NOT NULL REFERENCES merchants(merchant_id) ON DELETE CASCADE,
        amount DOUBLE PRECISION NOT NULL,
        currency VARCHAR(10) DEFAULT 'INR',
        status VARCHAR(50) NOT NULL,
        source VARCHAR(50) DEFAULT 'razorpay_test',
        created_at TIMESTAMPTZ NOT NULL,
        ingested_at TIMESTAMPTZ NOT NULL
    );
    """)

    # 3. Payments Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS payments (
        payment_id VARCHAR(100) PRIMARY KEY,
        order_id VARCHAR(100) REFERENCES orders(order_id) ON DELETE SET NULL,
        merchant_id VARCHAR(100) NOT NULL REFERENCES merchants(merchant_id) ON DELETE CASCADE,
        amount DOUBLE PRECISION NOT NULL,
        currency VARCHAR(10) DEFAULT 'INR',
        status VARCHAR(50) NOT NULL,
        method VARCHAR(50) DEFAULT 'card',
        gateway VARCHAR(100) DEFAULT 'Razorpay_Gateway',
        failure_code VARCHAR(50),
        error_description TEXT,
        retry_count INTEGER DEFAULT 0,
        source VARCHAR(50) DEFAULT 'razorpay_test',
        created_at TIMESTAMPTZ NOT NULL,
        captured_at TIMESTAMPTZ,
        ingested_at TIMESTAMPTZ NOT NULL
    );
    """)

    # 4. Refunds Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS refunds (
        refund_id VARCHAR(100) PRIMARY KEY,
        payment_id VARCHAR(100) NOT NULL REFERENCES payments(payment_id) ON DELETE CASCADE,
        merchant_id VARCHAR(100) NOT NULL REFERENCES merchants(merchant_id) ON DELETE CASCADE,
        amount DOUBLE PRECISION NOT NULL,
        currency VARCHAR(10) DEFAULT 'INR',
        status VARCHAR(50) NOT NULL,
        speed VARCHAR(50) DEFAULT 'normal',
        failure_reason TEXT,
        source VARCHAR(50) DEFAULT 'razorpay_test',
        created_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ,
        ingested_at TIMESTAMPTZ NOT NULL
    );
    """)

    # 5. Webhook Events Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS webhook_events (
        event_id VARCHAR(100) PRIMARY KEY,
        external_event_id VARCHAR(100) UNIQUE,
        event_type VARCHAR(100) NOT NULL,
        entity_id VARCHAR(100) NOT NULL,
        payload_json TEXT NOT NULL,
        signature_valid INTEGER DEFAULT 1,
        delivery_status VARCHAR(50) DEFAULT 'delivered',
        source VARCHAR(50) DEFAULT 'razorpay_test',
        received_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ
    );
    """)

    # 6. Incidents Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS incidents (
        incident_id VARCHAR(100) PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        type VARCHAR(100) NOT NULL,
        target_entity_type VARCHAR(50) DEFAULT 'gateway',
        target_entity_id VARCHAR(100),
        severity VARCHAR(50) NOT NULL,
        status VARCHAR(50) DEFAULT 'open',
        affected_merchants INTEGER DEFAULT 1,
        affected_payments INTEGER DEFAULT 1,
        potential_exposure DOUBLE PRECISION NOT NULL,
        anomaly_score DOUBLE PRECISION DEFAULT 0.85,
        primary_signal TEXT,
        evidence_json TEXT,
        source VARCHAR(50) DEFAULT 'razorpay_test',
        detected_at TIMESTAMPTZ NOT NULL,
        description TEXT NOT NULL
    );
    """)

    # Alter table if existing from earlier migration to guarantee new columns exist
    cursor.execute("ALTER TABLE incidents ADD COLUMN IF NOT EXISTS target_entity_type VARCHAR(50) DEFAULT 'gateway';")
    cursor.execute("ALTER TABLE incidents ADD COLUMN IF NOT EXISTS target_entity_id VARCHAR(100);")
    cursor.execute("ALTER TABLE incidents ADD COLUMN IF NOT EXISTS primary_signal TEXT;")
    cursor.execute("ALTER TABLE incidents ADD COLUMN IF NOT EXISTS evidence_json TEXT;")

    # investigation_status is orthogonal to `status` (open/resolved, the incident's
    # own lifecycle): 'not_investigated' -> 'investigating' -> 'investigated' or
    # 'investigation_failed'. Keeping it a separate column avoids turning `status`
    # into a combined lifecycle+investigation enum, which would have forced every
    # existing `status != 'resolved'` / `status == 'open'` check across the app to
    # be rewritten and risked a regression for no benefit to this fix.
    cursor.execute("ALTER TABLE incidents ADD COLUMN IF NOT EXISTS investigation_status VARCHAR(50) DEFAULT 'not_investigated';")

    # 7. AI Investigations Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS ai_investigations (
        investigation_id VARCHAR(100) PRIMARY KEY,
        incident_id VARCHAR(100) NOT NULL REFERENCES incidents(incident_id) ON DELETE CASCADE,
        provider VARCHAR(50) NOT NULL,
        model VARCHAR(100) NOT NULL,
        what_happened TEXT,
        why_it_happened TEXT,
        evidence_json TEXT,
        affected_entities_json TEXT,
        estimated_exposure DOUBLE PRECISION DEFAULT 0.0,
        historical_precedent TEXT,
        recommendation TEXT,
        confidence DOUBLE PRECISION DEFAULT 0.9,
        started_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        status VARCHAR(50) DEFAULT 'completed'
    );
    """)

    # Backfill investigation_status for rows that existed before that column did:
    # an incident with a real completed row in ai_investigations really has been
    # investigated. Must run after ai_investigations exists, not before.
    cursor.execute("""
        UPDATE incidents SET investigation_status = 'investigated'
        WHERE investigation_status = 'not_investigated'
          AND EXISTS (
              SELECT 1 FROM ai_investigations
              WHERE ai_investigations.incident_id = incidents.incident_id
                AND ai_investigations.status = 'completed'
          );
    """)

    # 8. AI Investigation Steps Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS ai_investigation_steps (
        step_id VARCHAR(100) PRIMARY KEY,
        investigation_id VARCHAR(100) NOT NULL REFERENCES ai_investigations(investigation_id) ON DELETE CASCADE,
        step_number INTEGER NOT NULL,
        tool_name VARCHAR(100) NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL
    );
    """)

    # 9. Governed Actions Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS governed_actions (
        action_id VARCHAR(100) PRIMARY KEY,
        incident_id VARCHAR(100) NOT NULL REFERENCES incidents(incident_id) ON DELETE CASCADE,
        investigation_id VARCHAR(100),
        action_type VARCHAR(100) NOT NULL,
        target_entity VARCHAR(100) NOT NULL,
        risk_level VARCHAR(20) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending_approval',
        reason TEXT NOT NULL,
        evidence_json TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        approved_by VARCHAR(100),
        approved_at TIMESTAMPTZ,
        executed_at TIMESTAMPTZ,
        execution_result_json TEXT
    );
    """)

    # 10. Audit Logs Table (Immutable Append-Only Log)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS audit_logs (
        audit_id VARCHAR(100) PRIMARY KEY,
        action_id VARCHAR(100),
        incident_id VARCHAR(100) NOT NULL REFERENCES incidents(incident_id) ON DELETE CASCADE,
        investigation_id VARCHAR(100),
        action_type VARCHAR(100) NOT NULL,
        previous_status VARCHAR(50),
        new_status VARCHAR(50) NOT NULL,
        actor VARCHAR(100) NOT NULL,
        reason TEXT,
        evidence_json TEXT,
        execution_result_json TEXT,
        timestamp TIMESTAMPTZ NOT NULL
    );
    """)

    # Alter audit_logs for columns added since its original schema version.
    cursor.execute("ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS action_id VARCHAR(100);")
    cursor.execute("ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS action_type VARCHAR(100);")
    cursor.execute("ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS previous_status VARCHAR(50);")
    cursor.execute("ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS new_status VARCHAR(50);")
    cursor.execute("ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS reason TEXT;")
    cursor.execute("ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS evidence_json TEXT;")
    cursor.execute("ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS execution_result_json TEXT;")

    # These three columns only exist on databases upgraded from an older schema
    # version; a freshly created audit_logs table never has them, so guard each
    # ALTER so init_db() stays idempotent on both fresh and upgraded databases.
    for legacy_column in ("action_name", "action_tier", "approval_status"):
        cursor.execute(f"""
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'audit_logs' AND column_name = '{legacy_column}'
                ) THEN
                    ALTER TABLE audit_logs ALTER COLUMN {legacy_column} DROP NOT NULL;
                END IF;
            END $$;
        """)

    # 11. Evaluation Ground Truth Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS eval_ground_truth (
        evaluation_id VARCHAR(100) PRIMARY KEY,
        scenario_id VARCHAR(100) NOT NULL,
        scenario_type VARCHAR(100) NOT NULL,
        entity_type VARCHAR(50) NOT NULL,
        entity_id VARCHAR(100) NOT NULL,
        expected_anomaly BOOLEAN NOT NULL,
        expected_detection VARCHAR(50) NOT NULL,
        severity VARCHAR(50) NOT NULL,
        seed INTEGER NOT NULL,
        anomaly_magnitude DOUBLE PRECISION,
        detected_incident_id VARCHAR(100),
        is_true_positive BOOLEAN,
        is_false_positive BOOLEAN,
        is_false_negative BOOLEAN,
        is_true_negative BOOLEAN,
        miss_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        metadata_json TEXT
    );
    """)

    # 12b. Incident Lab Runs — one row per generate_dataset() call, so a specific
    # varied simulation run can be identified and regenerated by its seed.
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS incident_lab_runs (
        run_id VARCHAR(100) PRIMARY KEY,
        seed INTEGER NOT NULL,
        anomaly_type VARCHAR(100) NOT NULL,
        target_entity_type VARCHAR(50),
        target_entity_id VARCHAR(100),
        severity_magnitude DOUBLE PRECISION,
        num_payments INTEGER NOT NULL,
        anomalous_events_count INTEGER NOT NULL,
        generated_at TIMESTAMPTZ NOT NULL
    );
    """)

    # 12. Incident Embeddings Table (for Case Memory cosine similarity)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS incident_embeddings (
        incident_id VARCHAR(100) PRIMARY KEY REFERENCES incidents(incident_id) ON DELETE CASCADE,
        embedding_vector TEXT NOT NULL,
        content_text TEXT,
        model_name VARCHAR(100) DEFAULT 'deterministic-semantic-vector',
        created_at TIMESTAMPTZ NOT NULL
    );
    """)

    cursor.execute("ALTER TABLE incidents ADD COLUMN IF NOT EXISTS embedding_json TEXT;")

    # =========================================================================
    # FINANCIAL INTELLIGENCE COPILOT (Phase G) — independent of the MoneyOps
    # incident-investigation tables above. A separate, self-contained schema
    # for user-uploaded financial documents/transactions and Gemini-grounded
    # Q&A over them, deliberately not reusing payments/orders/refunds (those
    # model Razorpay/Incident Lab payment-lifecycle events, not arbitrary
    # user-uploaded statement line items with a different shape/provenance).
    # =========================================================================

    # 13. Financial Accounts Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS financial_accounts (
        account_id VARCHAR(100) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        institution VARCHAR(255),
        account_type VARCHAR(50) DEFAULT 'bank',
        currency VARCHAR(10) DEFAULT 'INR',
        metadata_json TEXT,
        created_at TIMESTAMPTZ NOT NULL
    );
    """)

    # 14. Financial Documents Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS financial_documents (
        document_id VARCHAR(100) PRIMARY KEY,
        filename VARCHAR(255) NOT NULL,
        document_type VARCHAR(50) NOT NULL,
        source VARCHAR(50) DEFAULT 'user_upload',
        account_id VARCHAR(100) REFERENCES financial_accounts(account_id) ON DELETE SET NULL,
        processing_status VARCHAR(50) DEFAULT 'processing',
        error_message TEXT,
        uploaded_at TIMESTAMPTZ NOT NULL,
        metadata_json TEXT,
        raw_content BYTEA,
        content_type VARCHAR(100)
    );
    """)
    # Original uploaded file bytes, so Preview/Download can serve the real
    # source document rather than only the extracted structured data.
    cursor.execute("ALTER TABLE financial_documents ADD COLUMN IF NOT EXISTS raw_content BYTEA;")
    cursor.execute("ALTER TABLE financial_documents ADD COLUMN IF NOT EXISTS content_type VARCHAR(100);")

    # 15. Financial Document Chunks Table (RAG layer — real Gemini embeddings,
    # stored as JSON since pgvector is not installed on this Postgres instance;
    # ranked with in-process cosine similarity, same proven pattern already
    # used by incident_embeddings/case_memory.py).
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS financial_document_chunks (
        chunk_id VARCHAR(100) PRIMARY KEY,
        document_id VARCHAR(100) NOT NULL REFERENCES financial_documents(document_id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding_json TEXT,
        page_number INTEGER,
        section VARCHAR(255),
        metadata_json TEXT
    );
    """)

    # 16. Financial Transactions Table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS financial_transactions (
        transaction_id VARCHAR(100) PRIMARY KEY,
        account_id VARCHAR(100) REFERENCES financial_accounts(account_id) ON DELETE SET NULL,
        document_id VARCHAR(100) REFERENCES financial_documents(document_id) ON DELETE CASCADE,
        transaction_date TIMESTAMPTZ NOT NULL,
        description TEXT,
        merchant VARCHAR(255),
        amount DOUBLE PRECISION NOT NULL,
        transaction_type VARCHAR(20) NOT NULL,
        category VARCHAR(100),
        reference VARCHAR(255),
        balance_after DOUBLE PRECISION,
        metadata_json TEXT,
        created_at TIMESTAMPTZ NOT NULL
    );
    """)

    # 17. Financial Analysis Runs Table (Copilot auditability — deliberately
    # separate from audit_logs, whose incident_id column is NOT NULL/FK'd to
    # incidents; most Copilot queries aren't incident-scoped at all).
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS financial_analysis_runs (
        run_id VARCHAR(100) PRIMARY KEY,
        query TEXT NOT NULL,
        tools_called_json TEXT,
        retrieved_evidence_json TEXT,
        model VARCHAR(100),
        response_json TEXT,
        created_at TIMESTAMPTZ NOT NULL
    );
    """)

    # 18. Financial Goals Table (Wealth Navigator personal goals)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS financial_goals (
        goal_id VARCHAR(100) PRIMARY KEY,
        account_id VARCHAR(100) REFERENCES financial_accounts(account_id) ON DELETE CASCADE,
        goal_name VARCHAR(255) NOT NULL,
        target_amount DOUBLE PRECISION NOT NULL,
        current_amount DOUBLE PRECISION DEFAULT 0,
        target_date DATE,
        risk_preference VARCHAR(20) DEFAULT 'moderate',
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL
    );
    """)

    # 19. Wealth Recommendations Table (Auditability for projections & advice)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS wealth_recommendations (
        recommendation_id VARCHAR(100) PRIMARY KEY,
        goal_id VARCHAR(100) REFERENCES financial_goals(goal_id) ON DELETE SET NULL,
        query TEXT,
        tools_called_json TEXT,
        assumptions_json TEXT,
        recommendation_json TEXT,
        model VARCHAR(100),
        created_at TIMESTAMPTZ NOT NULL
    );
    """)

    cursor.execute("CREATE INDEX IF NOT EXISTS idx_fin_txn_account ON financial_transactions(account_id);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_fin_txn_date ON financial_transactions(transaction_date);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_fin_txn_merchant ON financial_transactions(merchant);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_fin_chunks_document ON financial_document_chunks(document_id);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_fin_goals_account ON financial_goals(account_id);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_fin_goals_status ON financial_goals(status);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_wealth_recs_goal ON wealth_recommendations(goal_id);")

    # Indexes
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_payments_merchant ON payments(merchant_id);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_payments_gateway ON payments(gateway);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_payments_source ON payments(source);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_refunds_payment ON refunds(payment_id);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_webhooks_external_id ON webhook_events(external_event_id);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_incidents_entity ON incidents(target_entity_type, target_entity_id);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_actions_incident ON governed_actions(incident_id);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_actions_status ON governed_actions(status);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action_id);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_eval_scenario ON eval_ground_truth(scenario_id);")


    conn.commit()
    cursor.close()
    conn.close()

if __name__ == "__main__":
    init_db()
    print("PostgreSQL schema initialized successfully.")
