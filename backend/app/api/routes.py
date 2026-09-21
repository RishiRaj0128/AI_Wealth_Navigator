import json
import uuid
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional
from pydantic import BaseModel
from fastapi import APIRouter, HTTPException, Request, Header, UploadFile, File, Form
from app.core.config import settings
from app.engine.database import get_db_connection
from app.engine.pipeline import CanonicalEvent, IngestionPipeline
from app.engine.webhook_service import webhook_service
from app.engine.incident_lab import IncidentLabGenerator
from app.engine.anomaly_detector import anomaly_detector
from app.integrations.razorpay.client import razorpay_client
from app.integrations.razorpay.mapper import RazorpayMapper
from app.integrations.razorpay.exceptions import RazorpayAuthError
from app.engine.gemini_agent import gemini_agent
from app.engine.action_governor import action_governor
from app.engine.batch_evaluator import batch_evaluator
from app.engine.document_ingestion import DocumentIngestionPipeline
from app.engine.financial_copilot_agent import financial_copilot_agent
from app.engine.financial_tools import FinancialTools
from app.models.schemas import CreateGoalRequest, UpdateGoalRequest, SimulateScenarioRequest

router = APIRouter()


# =============================================================================
# HEALTH & SYSTEM STATUS
# =============================================================================

@router.get("/health")
def get_health():
    """Real health, not a constant.

    This previously returned status "healthy" unconditionally without ever
    touching PostgreSQL, so the UI's connection indicator could not actually
    go red when the database was down. It now runs a trivial `SELECT 1` and
    reports what it observed.

    The original keys (`status`, `database`, `razorpay_configured`,
    `gemini_configured`) are preserved verbatim so existing callers and the
    legacy operations screens keep working; the newer `backend`/`ai` fields
    are what the Wealth Navigator status indicators read.
    """
    database_online = False
    database_error = None
    try:
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("SELECT 1;")
        c.fetchone()
        c.close()
        conn.close()
        database_online = True
    except Exception as e:
        database_error = str(e)[:200]

    ai_configured = bool(
        settings.GEMINI_API_KEY
        and not settings.GEMINI_API_KEY.startswith("YOUR_")
        and len(settings.GEMINI_API_KEY) > 10
    )

    return {
        # Legacy contract — unchanged shape, now reflecting real state.
        "status": "healthy" if database_online else "degraded",
        "app": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "database": "PostgreSQL",
        "razorpay_configured": razorpay_client.is_configured,
        "ai_provider": settings.AI_PROVIDER,
        "gemini_configured": ai_configured,
        # Explicit tri-state the frontend status indicators consume.
        "backend": "online",
        "database_status": "online" if database_online else "offline",
        "database_error": database_error,
        "ai": "configured" if ai_configured else "not_configured",
    }

# =============================================================================
# DATA OBSERVABILITY & STATISTICS (POSTGRESQL-DERIVED)
# =============================================================================

@router.get("/stats")
def get_database_stats():
    """
    Returns actual row counts and status derived directly from PostgreSQL.
    Zero synthetic or hardcoded metrics.
    """
    conn = get_db_connection()
    c = conn.cursor()
    
    c.execute("SELECT COUNT(*) as cnt FROM merchants;")
    merchants_cnt = c.fetchone()["cnt"]
    
    c.execute("SELECT COUNT(*) as cnt FROM orders;")
    orders_cnt = c.fetchone()["cnt"]
    
    c.execute("SELECT COUNT(*) as cnt FROM payments;")
    payments_cnt = c.fetchone()["cnt"]
    
    c.execute("SELECT COUNT(*) as cnt FROM refunds;")
    refunds_cnt = c.fetchone()["cnt"]
    
    c.execute("SELECT COUNT(*) as cnt FROM webhook_events;")
    webhooks_cnt = c.fetchone()["cnt"]
    
    c.execute("SELECT COUNT(*) as cnt FROM incidents;")
    incidents_cnt = c.fetchone()["cnt"]
    
    c.close()
    conn.close()

    return {
        "database": "PostgreSQL (moneyops_v2)",
        "merchants": merchants_cnt,
        "orders": orders_cnt,
        "payments": payments_cnt,
        "refunds": refunds_cnt,
        "webhook_events": webhooks_cnt,
        "incidents": incidents_cnt,
        "timestamp": datetime.utcnow().isoformat()
    }

@router.get("/stats/sources")
def get_source_distribution():
    """
    Returns real breakdown of records by provenance source:
    - 'razorpay_test' (Live REST API)
    - 'razorpay_webhook' (Live Webhooks)
    - 'incident_lab' (Controlled Laboratory Generator)
    """
    conn = get_db_connection()
    c = conn.cursor()

    c.execute("SELECT source, COUNT(*) as count FROM payments GROUP BY source ORDER BY count DESC;")
    payments_by_source = {r["source"]: r["count"] for r in c.fetchall()}

    c.execute("SELECT source, COUNT(*) as count FROM payments WHERE status = 'captured' GROUP BY source ORDER BY count DESC;")
    payments_captured_by_source = {r["source"]: r["count"] for r in c.fetchall()}

    c.execute("SELECT source, COUNT(*) as count FROM orders GROUP BY source ORDER BY count DESC;")
    orders_by_source = {r["source"]: r["count"] for r in c.fetchall()}

    c.execute("SELECT source, COUNT(*) as count FROM refunds GROUP BY source ORDER BY count DESC;")
    refunds_by_source = {r["source"]: r["count"] for r in c.fetchall()}

    c.execute("SELECT source, COUNT(*) as count FROM webhook_events GROUP BY source ORDER BY count DESC;")
    webhooks_by_source = {r["source"]: r["count"] for r in c.fetchall()}

    c.close()
    conn.close()

    from app.engine.anomaly_detector import anomaly_detector
    real_payment_volume = payments_by_source.get("razorpay_test", 0)

    return {
        "payments": payments_by_source,
        "payments_captured": payments_captured_by_source,
        "orders": orders_by_source,
        "refunds": refunds_by_source,
        "webhooks": webhooks_by_source,
        "detection_volume": {
            "min_sample_size": anomaly_detector.MIN_SAMPLE_SIZE,
            "razorpay_test_payment_count": real_payment_volume,
            "razorpay_test_sufficient_for_detection": real_payment_volume >= anomaly_detector.MIN_SAMPLE_SIZE
        }
    }

# =============================================================================
# RAZORPAY TEST MODE REST INGESTION (ADAPTER -> CANONICAL PIPELINE)
# =============================================================================

@router.post("/razorpay/sync")
def sync_razorpay_data():
    """
    Calls official Razorpay REST APIs, maps entities into CanonicalEvents (source='razorpay_test'),
    and pushes them through the unified IngestionPipeline into PostgreSQL.
    """
    if not razorpay_client.is_configured:
        return {
            "status": "credentials_required",
            "message": "Razorpay API credentials not configured. Please set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env.",
            "configured": False,
            "orders_fetched": 0,
            "payments_fetched": 0,
            "refunds_fetched": 0
        }

    try:
        # 1. Fetch from Razorpay Test Mode APIs (paginated up to 500 records)
        orders = razorpay_client.fetch_all_orders(max_items=500)
        payments = razorpay_client.fetch_all_payments(max_items=500)
        refunds = razorpay_client.fetch_all_refunds(max_items=500)


        # 2. Convert to CanonicalEvents
        canonical_events: List[CanonicalEvent] = []
        for o in orders:
            canonical_events.append(RazorpayMapper.order_to_canonical(o, source="razorpay_test"))
        for p in payments:
            canonical_events.append(RazorpayMapper.payment_to_canonical(p, source="razorpay_test"))
        for r in refunds:
            canonical_events.append(RazorpayMapper.refund_to_canonical(r, source="razorpay_test"))

        # 3. Route Through Shared IngestionPipeline
        ingest_stats = IngestionPipeline.ingest_batch(canonical_events)

        return {
            "status": "success",
            "source": "razorpay_test",
            "database": "PostgreSQL",
            "configured": True,
            "orders_fetched": len(orders),
            "payments_fetched": len(payments),
            "refunds_fetched": len(refunds),
            "orders_upserted": ingest_stats["orders"],
            "payments_upserted": ingest_stats["payments"],
            "refunds_upserted": ingest_stats["refunds"]
        }
    except RazorpayAuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Synchronization failed: {str(e)}")

# =============================================================================
# RAZORPAY WEBHOOK INGESTION (ADAPTER -> CANONICAL PIPELINE)
# =============================================================================

@router.post("/webhooks/razorpay")
async def ingest_razorpay_webhook(
    request: Request,
    x_razorpay_signature: Optional[str] = Header(None, alias="X-Razorpay-Signature"),
    x_razorpay_event_id: Optional[str] = Header(None, alias="X-Razorpay-Event-Id")
):
    """
    Ingests real Razorpay Test Mode webhooks.
    Validates HMAC-SHA256, enforces idempotency, maps to CanonicalEvents (source='razorpay_webhook'),
    and routes through the shared IngestionPipeline.
    """
    raw_body = await request.body()
    return webhook_service.process_webhook(
        raw_body=raw_body,
        signature=x_razorpay_signature,
        header_event_id=x_razorpay_event_id
    )

# =============================================================================
# INCIDENT LAB INGESTION (GENERATOR -> CANONICAL PIPELINE)
# =============================================================================

class GenerateLabRequest(BaseModel):
    seed: Optional[int] = None
    # 500, not 250: empirically, at 250 payments/batch a single-scenario injection
    # rarely carries enough absolute signal to clear the Wilson-bound significance
    # floor once diluted into the accumulated cross-batch population — gateway
    # incidents in particular almost never fired at the old default, which is why
    # every real demo run kept surfacing the same one or two merchant incidents
    # regardless of which scenario a given batch actually injected.
    payments: int = 800
    merchants: int = 10
    anomaly: str = "auto"  # "auto" (random each run), "none", or one of SCENARIO_TYPES

# A demo generation is only useful if it reliably surfaces something to
# investigate. Detection is a global, statistical re-evaluation of the whole
# accumulated incident_lab + real dataset (not just the batch just generated),
# so "guarantee 3-7 anomalies" can only be honestly pursued by generating a
# batch, running the SAME real detector against the now-updated data, and
# retrying with a fresh random seed/scenario when the result lands outside
# the target band — never by fabricating incident rows after the fact.
MIN_TARGET_INCIDENTS = 3
MAX_TARGET_INCIDENTS = 7
MAX_GENERATION_ATTEMPTS = 5

@router.post("/incident-lab/generate")
def generate_incident_lab_data(req: GenerateLabRequest):
    """
    Generates reproducible financial lifecycle events, routes them through the
    shared IngestionPipeline with source='incident_lab', then runs the real
    anomaly detector against the resulting dataset so the response already
    reflects Overview/Investigation's post-detection state (single source of
    truth — no separate frontend-only detection step required).

    When the caller leaves `anomaly` at its default ("auto"), a batch that
    yields fewer than MIN_TARGET_INCIDENTS open incidents is retried (fresh
    random seed, up to MAX_GENERATION_ATTEMPTS total attempts) so a normal
    "Generate New Data" click reliably produces something demoable. An
    explicit anomaly type/seed is respected as a single deterministic
    generation — no retry — so reproducibility for that caller isn't broken.
    """
    try:
        import random as _random
        is_auto = req.anomaly in ("auto", "random")
        allow_retry = is_auto and req.seed is None
        max_attempts = MAX_GENERATION_ATTEMPTS if allow_retry else 1

        last_generation = None
        last_detection = None
        attempts_made = 0
        cumulative = {"orders_ingested": 0, "payments_ingested": 0, "refunds_ingested": 0, "webhooks_ingested": 0}

        for attempt in range(1, max_attempts + 1):
            attempts_made = attempt
            seed = req.seed if req.seed is not None else _random.randint(1, 999_999)
            last_generation = IncidentLabGenerator.generate_dataset(
                seed=seed,
                num_payments=req.payments,
                num_merchants=req.merchants,
                anomaly_type=req.anomaly
            )
            for k in cumulative:
                cumulative[k] += last_generation.get(k, 0)

            last_detection = anomaly_detector.run_detection()
            incident_count = last_detection.get("anomalies_detected", 0)

            if not allow_retry:
                break
            if MIN_TARGET_INCIDENTS <= incident_count <= MAX_TARGET_INCIDENTS:
                break
            if incident_count > MAX_TARGET_INCIDENTS:
                # More data can only add further anomalous entities, never
                # remove already-open ones — retrying would just overshoot
                # further, so accept this attempt's result as final.
                break
            # else: below the floor — retry with a fresh seed/scenario draw.

        response = dict(last_generation)
        response.update(cumulative)
        response["generation_attempts"] = attempts_made
        response["detection"] = last_detection
        response["anomalies_detected"] = last_detection.get("anomalies_detected", 0) if last_detection else 0
        response["incidents"] = last_detection.get("incidents", []) if last_detection else []
        return response
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Incident Lab generation failed: {str(e)}")

@router.get("/incident-lab/runs")
def list_incident_lab_runs(limit: int = 10):
    """Lists recent Incident Lab generation runs (seed, scenario, target) for reproducibility."""
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT * FROM incident_lab_runs ORDER BY generated_at DESC LIMIT %s;", (limit,))
    rows = c.fetchall()
    c.close()
    conn.close()
    return [dict(r) for r in rows]


def _fetch_incident_lab_payments(limit: Optional[int] = None) -> List[Dict[str, Any]]:
    """
    The single source of truth for 'the currently generated dataset': every
    payment tagged source='incident_lab', joined with its order/merchant and
    any refunds — the same rows the Data page's Payments/Refunds tables draw
    their (cumulative) provenance totals from. Used by both the XLSX export
    and the Financial Copilot ingestion path so neither can silently drift
    from what the Data page actually represents.

    `limit`, when given, returns only the most recently INGESTED rows
    (ingested_at — the real wall-clock insert time, unlike the backdated
    simulated `created_at`) rather than the full cross-batch history. Incident
    Lab has no persisted batch/run identifier on individual payment rows, so
    "most recently ingested N" is the closest honest proxy for "the batch
    just generated" without inventing one. Used by the Copilot ingestion path
    (embedding every accumulated batch ever generated is neither a
    reasonable interpretation of "ingest this dataset" nor fast/affordable);
    left unset by the full-history XLSX export, which is meant to mirror the
    Data page's cumulative totals exactly.
    """
    conn = get_db_connection()
    c = conn.cursor()
    order = "p.ingested_at DESC" if limit else "p.created_at ASC"
    limit_clause = "LIMIT %s" if limit else ""
    params = (limit,) if limit else ()
    c.execute(f"""
        SELECT p.payment_id, p.order_id, p.merchant_id, m.name as merchant_name,
               p.amount, p.currency, p.status, p.method, p.gateway,
               p.failure_code, p.error_description, p.source, p.created_at,
               (SELECT COUNT(*) FROM refunds r WHERE r.payment_id = p.payment_id) as refund_count,
               (SELECT COALESCE(SUM(r.amount), 0) FROM refunds r WHERE r.payment_id = p.payment_id) as refunded_amount
        FROM payments p
        LEFT JOIN merchants m ON m.merchant_id = p.merchant_id
        WHERE p.source = 'incident_lab'
        ORDER BY {order}
        {limit_clause};
    """, params)
    rows = [dict(r) for r in c.fetchall()]
    c.close()
    conn.close()
    if limit:
        rows.sort(key=lambda r: r["created_at"])
    return rows


@router.get("/incident-lab/export")
def export_incident_lab_data():
    """
    Downloads the currently generated Incident Lab dataset (source=
    'incident_lab' payments, the same rows shown on the Data page) as an
    Excel-compatible .xlsx file — real generated data, never placeholder rows.
    """
    import pandas as pd
    from io import BytesIO
    from fastapi.responses import StreamingResponse

    rows = _fetch_incident_lab_payments()
    if not rows:
        raise HTTPException(status_code=404, detail="No Incident Lab dataset has been generated yet — click \"Generate new data\" first.")

    df = pd.DataFrame([{
        "Payment ID": r["payment_id"],
        "Order ID": r["order_id"],
        "Merchant ID": r["merchant_id"],
        "Merchant": r["merchant_name"],
        "Amount": r["amount"],
        "Currency": r["currency"],
        "Status": r["status"],
        "Method": r["method"],
        "Gateway": r["gateway"],
        "Failure Code": r["failure_code"],
        "Refund Count": r["refund_count"],
        "Refunded Amount": r["refunded_amount"],
        # Excel has no timezone-aware datetime type — strip tzinfo (the
        # underlying value stays in UTC, just without the offset Excel
        # rejects) rather than silently dropping the column.
        "Date": r["created_at"].replace(tzinfo=None) if hasattr(r["created_at"], "replace") else r["created_at"],
    } for r in rows])

    buf = BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name="Incident Lab Data")
    buf.seek(0)

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="moneyops-financial-data.xlsx"'}
    )


# Every row here costs one real Gemini embedding call inside
# DocumentIngestionPipeline (~20 rows/chunk). Capped to the most recently
# generated batch (the default "Generate new data" size), not Incident Lab's
# full cross-session accumulated history — thousands of chunks would make
# "Ingest into Financial Copilot" take minutes and burn API quota for no
# demo-relevant benefit, since Copilot questions target "this dataset", not
# every batch ever generated in this database's lifetime.
COPILOT_INGEST_ROW_LIMIT = 800

@router.post("/incident-lab/ingest-to-copilot")
def ingest_incident_lab_to_copilot():
    """
    Sends the currently generated Incident Lab dataset into the Financial
    Copilot without a manual download/re-upload round trip. Builds a CSV of
    the most recently generated batch of rows (see COPILOT_INGEST_ROW_LIMIT),
    then routes it through the EXISTING document ingestion pipeline
    (DocumentIngestionPipeline — the same extract/chunk/embed path a manually
    uploaded CSV goes through), so Copilot's RAG/SQL tools can answer
    questions about it exactly as they would for any uploaded document. No
    separate ingestion system.
    """
    import csv
    from io import StringIO

    rows = _fetch_incident_lab_payments(limit=COPILOT_INGEST_ROW_LIMIT)
    if not rows:
        raise HTTPException(status_code=404, detail="No Incident Lab dataset has been generated yet — click \"Generate new data\" first.")

    buf = StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Date", "Description", "Merchant", "Amount", "Reference", "Transaction Type"])
    for r in rows:
        is_failed = r["status"] == "failed"
        desc = f"{r['gateway']} payment via {r['method']}" + (f" — failed ({r['failure_code']})" if is_failed else " — captured")
        writer.writerow([
            r["created_at"], desc, r["merchant_name"] or r["merchant_id"],
            r["amount"], r["payment_id"], "debit" if is_failed else "credit"
        ])
    raw_bytes = buf.getvalue().encode("utf-8")

    result = DocumentIngestionPipeline.ingest(
        filename="incident-lab-dataset.csv",
        raw_bytes=raw_bytes,
        document_type="transaction_csv",
        account_id=None
    )
    return result

# =============================================================================
# ML ANOMALY DETECTION (PHASE B)
# =============================================================================

@router.post("/anomalies/detect")
def trigger_anomaly_detection():
    """
    Triggers IsolationForest unsupervised anomaly detection on PostgreSQL features.
    Creates or updates detected incidents in PostgreSQL.
    """
    try:
        result = anomaly_detector.run_detection()
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Anomaly detection failed: {str(e)}")

@router.get("/anomalies/evaluation")
def get_gateway_evaluation():
    """
    Read-only per-gateway evaluation — sample size, Wilson lower bound, whether it
    clears both statistical guardrails — with zero database writes. Exists so a
    gateway that's below the confidence threshold is visible somewhere real
    (Overview page) instead of only being silently excluded from Active Incidents,
    and so this doesn't require clicking "Run Anomaly Scan" (which does write).
    """
    try:
        evaluations = anomaly_detector.evaluate_gateways()
        return {
            "min_sample_size": anomaly_detector.MIN_SAMPLE_SIZE,
            "min_failure_rate_pct": anomaly_detector.MIN_FAILURE_RATE * 100,
            "evaluations": evaluations,
            "below_confidence_threshold": [g for g in evaluations if g["below_confidence_threshold"]]
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Gateway evaluation failed: {str(e)}")

# =============================================================================
# DATA ENTITY QUERY ENDPOINTS (POSTGRESQL)
# =============================================================================

@router.get("/payments")
def list_payments(limit: int = 50, source: Optional[str] = None):
    """Retrieves persisted payments from PostgreSQL."""
    conn = get_db_connection()
    cursor = conn.cursor()
    if source:
        cursor.execute("SELECT * FROM payments WHERE source = %s ORDER BY created_at DESC LIMIT %s;", (source, limit))
    else:
        cursor.execute("SELECT * FROM payments ORDER BY created_at DESC LIMIT %s;", (limit,))
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    return [dict(r) for r in rows]

@router.get("/orders")
def list_orders(limit: int = 50, source: Optional[str] = None):
    """Retrieves persisted orders from PostgreSQL."""
    conn = get_db_connection()
    cursor = conn.cursor()
    if source:
        cursor.execute("SELECT * FROM orders WHERE source = %s ORDER BY created_at DESC LIMIT %s;", (source, limit))
    else:
        cursor.execute("SELECT * FROM orders ORDER BY created_at DESC LIMIT %s;", (limit,))
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    return [dict(r) for r in rows]

@router.get("/refunds")
def list_refunds(limit: int = 50, source: Optional[str] = None):
    """Retrieves persisted refunds from PostgreSQL."""
    conn = get_db_connection()
    cursor = conn.cursor()
    if source:
        cursor.execute("SELECT * FROM refunds WHERE source = %s ORDER BY created_at DESC LIMIT %s;", (source, limit))
    else:
        cursor.execute("SELECT * FROM refunds ORDER BY created_at DESC LIMIT %s;", (limit,))
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    return [dict(r) for r in rows]

@router.get("/webhooks")
def list_webhooks(limit: int = 50):
    """Retrieves persisted webhook events from PostgreSQL."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM webhook_events ORDER BY received_at DESC LIMIT %s;", (limit,))
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    return [dict(r) for r in rows]

@router.get("/incidents")
def list_incidents():
    """Retrieves all active and historical incidents from PostgreSQL."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM incidents ORDER BY detected_at DESC;")
    rows = cursor.fetchall()
    cursor.close()
    conn.close()
    
    results = []
    for r in rows:
        d = dict(r)
        if d.get("evidence_json"):
            try:
                d["evidence"] = json.loads(d["evidence_json"])
            except Exception:
                d["evidence"] = None
        results.append(d)
    return results

@router.get("/incidents/{incident_id}")
def get_incident(incident_id: str):
    """Retrieves a single incident by ID from PostgreSQL."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM incidents WHERE incident_id = %s;", (incident_id,))
    row = cursor.fetchone()
    cursor.close()
    conn.close()
    
    if not row:
        raise HTTPException(status_code=404, detail=f"Incident '{incident_id}' not found")
    
    d = dict(row)
    if d.get("evidence_json"):
        try:
            d["evidence"] = json.loads(d["evidence_json"])
        except Exception:
            d["evidence"] = None
    return d

# =============================================================================
# REAL AI INVESTIGATION (PHASE C — GEMINI TOOL CALLING)
# =============================================================================

@router.get("/ai/status")
def get_ai_status():
    """Returns the Gemini AI provider configuration status."""
    return gemini_agent.get_status()

@router.post("/incidents/{incident_id}/investigate")
def run_ai_investigation(incident_id: str):
    """
    Executes a real multi-turn Gemini investigation against PostgreSQL.
    Allows Gemini to call tools, query data, and store an auditable forensic report.
    """
    result = gemini_agent.investigate_incident(incident_id)
    if result.get("status") == "error":
        err_code = result.get("error_code")
        if err_code == "AI_NOT_CONFIGURED":
            raise HTTPException(status_code=400, detail={
                "error_code": "AI_NOT_CONFIGURED",
                "message": "Gemini API key is not configured. Please set GEMINI_API_KEY in .env."
            })
        elif err_code == "INCIDENT_NOT_FOUND":
            raise HTTPException(status_code=404, detail=f"Incident '{incident_id}' not found.")
        elif err_code == "AI_AUTHENTICATION_FAILED":
            raise HTTPException(status_code=401, detail={
                "error_code": "AI_AUTHENTICATION_FAILED",
                "message": "Gemini API key authentication failed."
            })
        else:
            raise HTTPException(status_code=500, detail=result)
    return result

@router.get("/investigations/{investigation_id}")
def get_investigation(investigation_id: str):
    """Retrieves an investigation record from PostgreSQL."""
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT * FROM ai_investigations WHERE investigation_id = %s;", (investigation_id,))
    row = c.fetchone()
    c.close()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail=f"Investigation '{investigation_id}' not found")

    d = dict(row)
    if d.get("evidence_json"):
        try:
            d["evidence"] = json.loads(d["evidence_json"])
        except Exception:
            pass
    if d.get("affected_entities_json"):
        try:
            d["affected_entities"] = json.loads(d["affected_entities_json"])
        except Exception:
            pass
    return d

@router.get("/investigations/{investigation_id}/steps")
def get_investigation_steps(investigation_id: str):
    """Retrieves all forensic tool calling steps for an investigation from PostgreSQL."""
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT * FROM ai_investigation_steps WHERE investigation_id = %s ORDER BY step_number ASC;", (investigation_id,))
    rows = c.fetchall()
    c.close()
    conn.close()

    steps = []
    for r in rows:
        d = dict(r)
        if d.get("input_json"):
            try:
                d["arguments"] = json.loads(d["input_json"])
            except Exception:
                d["arguments"] = d["input_json"]
        if d.get("output_json"):
            try:
                d["result"] = json.loads(d["output_json"])
            except Exception:
                d["result"] = d["output_json"]
        steps.append(d)
    return steps

@router.get("/incidents/{incident_id}/investigations")
def list_incident_investigations(incident_id: str):
    """Lists all historical AI investigations associated with an incident."""
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT * FROM ai_investigations WHERE incident_id = %s ORDER BY started_at DESC;", (incident_id,))
    rows = c.fetchall()
    c.close()
    conn.close()

    results = []
    for r in rows:
        d = dict(r)
        if d.get("evidence_json"):
            try:
                d["evidence"] = json.loads(d["evidence_json"])
            except Exception:
                pass
        results.append(d)
    return results

@router.get("/incidents/{incident_id}/similar")
def get_similar_incidents(incident_id: str, limit: int = 3):
    """
    Retrieves historically resolved incidents from Case Memory matching the incident.
    """
    from app.engine.case_memory import case_memory
    try:
        similar = case_memory.find_similar_incidents(incident_id, limit=limit)
        return similar
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to query Case Memory: {str(e)}")


# =============================================================================
# ACTION GOVERNOR & HUMAN-IN-THE-LOOP (PHASE D)
# =============================================================================

class ProposeActionRequest(BaseModel):
    incident_id: str
    investigation_id: Optional[str] = None
    action_type: str = "reroute_gateway_traffic"
    target_entity: str = "Gateway_X"
    reason: str
    evidence: Optional[List[Dict[str, Any]]] = None
    actor: str = "Gemini_Agent"

class ApproveActionRequest(BaseModel):
    actor: str = "Human_Operator"
    operator_notes: str = "Authorized per FinOps Operational Policy"

class RejectActionRequest(BaseModel):
    actor: str = "Human_Operator"
    reason: str = "Human operator rejected action recommendation"

class ExecuteActionRequest(BaseModel):
    actor: str = "Human_Operator"

@router.post("/actions/propose")
def propose_governed_action(req: ProposeActionRequest):
    """Proposes a new governed action for an incident."""
    try:
        res = action_governor.propose_action(
            incident_id=req.incident_id,
            investigation_id=req.investigation_id,
            action_type=req.action_type,
            target_entity=req.target_entity,
            reason=req.reason,
            evidence=req.evidence,
            actor=req.actor
        )
        return res
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to propose action: {str(e)}")

@router.post("/actions/{action_id}/approve")
def approve_governed_action(action_id: str, req: ApproveActionRequest = ApproveActionRequest()):
    """Grants human operator approval for a pending governed action."""
    try:
        res = action_governor.approve_action(
            action_id=action_id,
            actor=req.actor,
            operator_notes=req.operator_notes
        )
        return res
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Approval failed: {str(e)}")

@router.post("/actions/{action_id}/reject")
def reject_governed_action(action_id: str, req: RejectActionRequest = RejectActionRequest()):
    """Rejects a proposed governed action."""
    try:
        res = action_governor.reject_action(
            action_id=action_id,
            actor=req.actor,
            reason=req.reason
        )
        return res
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Rejection failed: {str(e)}")

@router.post("/actions/{action_id}/execute")
def execute_governed_action(action_id: str, req: ExecuteActionRequest = ExecuteActionRequest()):
    """
    Executes a safe demonstration simulation for an approved action.
    Blocks unapproved, rejected, or duplicate executions.
    """
    try:
        res = action_governor.execute_action(
            action_id=action_id,
            actor=req.actor
        )
        return res
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Execution failed: {str(e)}")

@router.get("/actions/{action_id}")
def get_governed_action(action_id: str):
    """Retrieves a governed action by ID."""
    action = action_governor.get_action(action_id)
    if not action:
        raise HTTPException(status_code=404, detail=f"Governed action '{action_id}' not found")
    return action

@router.get("/incidents/{incident_id}/actions")
def list_incident_actions(incident_id: str):
    """Lists all governed actions proposed for an incident."""
    return action_governor.list_incident_actions(incident_id)

@router.get("/audit-logs")
def list_audit_logs(limit: int = 50):
    """Retrieves the immutable append-only audit trail logs from PostgreSQL."""
    return action_governor.list_audit_logs(limit=limit)

@router.get("/evaluation")
def get_batch_evaluation():
    """Retrieves batch-level evaluation metrics and ground-truth comparison from PostgreSQL."""
    return batch_evaluator.get_evaluation_summary()

@router.post("/evaluation/run")
def run_batch_evaluation():
    """Triggers a full batch evaluation run across 20 labeled ground-truth scenarios."""
    return batch_evaluator.run_full_evaluation()


# =============================================================================
# FINANCIAL INTELLIGENCE COPILOT (PHASE G)
# =============================================================================

@router.post("/financial/documents/upload")
async def upload_financial_document(
    file: UploadFile = File(...),
    document_type: Optional[str] = Form(None),
    account_name: Optional[str] = Form(None)
):
    """
    Uploads a financial document (PDF/CSV/XLSX), runs it through the ingestion
    pipeline (extract -> normalize transactions -> chunk -> embed -> persist),
    and returns the resulting document + extraction summary.
    """
    raw_bytes = await file.read()
    if not raw_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    account_id = None
    if account_name:
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("SELECT account_id FROM financial_accounts WHERE name = %s;", (account_name,))
        row = c.fetchone()
        if row:
            account_id = row["account_id"]
        else:
            account_id = f"facct_{uuid.uuid4().hex[:10]}"
            c.execute("""
                INSERT INTO financial_accounts (account_id, name, institution, account_type, currency, metadata_json, created_at)
                VALUES (%s, %s, NULL, 'bank', 'INR', %s, %s);
            """, (account_id, account_name, json.dumps({}), datetime.now(timezone.utc).isoformat()))
            conn.commit()
        c.close()
        conn.close()

    result = DocumentIngestionPipeline.ingest(
        filename=file.filename,
        raw_bytes=raw_bytes,
        document_type=document_type,
        account_id=account_id
    )
    return result

@router.get("/financial/documents")
def list_financial_documents(account_id: Optional[str] = None, scope: str = "account"):
    """Lists uploaded financial documents with processing status, chunk count,
    transaction count, and whether the original file is available for preview/download.
    Defaults to the scoped account."""
    from app.engine.financial_tools import _resolve_account_id
    conn = get_db_connection()
    c = conn.cursor()
    resolved = account_id
    if not resolved and scope != "all":
        resolved = _resolve_account_id(c, None)
    
    where_clause = "WHERE d.account_id = %s" if resolved and scope != "all" else ""
    params = (resolved,) if resolved and scope != "all" else ()
    c.execute(f"""
        SELECT d.document_id, d.filename, d.document_type, d.source, d.account_id,
               d.processing_status, d.error_message, d.uploaded_at, d.metadata_json,
               d.content_type, (d.raw_content IS NOT NULL) as has_raw_content,
               (SELECT COUNT(*) FROM financial_document_chunks ch WHERE ch.document_id = d.document_id) as chunk_count,
               (SELECT COUNT(*) FROM financial_transactions t WHERE t.document_id = d.document_id) as transaction_count
        FROM financial_documents d
        {where_clause}
        ORDER BY d.uploaded_at DESC;
    """, params)
    rows = [dict(r) for r in c.fetchall()]
    c.close()
    conn.close()
    for d in rows:
        if d.get("metadata_json"):
            try:
                d["metadata"] = json.loads(d["metadata_json"])
            except Exception:
                pass
    return rows

@router.get("/financial/documents/{document_id}/download")
def download_financial_document(document_id: str, disposition: str = "attachment"):
    """
    Serves the original uploaded file. `disposition=inline` (used by the UI's
    'View' action) lets a PDF render natively in the browser tab; `attachment`
    (default, used by 'Download') forces a save dialog. 404 if no original
    file was persisted for this document (should not happen for documents
    uploaded after raw-content storage was added).
    """
    from fastapi.responses import Response
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT filename, content_type, raw_content FROM financial_documents WHERE document_id = %s;", (document_id,))
    row = c.fetchone()
    c.close()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail=f"Document '{document_id}' not found")
    row = dict(row)
    if row["raw_content"] is None:
        raise HTTPException(status_code=404, detail="Original file was not stored for this document (uploaded before file storage was added).")
    disp_kind = "inline" if disposition == "inline" else "attachment"
    return Response(
        content=bytes(row["raw_content"]),
        media_type=row["content_type"] or "application/octet-stream",
        headers={"Content-Disposition": f'{disp_kind}; filename="{row["filename"]}"'}
    )

@router.get("/financial/documents/{document_id}/preview")
def preview_financial_document(document_id: str):
    """
    Returns a readable preview of what was actually indexed from this document:
    structured transactions (for CSV/XLSX, or any PDF rows that matched) and/or
    the extracted text chunks (for policy/statement PDFs). Reflects real
    ingested content only — never a fabricated summary.
    """
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT document_id, filename, document_type, processing_status, error_message FROM financial_documents WHERE document_id = %s;", (document_id,))
    doc = c.fetchone()
    if not doc:
        c.close()
        conn.close()
        raise HTTPException(status_code=404, detail=f"Document '{document_id}' not found")
    doc = dict(doc)

    c.execute("SELECT transaction_id, transaction_date, description, merchant, amount, transaction_type, category FROM financial_transactions WHERE document_id = %s ORDER BY transaction_date DESC LIMIT 100;", (document_id,))
    transactions = [dict(r) for r in c.fetchall()]

    c.execute("SELECT chunk_id, chunk_index, content, page_number, section FROM financial_document_chunks WHERE document_id = %s ORDER BY chunk_index ASC LIMIT 20;", (document_id,))
    chunks = [dict(r) for r in c.fetchall()]
    c.close()
    conn.close()

    return {"document": doc, "transactions": transactions, "chunks": chunks}

@router.delete("/financial/documents/{document_id}")
def delete_financial_document(document_id: str):
    """
    Permanently removes a document and, via ON DELETE CASCADE on
    financial_document_chunks/financial_transactions, all of its indexed
    chunks/embeddings and extracted transactions — guaranteeing no orphaned
    RAG data can continue surfacing in retrieval after deletion.
    """
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT document_id FROM financial_documents WHERE document_id = %s;", (document_id,))
    if not c.fetchone():
        c.close()
        conn.close()
        raise HTTPException(status_code=404, detail=f"Document '{document_id}' not found")
    c.execute("DELETE FROM financial_documents WHERE document_id = %s;", (document_id,))
    conn.commit()
    c.close()
    conn.close()
    return {"status": "deleted", "document_id": document_id}

@router.get("/financial/accounts")
def list_financial_accounts(account_id: Optional[str] = None, scope: str = "account"):
    """Lists financial accounts. Defaults to the scoped Wealth account."""
    from app.engine.financial_tools import _resolve_account_id
    conn = get_db_connection()
    c = conn.cursor()
    resolved = account_id
    if not resolved and scope != "all":
        resolved = _resolve_account_id(c, None)
    
    where_clause = "WHERE account_id = %s" if resolved and scope != "all" else ""
    params = (resolved,) if resolved and scope != "all" else ()
    c.execute(f"SELECT * FROM financial_accounts {where_clause} ORDER BY created_at DESC;", params)
    rows = [dict(r) for r in c.fetchall()]
    c.close()
    conn.close()
    return rows

@router.get("/financial/transactions")
def list_financial_transactions(
    limit: int = 100,
    account_id: Optional[str] = None,
    merchant: Optional[str] = None,
    scope: str = "account",
):
    """The user's transactions.

    Defaults to the resolved primary account rather than every row in the
    table: without scoping, this returned the user's own transactions mixed
    with rows imported from operations data, which made the Data page
    disagree with every other screen. Pass `scope=all` to opt out (the legacy
    operations screens do).
    """
    from app.engine.financial_tools import FinancialTools, _resolve_account_id

    resolved = account_id
    if not resolved and scope != "all":
        conn = get_db_connection()
        c = conn.cursor()
        resolved = _resolve_account_id(c, None)
        c.close()
        conn.close()

    result = FinancialTools.get_transactions(account_id=resolved, merchant=merchant, limit=limit)
    return result["transactions"]

@router.get("/financial/summary")
def get_financial_summary(account_id: Optional[str] = None, scope: str = "account"):
    """Connected-data counts PLUS the user's deterministic financial position.

    The original response exposed only `total_volume_inr`, which summed every
    transaction amount regardless of direction — adding salary credits to rent
    debits produces a number with no financial meaning. That key is retained so
    existing callers keep working, but it is now accompanied by a correct
    credit/debit split and by the real position (balance, income, expenses,
    savings, savings rate) computed by the shared position engine.
    """
    from app.engine.financial_tools import FinancialTools, _resolve_account_id

    position = FinancialTools.get_financial_position(account_id=account_id)

    conn = get_db_connection()
    c = conn.cursor()

    # Scope the money figures to ONE account — the same account the position
    # engine resolved.
    resolved_account_id = position.get("account_id") or _resolve_account_id(c, account_id)

    scope_clause = "WHERE account_id = %s" if resolved_account_id and scope != "all" else ""
    scope_params = (resolved_account_id,) if resolved_account_id and scope != "all" else ()

    c.execute(f"SELECT COUNT(*) as cnt FROM financial_transactions {scope_clause};", scope_params)
    transactions = c.fetchone()["cnt"]
    c.execute(f"""
        SELECT COALESCE(SUM(CASE WHEN transaction_type = 'credit' THEN amount ELSE 0 END), 0) as credits,
               COALESCE(SUM(CASE WHEN transaction_type = 'debit'  THEN amount ELSE 0 END), 0) as debits,
               COALESCE(SUM(amount), 0) as total
        FROM financial_transactions {scope_clause};
    """, scope_params)
    totals = c.fetchone()

    doc_scope = "WHERE account_id = %s" if resolved_account_id and scope != "all" else ""
    doc_ready_scope = (
        "WHERE processing_status IN ('ready', 'partial') AND account_id = %s"
        if resolved_account_id and scope != "all"
        else "WHERE processing_status IN ('ready', 'partial')"
    )

    c.execute(f"SELECT COUNT(*) as cnt FROM financial_documents {doc_scope};", scope_params)
    documents = c.fetchone()["cnt"]
    c.execute(f"SELECT COUNT(*) as cnt FROM financial_documents {doc_ready_scope};", scope_params if resolved_account_id and scope != "all" else ())
    documents_ready = c.fetchone()["cnt"]
    c.execute(f"SELECT COUNT(*) as cnt FROM financial_accounts {scope_clause};", scope_params)
    accounts = c.fetchone()["cnt"]

    if resolved_account_id:
        c.execute("SELECT COUNT(*) as cnt FROM financial_goals WHERE status = 'active' AND account_id = %s;",
                  (resolved_account_id,))
    else:
        c.execute("SELECT COUNT(*) as cnt FROM financial_goals WHERE status = 'active';")
    active_goals = c.fetchone()["cnt"]

    c.close()
    conn.close()

    return {
        "account_id": resolved_account_id,
        "documents": documents,
        "documents_ready": documents_ready,
        "transactions": transactions,
        "accounts": accounts,
        "active_goals": active_goals,
        # Retained for backward compatibility. It sums credits and debits
        # together, which has no financial meaning — prefer the split below.
        "total_volume_inr": float(totals["total"]),
        "total_credits_inr": float(totals["credits"]),
        "total_debits_inr": float(totals["debits"]),
        "position": position,
    }


@router.get("/financial/position")
def get_financial_position(account_id: Optional[str] = None, months: int = 3):
    """The user's financial position — current balance, average monthly income,
    expenses, savings and savings rate — with its calculation basis and
    assumptions. Computed entirely in the backend; the AI never produces these."""
    from app.engine.financial_tools import FinancialTools
    return FinancialTools.get_financial_position(account_id=account_id, months=months)

class CopilotAskRequest(BaseModel):
    query: str

@router.post("/financial/copilot/ask")
def ask_financial_copilot(req: CopilotAskRequest):
    """
    Runs a grounded Gemini investigation over uploaded financial documents/
    transactions using the restricted financial tool registry. Never executes
    arbitrary SQL and never fabricates evidence.
    """
    result = financial_copilot_agent.ask(req.query)
    if result.get("status") == "error":
        err_code = result.get("error_code")
        if err_code == "AI_NOT_CONFIGURED":
            raise HTTPException(status_code=400, detail={"error_code": err_code, "message": result.get("message")})
        elif err_code == "EMPTY_QUERY":
            raise HTTPException(status_code=400, detail={"error_code": err_code, "message": result.get("message")})
        else:
            raise HTTPException(status_code=500, detail=result)
    return result

@router.get("/financial/copilot/runs")
def list_copilot_runs(limit: int = 20, surface: Optional[str] = None):
    """Recent analysis runs (the auditability record).

    `financial_analysis_runs` is shared with the inherited operations Copilot
    and still holds questions asked before this became a personal-finance
    product — payment-statement queries, "total volume" questions and the like.
    Those records are preserved and still returned by default, so the Platform
    tooling and the audit trail lose nothing.

    Passing `surface=wealth` returns only runs produced by the Wealth Navigator
    agent, so the product's own history does not open on a previous product's
    questions. The marker is the `assumptions` key, which the wealth agent
    always emits (including in its fallback shapes) and the earlier agent never
    did — a structural test, not a keyword guess at the question text.
    """
    conn = get_db_connection()
    c = conn.cursor()
    if surface == "wealth":
        c.execute("""
            SELECT run_id, query, model, created_at
            FROM financial_analysis_runs
            WHERE response_json IS NOT NULL AND response_json LIKE %s
            ORDER BY created_at DESC LIMIT %s;
        """, ('%"assumptions"%', limit))
    else:
        c.execute("""
            SELECT run_id, query, model, created_at
            FROM financial_analysis_runs
            ORDER BY created_at DESC LIMIT %s;
        """, (limit,))
    rows = [dict(r) for r in c.fetchall()]
    c.close()
    conn.close()
    return rows

@router.get("/financial/copilot/runs/{run_id}")
def get_copilot_run(run_id: str):
    """Retrieves the full detail of one Financial Copilot analysis run, including tools called
    and retrieved evidence (not the raw system prompt)."""
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT * FROM financial_analysis_runs WHERE run_id = %s;", (run_id,))
    row = c.fetchone()
    c.close()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail=f"Analysis run '{run_id}' not found")
    d = dict(row)
    for field in ("tools_called_json", "retrieved_evidence_json", "response_json"):
        if d.get(field):
            try:
                d[field.replace("_json", "")] = json.loads(d[field])
            except Exception:
                pass
    return d
 
 
# =============================================================================
# WEALTH NAVIGATOR: GOALS, WHAT-IF SCENARIOS & PROACTIVE RECOMMENDATIONS
# =============================================================================

@router.post("/financial/goals")
def create_goal(req: CreateGoalRequest):
    """Creates a new personal financial goal."""
    res = FinancialTools.create_financial_goal(
        account_id=req.account_id,
        goal_name=req.goal_name,
        target_amount=req.target_amount,
        target_date=req.target_date,
        risk_preference=req.risk_preference or "moderate"
    )
    if "error" in res:
        raise HTTPException(status_code=400, detail=res["error"])
    return res


@router.get("/financial/goals")
def list_goals(account_id: Optional[str] = None, status: Optional[str] = "active"):
    """Lists personal financial goals with optional filters."""
    return FinancialTools.get_financial_goals(account_id=account_id, status=status)


@router.patch("/financial/goals/{goal_id}")
def update_goal(goal_id: str, req: UpdateGoalRequest):
    """Updates progress (current_amount) or status of a financial goal."""
    res = FinancialTools.update_financial_goal(
        goal_id=goal_id,
        current_amount=req.current_amount,
        status=req.status
    )
    if "error" in res:
        raise HTTPException(status_code=400, detail=res["error"])
    return res


@router.post("/financial/goals/{goal_id}/simulate")
def simulate_goal_scenario(goal_id: str, req: SimulateScenarioRequest):
    """
    Runs a deterministic what-if savings scenario against a goal.
    Persists recommendation audit log to wealth_recommendations.
    """
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT * FROM financial_goals WHERE goal_id = %s;", (goal_id,))
    goal_row = c.fetchone()
    if not goal_row:
        c.close()
        conn.close()
        raise HTTPException(status_code=404, detail=f"Goal '{goal_id}' not found")
    goal = dict(goal_row)
    account_id = goal.get("account_id")

    # Run deterministic simulation
    result = FinancialTools.simulate_savings_scenario(
        account_id=account_id,
        monthly_extra_savings=req.monthly_extra_savings,
        months=req.months,
        goal_id=goal_id
    )

    # Persist audit record to wealth_recommendations
    rec_id = f"wrec_{uuid.uuid4().hex[:10]}"
    now_str = datetime.now(timezone.utc).isoformat()
    query_desc = f"Simulate +₹{req.monthly_extra_savings:,.2f}/mo for {req.months} months on '{goal['goal_name']}'"
    tools_called = [{
        "tool_name": "simulate_savings_scenario",
        "arguments": {
            "account_id": account_id,
            "monthly_extra_savings": req.monthly_extra_savings,
            "months": req.months,
            "goal_id": goal_id
        }
    }]

    c.execute("""
        INSERT INTO wealth_recommendations (recommendation_id, goal_id, query, tools_called_json, assumptions_json, recommendation_json, model, created_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s);
    """, (
        rec_id, goal_id, query_desc,
        json.dumps(tools_called),
        json.dumps(result.get("assumptions", [])),
        json.dumps(result, default=str),
        "deterministic-engine", now_str
    ))
    conn.commit()
    c.close()
    conn.close()

    result["recommendation_id"] = rec_id
    return result


@router.get("/financial/goals/{goal_id}/recommendations")
def get_goal_recommendations(goal_id: str, risk_preference: Optional[str] = None):
    """
    Runs deterministic rule-based next-best actions for accelerating a specific goal.
    Persists audit log to wealth_recommendations.
    """
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT * FROM financial_goals WHERE goal_id = %s;", (goal_id,))
    goal_row = c.fetchone()
    if not goal_row:
        c.close()
        conn.close()
        raise HTTPException(status_code=404, detail=f"Goal '{goal_id}' not found")
    goal = dict(goal_row)
    account_id = goal.get("account_id")

    # Run deterministic next-best actions. Risk preference falls through to the
    # goal's own stored preference unless the caller explicitly overrides it.
    result = FinancialTools.recommend_next_actions(
        account_id=account_id, goal_id=goal_id, risk_preference=risk_preference
    )

    # Persist audit record
    rec_id = f"wrec_{uuid.uuid4().hex[:10]}"
    now_str = datetime.now(timezone.utc).isoformat()
    query_desc = f"Proactive next actions for '{goal['goal_name']}'"
    tools_called = [{
        "tool_name": "recommend_next_actions",
        "arguments": {"account_id": account_id, "goal_id": goal_id}
    }]

    c.execute("""
        INSERT INTO wealth_recommendations (recommendation_id, goal_id, query, tools_called_json, assumptions_json, recommendation_json, model, created_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s);
    """, (
        rec_id, goal_id, query_desc,
        json.dumps(tools_called),
        json.dumps(result.get("assumptions", [])),
        json.dumps(result, default=str),
        "deterministic-rules", now_str
    ))
    conn.commit()
    c.close()
    conn.close()

    result["recommendation_id"] = rec_id
    return result
