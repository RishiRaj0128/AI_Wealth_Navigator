"""
backend/tests/test_wealth_navigator.py

Behavioural tests for the AI Wealth Navigator engines: financial position,
goal derivation, what-if projection, next-best actions and risk personalization.

These test business behaviour, not implementation detail. The central property
under test throughout is that every financial number the product shows is
produced by the backend from real rows — and that the separate engines agree
with each other, because a scenario that disagreed with the dashboard would
undermine the entire "deterministic, explainable" claim.

Runs against the isolated `<db>_test` database enforced by conftest.py.
"""

import math
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.engine.database import get_db_connection
from app.engine.financial_tools import (
    FinancialTools,
    FINANCIAL_TOOL_REGISTRY,
    GEMINI_FINANCIAL_TOOL_DECLARATIONS,
    _derive_goal_metrics,
    RISK_PROFILES,
)

client = TestClient(app)

ACCOUNT_ID = "facc_test_wealth"
DOC_ID = "fdoc_test_wealth"

# A deliberately simple, fully-predictable three-month financial life so every
# expected figure below can be derived by hand rather than copied from output:
#
#   income   60,000/month
#   expenses 40,000/month  (Rent 20,000 + Dining + Groceries)
#   savings  20,000/month  ->  savings rate 33.3%
#
# Dining rises 6,000 -> 9,000 in the final month (+50%), which is the only
# month-over-month surge in the data, so the recommendation engine has exactly
# one unambiguous thing to find.
MONTHS = ["2026-06", "2026-07", "2026-08"]
DINING = {"2026-06": 6000.0, "2026-07": 6000.0, "2026-08": 9000.0}
GROCERIES = {"2026-06": 14000.0, "2026-07": 14000.0, "2026-08": 11000.0}
RENT = 20000.0
SALARY = 60000.0
OPENING = 100000.0


@pytest.fixture(scope="module", autouse=True)
def seeded_account():
    """Builds the fixed ledger above, with a coherent running balance so the
    position engine takes its accurate `statement_balance` path."""
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("DELETE FROM wealth_recommendations;")
    c.execute("DELETE FROM financial_goals WHERE account_id = %s;", (ACCOUNT_ID,))
    c.execute("DELETE FROM financial_transactions WHERE account_id = %s;", (ACCOUNT_ID,))
    c.execute("DELETE FROM financial_documents WHERE document_id = %s;", (DOC_ID,))
    c.execute("DELETE FROM financial_accounts WHERE account_id = %s;", (ACCOUNT_ID,))

    now = datetime.now(timezone.utc).isoformat()
    c.execute("""
        INSERT INTO financial_accounts (account_id, name, institution, account_type, currency, created_at)
        VALUES (%s, 'Test Wealth Account', 'Test Bank', 'bank', 'INR', %s);
    """, (ACCOUNT_ID, now))
    c.execute("""
        INSERT INTO financial_documents (document_id, filename, document_type, source, account_id, processing_status, uploaded_at)
        VALUES (%s, 'test-statement.csv', 'bank_statement', 'test', %s, 'ready', %s);
    """, (DOC_ID, ACCOUNT_ID, now))

    rows = []
    for ym in MONTHS:
        y, m = int(ym[:4]), int(ym[5:])
        rows.append((datetime(y, m, 1, tzinfo=timezone.utc), "Salary", "Employer", SALARY, "credit", "Salary"))
        rows.append((datetime(y, m, 3, tzinfo=timezone.utc), "Rent", "Landlord", RENT, "debit", "Rent"))
        rows.append((datetime(y, m, 10, tzinfo=timezone.utc), "Groceries", "Supermarket", GROCERIES[ym], "debit", "Groceries"))
        rows.append((datetime(y, m, 15, tzinfo=timezone.utc), "Dining", "Restaurant", DINING[ym], "debit", "Dining"))

    rows.sort(key=lambda r: r[0])
    balance = OPENING
    for i, (dt, desc, merchant, amount, ttype, category) in enumerate(rows):
        balance += amount if ttype == "credit" else -amount
        c.execute("""
            INSERT INTO financial_transactions
                (transaction_id, account_id, document_id, transaction_date, description, merchant,
                 amount, transaction_type, category, balance_after, created_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s);
        """, (f"ftxn_test_{i:03d}", ACCOUNT_ID, DOC_ID, dt.isoformat(), desc, merchant,
              amount, ttype, category, round(balance, 2), now))

    conn.commit()
    c.close()
    conn.close()
    yield {"closing_balance": round(balance, 2)}


def _make_goal(target, current, months_out, risk="moderate", name="Test Goal", status="active"):
    """Inserts a goal directly so a test can pin an exact deadline offset."""
    goal_id = f"fgoal_test_{uuid.uuid4().hex[:8]}"
    target_date = (
        (datetime.now(timezone.utc).date() + timedelta(days=30.4375 * months_out)).isoformat()
        if months_out is not None else None
    )
    conn = get_db_connection()
    c = conn.cursor()
    c.execute("""
        INSERT INTO financial_goals
            (goal_id, account_id, goal_name, target_amount, current_amount, target_date, risk_preference, status, created_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s);
    """, (goal_id, ACCOUNT_ID, name, target, current, target_date, risk, status,
          datetime.now(timezone.utc).isoformat()))
    conn.commit()
    c.close()
    conn.close()
    return goal_id


# ===========================================================================
# FINANCIAL PROFILE
# ===========================================================================

def test_position_computes_income_expenses_savings_and_rate(seeded_account):
    pos = FinancialTools.get_financial_position(account_id=ACCOUNT_ID)

    assert pos["has_data"] is True
    assert pos["months_analyzed"] == 3
    assert pos["monthly_income"] == pytest.approx(SALARY)

    # 40,000/month in every month: 20,000 rent + dining + groceries.
    assert pos["monthly_expenses"] == pytest.approx(40000.0)
    assert pos["monthly_savings"] == pytest.approx(20000.0)
    assert pos["savings_rate_pct"] == pytest.approx(33.3, abs=0.1)


def test_position_uses_statement_balance_not_net_sum(seeded_account):
    """The reported running balance must win over the credits-minus-debits
    fallback, and must be labelled so the user knows which was used."""
    pos = FinancialTools.get_financial_position(account_id=ACCOUNT_ID)

    assert pos["balance_method"] == "statement_balance"
    assert pos["current_balance"] == pytest.approx(seeded_account["closing_balance"])
    assert pos["balance_as_of"] is not None
    # Opening 100,000 + 3 x 20,000 saved = 160,000.
    assert pos["current_balance"] == pytest.approx(160000.0)


def test_position_states_its_basis_and_assumptions(seeded_account):
    pos = FinancialTools.get_financial_position(account_id=ACCOUNT_ID)
    assert pos["basis"]
    assert len(pos["assumptions"]) >= 2
    assert any("balance" in a.lower() for a in pos["assumptions"])


def test_position_on_empty_account_is_explicit_not_zero():
    """An account with no history must say so, rather than reporting a
    confident ₹0 income that a user could mistake for a real figure."""
    pos = FinancialTools.get_financial_position(account_id="facc_does_not_exist")
    assert pos["has_data"] is False
    assert pos["savings_rate_pct"] is None
    assert pos["months_analyzed"] == 0
    assert any("no transaction" in a.lower() for a in pos["assumptions"])


def test_summary_endpoint_exposes_position_and_credit_debit_split(seeded_account):
    res = client.get("/api/financial/summary")
    assert res.status_code == 200
    body = res.json()

    assert "position" in body
    assert body["total_credits_inr"] > 0
    assert body["total_debits_inr"] > 0
    # The legacy key stays for backward compatibility but is no longer the
    # only thing on offer.
    assert "total_volume_inr" in body


def test_position_endpoint_returns_the_same_numbers_as_the_tool(seeded_account):
    res = client.get(f"/api/financial/position?account_id={ACCOUNT_ID}")
    assert res.status_code == 200
    body = res.json()
    tool = FinancialTools.get_financial_position(account_id=ACCOUNT_ID)
    assert body["monthly_savings"] == tool["monthly_savings"]
    assert body["current_balance"] == tool["current_balance"]


# ===========================================================================
# GOAL ENGINE
# ===========================================================================

def test_goal_creation_and_retrieval_round_trip(seeded_account):
    res = client.post("/api/financial/goals", json={
        "account_id": ACCOUNT_ID,
        "goal_name": "Round Trip Goal",
        "target_amount": 100000,
        "target_date": "2027-12-31",
        "risk_preference": "conservative",
    })
    assert res.status_code == 200
    goal_id = res.json()["goal"]["goal_id"]

    listed = client.get(f"/api/financial/goals?account_id={ACCOUNT_ID}&status=all").json()
    assert any(g["goal_id"] == goal_id for g in listed["goals"])


def test_goal_progress_and_remaining_are_derived(seeded_account):
    goal_id = _make_goal(target=200000, current=50000, months_out=10)
    goals = FinancialTools.get_financial_goals(account_id=ACCOUNT_ID, status="all")["goals"]
    goal = next(g for g in goals if g["goal_id"] == goal_id)

    assert goal["amount_remaining"] == pytest.approx(150000.0)
    assert goal["progress_percent"] == pytest.approx(25.0)


def test_required_monthly_saving_is_remaining_over_months(seeded_account):
    goal_id = _make_goal(target=200000, current=50000, months_out=10)
    goals = FinancialTools.get_financial_goals(account_id=ACCOUNT_ID, status="all")["goals"]
    goal = next(g for g in goals if g["goal_id"] == goal_id)

    expected = 150000.0 / goal["months_remaining"]
    assert goal["required_monthly_saving"] == pytest.approx(expected, rel=0.01)


def test_goal_status_behind_when_required_exceeds_capacity(seeded_account):
    """Needs 90,000/month against a real capacity of 20,000/month."""
    goal_id = _make_goal(target=200000, current=20000, months_out=2)
    goals = FinancialTools.get_financial_goals(account_id=ACCOUNT_ID, status="all")["goals"]
    goal = next(g for g in goals if g["goal_id"] == goal_id)

    assert goal["derived_status"] == "behind"
    assert "shortfall" in goal["status_reason"].lower()


def test_goal_status_ahead_when_capacity_comfortably_covers_it(seeded_account):
    """Needs ~2,000/month against a capacity of 20,000/month."""
    goal_id = _make_goal(target=100000, current=50000, months_out=25)
    goals = FinancialTools.get_financial_goals(account_id=ACCOUNT_ID, status="all")["goals"]
    goal = next(g for g in goals if g["goal_id"] == goal_id)
    assert goal["derived_status"] == "ahead"


def test_completed_goal_needs_nothing_further(seeded_account):
    goal_id = _make_goal(target=50000, current=60000, months_out=6)
    goals = FinancialTools.get_financial_goals(account_id=ACCOUNT_ID, status="all")["goals"]
    goal = next(g for g in goals if g["goal_id"] == goal_id)

    assert goal["derived_status"] == "completed"
    assert goal["amount_remaining"] == 0
    assert goal["required_monthly_saving"] == 0
    # Progress is capped rather than reported as 120%.
    assert goal["progress_percent"] == 100.0


def test_past_deadline_goal_is_overdue_and_does_not_divide_by_zero(seeded_account):
    goal_id = _make_goal(target=100000, current=40000, months_out=-3)
    goals = FinancialTools.get_financial_goals(account_id=ACCOUNT_ID, status="all")["goals"]
    goal = next(g for g in goals if g["goal_id"] == goal_id)

    assert goal["derived_status"] == "overdue"
    assert goal["months_remaining"] < 0
    # The whole outstanding amount is due, not an infinite monthly figure.
    assert goal["required_monthly_saving"] == pytest.approx(60000.0)


def test_goal_with_no_deadline_still_projects_a_date(seeded_account):
    goal_id = _make_goal(target=100000, current=0, months_out=None)
    goals = FinancialTools.get_financial_goals(account_id=ACCOUNT_ID, status="all")["goals"]
    goal = next(g for g in goals if g["goal_id"] == goal_id)

    assert goal["derived_status"] == "no_deadline"
    assert goal["required_monthly_saving"] is None
    assert goal["months_to_goal_at_current_rate"] == math.ceil(100000 / 20000)


def test_zero_savings_capacity_never_divides_by_zero():
    """Direct unit check on the derivation with no saving capacity at all."""
    goal = {
        "target_amount": 100000, "current_amount": 0,
        "target_date": (datetime.now(timezone.utc).date() + timedelta(days=365)).isoformat(),
        "status": "active", "risk_preference": "moderate",
    }
    derived = _derive_goal_metrics(goal, monthly_savings=0.0)
    assert derived["derived_status"] == "behind"
    assert derived["projected_completion_date"] is None
    assert derived["required_monthly_saving"] > 0


def test_negative_savings_capacity_is_handled():
    goal = {
        "target_amount": 50000, "current_amount": 0,
        "target_date": (datetime.now(timezone.utc).date() + timedelta(days=180)).isoformat(),
        "status": "active", "risk_preference": "moderate",
    }
    derived = _derive_goal_metrics(goal, monthly_savings=-5000.0)
    assert derived["derived_status"] == "behind"


def test_goal_list_reports_combined_affordability(seeded_account):
    data = FinancialTools.get_financial_goals(account_id=ACCOUNT_ID, status="all")
    assert "total_required_monthly_saving" in data
    assert "all_goals_affordable" in data
    assert data["monthly_savings_basis"] == pytest.approx(20000.0)


# ===========================================================================
# WHAT-IF SCENARIO
# ===========================================================================

def test_baseline_projection_uses_real_position(seeded_account):
    """With no extra saving, the projection is purely balance + savings x months."""
    sim = FinancialTools.simulate_savings_scenario(
        account_id=ACCOUNT_ID, monthly_extra_savings=0, months=12
    )
    assert sim["current_monthly_savings"] == pytest.approx(20000.0)
    assert sim["new_monthly_savings"] == pytest.approx(20000.0)
    assert sim["projected_balance"] == pytest.approx(160000.0 + 20000.0 * 12)


def test_additional_saving_increases_projection_by_exactly_that_amount(seeded_account):
    sim = FinancialTools.simulate_savings_scenario(
        account_id=ACCOUNT_ID, monthly_extra_savings=5000, months=12
    )
    assert sim["new_monthly_savings"] == pytest.approx(25000.0)
    assert sim["total_extra_saved"] == pytest.approx(60000.0)
    assert sim["projected_balance_difference"] == pytest.approx(60000.0)
    assert sim["projected_balance"] == pytest.approx(sim["baseline_projected_balance"] + 60000.0)


def test_scenario_reports_goal_gap_and_brings_the_date_forward(seeded_account):
    goal_id = _make_goal(target=500000, current=100000, months_out=24, name="Car Goal")
    sim = FinancialTools.simulate_savings_scenario(
        account_id=ACCOUNT_ID, monthly_extra_savings=5000, months=12, goal_id=goal_id
    )
    gp = sim["goal_projection"]

    assert gp["goal_gap"] == pytest.approx(400000.0)
    # 400,000 / 20,000 = 20 months baseline; / 25,000 = 16 months with extra.
    assert gp["baseline_months_to_goal"] == 20
    assert gp["new_months_to_goal"] == 16
    assert gp["months_saved"] == pytest.approx(4.0, abs=0.1)
    assert gp["new_projected_date"] < gp["baseline_projected_date"]


def test_small_improvements_report_days_not_a_misleading_zero(seeded_account):
    """Rounding each timeline up to whole months first would report a real
    improvement as '0 months earlier'. It must survive as days."""
    goal_id = _make_goal(target=500000, current=100000, months_out=24)
    sim = FinancialTools.simulate_savings_scenario(
        account_id=ACCOUNT_ID, monthly_extra_savings=200, months=12, goal_id=goal_id
    )
    gp = sim["goal_projection"]
    assert gp["days_saved"] > 0
    assert "day" in gp["months_saved_label"] or "month" in gp["months_saved_label"]


def test_scenario_never_invents_investment_returns(seeded_account):
    """The projection must be exactly linear cash flow. Any compounding would
    make projected_balance exceed balance + savings x months."""
    sim = FinancialTools.simulate_savings_scenario(
        account_id=ACCOUNT_ID, monthly_extra_savings=10000, months=36
    )
    expected = 160000.0 + (30000.0 * 36)
    assert sim["projected_balance"] == pytest.approx(expected)


def test_scenario_always_exposes_assumptions(seeded_account):
    sim = FinancialTools.simulate_savings_scenario(
        account_id=ACCOUNT_ID, monthly_extra_savings=5000, months=12
    )
    text = " ".join(sim["assumptions"]).lower()
    assert len(sim["assumptions"]) >= 4
    assert "inflation" in text or "investment return" in text
    assert "horizon" in text


def test_simulate_endpoint_persists_an_audit_record(seeded_account):
    goal_id = _make_goal(target=300000, current=50000, months_out=18)
    res = client.post(f"/api/financial/goals/{goal_id}/simulate",
                      json={"monthly_extra_savings": 5000, "months": 12})
    assert res.status_code == 200
    body = res.json()
    assert body["recommendation_id"].startswith("wrec_")

    conn = get_db_connection()
    c = conn.cursor()
    c.execute("SELECT * FROM wealth_recommendations WHERE recommendation_id = %s;",
              (body["recommendation_id"],))
    row = c.fetchone()
    c.close()
    conn.close()
    assert row is not None


def test_simulate_on_missing_goal_is_404(seeded_account):
    res = client.post("/api/financial/goals/fgoal_nope/simulate",
                      json={"monthly_extra_savings": 1000, "months": 12})
    assert res.status_code == 404


# ===========================================================================
# NEXT-BEST ACTIONS
# ===========================================================================

def test_detects_the_month_over_month_dining_surge(seeded_account):
    recs = FinancialTools.recommend_next_actions(account_id=ACCOUNT_ID)
    dining = next((a for a in recs["recommendations"] if a["category"] == "Dining"), None)

    assert dining is not None, "the 6,000 -> 9,000 dining surge was not detected"
    assert dining["opportunity_type"] == "spending_surge"
    assert dining["pct_increase"] == pytest.approx(50.0)
    assert dining["mom_increase_inr"] == pytest.approx(3000.0)


def test_actions_carry_an_explanation_and_rupee_impact(seeded_account):
    recs = FinancialTools.recommend_next_actions(account_id=ACCOUNT_ID)
    for a in recs["recommendations"]:
        assert a["action"], "every action needs a plain-language instruction"
        assert a["why"], "every action needs a reason it was recommended"
        if a["opportunity_type"] != "emergency_buffer":
            assert a["annual_saving"] == pytest.approx(a["monthly_saving"] * 12)


def test_non_discretionary_categories_are_never_proposed_for_trimming(seeded_account):
    """Telling someone to cut their rent is not an actionable recommendation."""
    recs = FinancialTools.recommend_next_actions(account_id=ACCOUNT_ID)
    categories = {a["category"] for a in recs["recommendations"]}
    assert "Rent" not in categories
    assert "Salary" not in categories


def test_action_goal_impact_matches_the_scenario_engine_exactly(seeded_account):
    """The two engines must agree: an action claiming 'X months earlier' has to
    produce the identical figure the simulator gives for the same rupee amount.
    This is the anti-drift guarantee the whole product rests on."""
    goal_id = _make_goal(target=500000, current=100000, months_out=24)
    recs = FinancialTools.recommend_next_actions(account_id=ACCOUNT_ID, goal_id=goal_id)
    action = recs["recommendations"][0]

    direct = FinancialTools.simulate_savings_scenario(
        account_id=ACCOUNT_ID,
        monthly_extra_savings=action["monthly_saving"],
        months=12,
        goal_id=goal_id,
    )
    assert action["goal_impact"]["months_saved"] == direct["goal_projection"]["months_saved"]
    assert action["goal_impact"]["new_projected_date"] == direct["goal_projection"]["new_projected_date"]


def test_recommendations_always_expose_assumptions_and_the_rule(seeded_account):
    recs = FinancialTools.recommend_next_actions(account_id=ACCOUNT_ID)
    assert recs["rule_applied"]
    assert len(recs["assumptions"]) >= 3
    assert any("not regulated financial advice" in a.lower() for a in recs["assumptions"])


def test_recommendations_endpoint_accepts_a_risk_override(seeded_account):
    goal_id = _make_goal(target=300000, current=50000, months_out=18, risk="moderate")
    res = client.get(f"/api/financial/goals/{goal_id}/recommendations?risk_preference=aggressive")
    assert res.status_code == 200
    assert res.json()["risk_preference"] == "aggressive"


# ===========================================================================
# RISK PERSONALIZATION
# ===========================================================================

def test_aggressive_proposes_a_larger_cut_than_moderate(seeded_account):
    moderate = FinancialTools.recommend_next_actions(account_id=ACCOUNT_ID, risk_preference="moderate")
    aggressive = FinancialTools.recommend_next_actions(account_id=ACCOUNT_ID, risk_preference="aggressive")

    assert moderate["recommended_reduction_pct"] == 25
    assert aggressive["recommended_reduction_pct"] == 50

    m_dining = next(a for a in moderate["recommendations"] if a["category"] == "Dining")
    a_dining = next(a for a in aggressive["recommendations"] if a["category"] == "Dining")
    assert a_dining["monthly_saving"] == pytest.approx(m_dining["monthly_saving"] * 2)


def test_conservative_is_cautious_not_aggressive(seeded_account):
    conservative = FinancialTools.recommend_next_actions(account_id=ACCOUNT_ID, risk_preference="conservative")
    assert conservative["recommended_reduction_pct"] == 25
    assert conservative["risk_preference"] == "conservative"
    assert "buffer" in conservative["risk_strategy"].lower()


def test_conservative_prioritises_an_emergency_buffer_when_one_is_missing(seeded_account):
    """Balance 160,000 against 3 x 40,000 = 120,000 of expenses means the buffer
    is already met, so no buffer action should appear. With a thinner balance it
    must appear first. Verified through the tier's own logic rather than a
    hard-coded expectation."""
    conservative = FinancialTools.recommend_next_actions(account_id=ACCOUNT_ID, risk_preference="conservative")
    pos = FinancialTools.get_financial_position(account_id=ACCOUNT_ID)
    buffer_target = pos["monthly_expenses"] * 3
    has_buffer_action = any(
        a["opportunity_type"] == "emergency_buffer" for a in conservative["recommendations"]
    )
    assert has_buffer_action == (pos["current_balance"] < buffer_target)


def test_risk_tiers_never_change_a_projected_number(seeded_account):
    """The tier may change WHAT is recommended, never the arithmetic. The same
    extra saving must project identically regardless of risk preference."""
    a = FinancialTools.simulate_savings_scenario(account_id=ACCOUNT_ID, monthly_extra_savings=5000, months=12)
    for risk in RISK_PROFILES:
        recs = FinancialTools.recommend_next_actions(account_id=ACCOUNT_ID, risk_preference=risk)
        assert recs["risk_preference"] == risk
    b = FinancialTools.simulate_savings_scenario(account_id=ACCOUNT_ID, monthly_extra_savings=5000, months=12)
    assert a["projected_balance"] == b["projected_balance"]


def test_unknown_risk_preference_falls_back_to_moderate(seeded_account):
    recs = FinancialTools.recommend_next_actions(account_id=ACCOUNT_ID, risk_preference="yolo")
    assert recs["risk_preference"] == "moderate"


def test_goal_inherits_its_own_risk_preference_when_none_is_given(seeded_account):
    goal_id = _make_goal(target=300000, current=50000, months_out=18, risk="aggressive")
    recs = FinancialTools.recommend_next_actions(account_id=ACCOUNT_ID, goal_id=goal_id)
    assert recs["risk_preference"] == "aggressive"


# ===========================================================================
# AGENT WIRING
# ===========================================================================

def test_every_wealth_tool_is_registered_and_declared():
    """A tool present in one place but missing from the other is invisible to
    the agent (or crashes it), so the two must stay in lockstep."""
    expected = {
        "get_financial_position",
        "get_financial_goals",
        "create_financial_goal",
        "simulate_savings_scenario",
        "recommend_next_actions",
    }
    assert expected.issubset(set(FINANCIAL_TOOL_REGISTRY))

    declared = {d["name"] for d in GEMINI_FINANCIAL_TOOL_DECLARATIONS}
    assert declared == set(FINANCIAL_TOOL_REGISTRY)


def test_wealth_tools_are_callable_through_the_registry(seeded_account):
    """The agent dispatches by name through this registry, so the tools must
    work when invoked exactly the way the tool-calling loop invokes them."""
    pos = FINANCIAL_TOOL_REGISTRY["get_financial_position"](account_id=ACCOUNT_ID)
    assert pos["monthly_savings"] == pytest.approx(20000.0)

    sim = FINANCIAL_TOOL_REGISTRY["simulate_savings_scenario"](
        account_id=ACCOUNT_ID, monthly_extra_savings=5000, months=12
    )
    assert sim["assumptions"]

    recs = FINANCIAL_TOOL_REGISTRY["recommend_next_actions"](account_id=ACCOUNT_ID)
    assert recs["assumptions"]


def test_calculate_financial_metric_still_rejects_unknown_metrics():
    """The closed whitelist is the boundary that stops the model specifying its
    own calculation. It must not have loosened."""
    result = FinancialTools.calculate_financial_metric(metric="DROP TABLE payments")
    assert "error" in result


# ===========================================================================
# HEALTH + DATA SCOPING
#
# Each test below pins a defect found during the submission-hardening pass.
# ===========================================================================

def test_health_reports_real_database_state():
    """/health used to return status "healthy" unconditionally without ever
    touching PostgreSQL, so the UI's connection light could never go red."""
    body = client.get("/api/health").json()

    assert body["database_status"] in ("online", "offline")
    assert body["backend"] == "online"
    assert body["ai"] in ("configured", "not_configured")
    # The tests run against a live database, so this must observe it as up.
    assert body["database_status"] == "online"
    assert body["status"] == "healthy"


def test_health_never_leaks_the_api_key():
    """The status payload says whether a key is configured, never what it is."""
    import json as _json
    from app.core.config import settings

    raw = _json.dumps(client.get("/api/health").json())
    assert "GEMINI_API_KEY" not in raw
    if settings.GEMINI_API_KEY:
        assert settings.GEMINI_API_KEY not in raw
    if settings.DATABASE_URL:
        assert settings.DATABASE_URL not in raw


def test_summary_money_figures_are_scoped_to_one_account(seeded_account):
    """The summary summed every row in the table, so a user's own totals were
    inflated by transactions belonging to other accounts (an operations-data
    import). Dashboard and Data page consequently disagreed."""
    # A second account with its own transaction, which must NOT be counted.
    other = "facc_test_other"
    conn = get_db_connection()
    c = conn.cursor()
    now = datetime.now(timezone.utc).isoformat()
    c.execute("DELETE FROM financial_transactions WHERE account_id = %s;", (other,))
    c.execute("DELETE FROM financial_accounts WHERE account_id = %s;", (other,))
    c.execute("""
        INSERT INTO financial_accounts (account_id, name, account_type, currency, created_at)
        VALUES (%s, 'Other Account', 'bank', 'INR', %s);
    """, (other, "2000-01-01T00:00:00+00:00"))  # older, so it is never the resolved account
    c.execute("""
        INSERT INTO financial_transactions
            (transaction_id, account_id, transaction_date, description, merchant,
             amount, transaction_type, category, created_at)
        VALUES ('ftxn_other_001', %s, %s, 'Unrelated', 'Elsewhere', 999999, 'debit', 'Other', %s);
    """, (other, now, now))
    conn.commit()
    c.close()
    conn.close()

    try:
        body = client.get("/api/financial/summary").json()
        assert body["account_id"] == ACCOUNT_ID
        # 999,999 belongs to the other account and must be excluded.
        assert body["total_debits_inr"] < 999999
        assert body["transactions"] == len(MONTHS) * 4

        position = body["position"]
        assert body["total_credits_inr"] == pytest.approx(position["monthly_income"] * len(MONTHS))
    finally:
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("DELETE FROM financial_transactions WHERE account_id = %s;", (other,))
        c.execute("DELETE FROM financial_accounts WHERE account_id = %s;", (other,))
        conn.commit()
        c.close()
        conn.close()


def test_transactions_endpoint_defaults_to_the_users_own_account(seeded_account):
    rows = client.get("/api/financial/transactions?limit=500").json()
    assert len(rows) > 0
    assert all(r["account_id"] == ACCOUNT_ID for r in rows)


def test_transactions_endpoint_can_still_opt_out_of_scoping(seeded_account):
    """The legacy operations screens read across accounts; that must remain
    possible, just no longer the default."""
    res = client.get("/api/financial/transactions?limit=500&scope=all")
    assert res.status_code == 200


def test_goal_completion_date_matches_the_scenario_engine(seeded_account):
    """The goal card and the what-if simulator showed different dates for the
    same goal at the same saving rate — the goal engine projected from the
    CEILED month count while the scenario engine used the exact timeline."""
    goal_id = _make_goal(target=300000, current=50000, months_out=24)

    goals = FinancialTools.get_financial_goals(account_id=ACCOUNT_ID, status="all")["goals"]
    goal = next(g for g in goals if g["goal_id"] == goal_id)

    baseline = FinancialTools.simulate_savings_scenario(
        account_id=ACCOUNT_ID, monthly_extra_savings=0, months=12, goal_id=goal_id
    )["goal_projection"]

    assert goal["projected_completion_date"] == baseline["baseline_projected_date"]


def test_generated_amounts_round_half_up_like_the_ui(seeded_account):
    """Sentences generated here are shown beside figures the browser formats.
    Python's banker's rounding made 32680.5 render as "32,680" next to the
    UI's "32,681"."""
    from app.engine.financial_tools import _inr

    assert _inr(32680.5) == "₹32,681"
    assert _inr(0.5) == "₹1"
    assert _inr(1234) == "₹1,234"
    assert _inr(None) == "—"

    # And the value actually appears that way in a goal's explanation.
    goal_id = _make_goal(target=400000, current=0, months_out=24)
    goals = FinancialTools.get_financial_goals(account_id=ACCOUNT_ID, status="all")["goals"]
    goal = next(g for g in goals if g["goal_id"] == goal_id)
    assert "₹" in goal["status_reason"]


def test_every_screen_reads_the_same_balance_and_savings(seeded_account):
    """One source of truth: the dashboard, the summary and the scenario engine
    must all quote identical figures, or the product contradicts itself."""
    position = client.get(f"/api/financial/position?account_id={ACCOUNT_ID}").json()
    summary = client.get("/api/financial/summary").json()["position"]
    goals = FinancialTools.get_financial_goals(account_id=ACCOUNT_ID, status="all")
    scenario = FinancialTools.simulate_savings_scenario(
        account_id=ACCOUNT_ID, monthly_extra_savings=0, months=12
    )

    assert summary["current_balance"] == position["current_balance"]
    assert summary["monthly_savings"] == position["monthly_savings"]
    assert scenario["current_balance"] == position["current_balance"]
    assert scenario["current_monthly_savings"] == position["monthly_savings"]
    assert goals["monthly_savings_basis"] == position["monthly_savings"]


# ===========================================================================
# DEMO SEED
# ===========================================================================

def _load_seed_module():
    """The seed lives in scripts/, outside the app package, so it is loaded by
    path rather than imported — this keeps the script standalone."""
    import importlib.util
    from pathlib import Path
    path = Path(__file__).resolve().parent.parent.parent / "scripts" / "seed_wealth_demo.py"
    spec = importlib.util.spec_from_file_location("seed_wealth_demo", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_demo_seed_is_deterministic():
    """Two builds for the same anchor month must be byte-identical, or the
    demo would show different numbers on every run."""
    seed = _load_seed_module()
    a = seed.build_transactions(2026, 8)
    b = seed.build_transactions(2026, 8)
    assert len(a) == len(b)
    assert [(r["date"], r["merchant"], r["amount"], r["balance_after"]) for r in a] == \
           [(r["date"], r["merchant"], r["amount"], r["balance_after"]) for r in b]


def test_demo_seed_ledger_reconciles():
    """opening + credits - debits must equal the final running balance, or the
    position engine's statement-balance path would report a fiction."""
    seed = _load_seed_module()
    rows = seed.build_transactions(2026, 8)
    credits = sum(r["amount"] for r in rows if r["type"] == "credit")
    debits = sum(r["amount"] for r in rows if r["type"] == "debit")
    assert rows[-1]["balance_after"] == pytest.approx(seed.OPENING_BALANCE + credits - debits)


def test_demo_seed_contains_a_detectable_spending_surge():
    """The demo must give the recommendation engine something real to find."""
    seed = _load_seed_module()
    rows = seed.build_transactions(2026, 8)
    by_month = {}
    for r in rows:
        if r["category"] == "Dining":
            by_month.setdefault(r["date"].strftime("%Y-%m"), 0.0)
            by_month[r["date"].strftime("%Y-%m")] += r["amount"]

    months = sorted(by_month)
    latest, prior = by_month[months[-1]], by_month[months[-2]]
    assert (latest - prior) / prior > 0.15


def test_demo_seed_clears_stray_goals_on_the_demo_account():
    """Clearing goals by id prefix left behind any goal a user had created by
    hand on the demo account, which then skewed the demo totals. The clear is
    now scoped by ACCOUNT, so a reseed restores exactly the canonical set."""
    seed = _load_seed_module()
    conn = get_db_connection()
    c = conn.cursor()
    now = datetime.now(timezone.utc).isoformat()

    c.execute("""
        INSERT INTO financial_accounts (account_id, name, account_type, currency, created_at)
        VALUES (%s, 'Demo', 'bank', 'INR', %s) ON CONFLICT (account_id) DO NOTHING;
    """, (seed.DEMO_ACCOUNT_ID, now))
    c.execute("""
        INSERT INTO financial_goals
            (goal_id, account_id, goal_name, target_amount, current_amount, risk_preference, status, created_at)
        VALUES ('fgoal_manual_stray', %s, 'Stray Goal', 500000, 0, 'aggressive', 'active', %s);
    """, (seed.DEMO_ACCOUNT_ID, now))
    conn.commit()

    seed.clear_demo_data(conn)

    c.execute("SELECT COUNT(*) as n FROM financial_goals WHERE account_id = %s;", (seed.DEMO_ACCOUNT_ID,))
    remaining = c.fetchone()["n"]
    c.close()
    conn.close()
    assert remaining == 0, "a hand-created goal survived the demo reset"


def test_demo_seed_never_touches_operations_data():
    """The seed must be destructive ONLY to Wealth Navigator demo rows. Incident
    Lab and the rest of the MoneyOps dataset have to survive untouched."""
    import ast
    from pathlib import Path

    seed_path = Path(__file__).resolve().parent.parent.parent / "scripts" / "seed_wealth_demo.py"
    tree = ast.parse(seed_path.read_text(encoding="utf-8"))

    # Inspect the SQL the script actually executes, not its prose. Asserting on
    # raw file text would trip over the module docstring, which discusses these
    # very keywords while describing the safety rules.
    statements = []
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "execute"
                and node.args
                and isinstance(node.args[0], ast.Constant)
                and isinstance(node.args[0].value, str)):
            statements.append(" ".join(node.args[0].value.split()))

    assert statements, "no SQL statements found to inspect"

    protected = ("payments", "orders", "refunds", "webhook_events", "incidents",
                 "ai_investigations", "ai_investigation_steps", "governed_actions",
                 "audit_logs", "incident_lab_runs", "incident_embeddings",
                 "merchants", "eval_ground_truth")

    for sql in statements:
        upper = sql.upper()
        assert "TRUNCATE" not in upper, f"seed script truncates a table: {sql}"
        if upper.startswith("DELETE"):
            assert "WHERE" in upper, f"unpredicated DELETE in seed script: {sql}"
            for table in protected:
                assert f"DELETE FROM {table} " not in f"{sql} ", \
                    f"seed script deletes from the operations table '{table}': {sql}"


def test_demo_seed_uses_personal_finance_categories_not_payment_operations():
    seed = _load_seed_module()
    rows = seed.build_transactions(2026, 8)
    categories = {r["category"] for r in rows}
    assert {"Salary", "Rent", "Groceries", "Dining"}.issubset(categories)

    blob = " ".join(f'{r["merchant"]} {r["description"]}' for r in rows).lower()
    for banned in ("razorpay", "gateway", "webhook", "refund", "incident"):
        assert banned not in blob, f"demo data leaked payment-operations term: {banned}"


def test_agent_system_prompt_keeps_its_safety_rules():
    from app.engine.financial_copilot_agent import SYSTEM_INSTRUCTION
    lowered = SYSTEM_INSTRUCTION.lower()
    assert "get_financial_position" in SYSTEM_INSTRUCTION
    assert "never calculate projections yourself" in lowered
    assert "not a regulated financial adviser" in lowered
    assert "interest rate" in lowered
