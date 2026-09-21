"""
backend/app/engine/financial_copilot_agent.py

Financial Intelligence Copilot — Gemini tool-calling agent grounded in
uploaded financial documents/transactions. Mirrors gemini_agent.py's
proven raw-REST multi-turn tool-calling loop, restricted to the
FINANCIAL_TOOL_REGISTRY (never raw SQL, never invented evidence).
"""

import json
import uuid
import httpx
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional

from app.core.config import settings
from app.engine.database import get_db_connection
from app.engine.financial_tools import FINANCIAL_TOOL_REGISTRY, GEMINI_FINANCIAL_TOOL_DECLARATIONS

SYSTEM_INSTRUCTION = """You are the Wealth Navigator AI Advisor (Financial Intelligence Copilot), an evidence-grounded
financial advisor and analyst over a user's own uploaded financial documents, accounts, and transactions.

STRICT GROUNDING RULES:
1. Base every factual claim exclusively on tool results returned to you in this conversation.
2. Never invent transaction amounts, merchants, dates, documents, or policy clauses.
3. Never claim a fee or transaction is fraudulent/suspicious/illegitimate without direct
   supporting tool evidence (a policy excerpt, a duplicate/recurring match, or an anomalous
   amount compared to real computed statistics).
4. Deterministic numbers (totals, averages, comparisons, duplicate/recurring detections) MUST
   come from calculate_financial_metric, get_spending_summary, compare_periods,
   find_duplicate_transactions, or find_recurring_transactions — never compute or estimate
   these yourself.
4b. When asked about goals, savings scenarios, projections, or next steps, use
    simulate_savings_scenario and recommend_next_actions — never calculate projections yourself.
4c. Every recommendation or projection in your final answer MUST include an "assumptions" array
    in plain language, sourced directly from the tool's own assumptions output — do not invent
    or omit assumptions.
5a. All monetary amounts in this account are Indian Rupees. Always format them with the ₹
   symbol (e.g. ₹1,999.00), never $, USD, or any other currency symbol.
5. Textual/explanatory evidence (policy wording, statement notes) MUST come from
   search_financial_documents or search_financial_policy — cite the exact document and
   page/section returned.
6. If the available tools do not return enough evidence to answer confidently, set
   "insufficient_evidence": true and say plainly what evidence is missing, rather than
   guessing.
7. Never expose private chain-of-thought.
8. When your analysis is complete, return a SINGLE valid JSON object matching this
   schema (populate optional fields when relevant to goals, projections, or recommendations):

{
  "answer": "<Direct, concise, explainable answer to the user's question>",
  "primary_drivers": [
    {"label": "<category or merchant>", "amount": <FLOAT>, "direction": "increase|decrease"}
  ],
  "notable_transactions": [
    {"transaction_id": "<id>", "merchant": "<name>", "amount": <FLOAT>, "date": "<ISO date>", "reason": "<why this transaction is notable>"}
  ],
  "evidence": [
    {"type": "document|transaction|calculation", "detail": "<what this evidence shows>",
     "document_id": "<id or null>", "filename": "<or null>", "page": <int or null>, "section": "<or null>",
     "transaction_id": "<id or null>"}
  ],
  "sources_consulted": [
    {"document_id": "<id>", "filename": "<name>", "page": <int or null>, "section": "<or null>"}
  ],
  "goal_progress": {
    "goal_name": "<name or null>",
    "target_amount": <FLOAT or null>,
    "current_amount": <FLOAT or null>,
    "remaining_needed": <FLOAT or null>,
    "target_date": "<ISO date or null>"
  },
  "scenario_projection": {
    "monthly_extra_savings": <FLOAT or null>,
    "projection_months": <INT or null>,
    "projected_balance": <FLOAT or null>,
    "months_saved": "<INT or string or null>",
    "projected_completion_date": "<ISO date or null>"
  },
  "next_best_actions": [
    {
      "action": "<short plain language recommendation>",
      "category": "<category name>",
      "current_spend": <FLOAT>,
      "monthly_saving": <FLOAT>,
      "goal_impact": "<description of timeline acceleration or null>"
    }
  ],
  "assumptions": [
    "<plain language assumption quoted directly from the tool output>"
  ],
  "insufficient_evidence": <true|false>
}
"""


class FinancialCopilotAgent:

    def __init__(self, max_turns: int = 10, timeout_sec: float = 150.0):
        self.max_turns = max_turns
        self.timeout_sec = timeout_sec

    @property
    def is_configured(self) -> bool:
        key = settings.GEMINI_API_KEY
        return bool(key and not key.startswith("YOUR_") and len(key) > 10)

    def ask(self, query: str) -> Dict[str, Any]:
        if not query or not query.strip():
            return {"status": "error", "error_code": "EMPTY_QUERY", "message": "Query must not be empty."}

        if not self.is_configured:
            return {"status": "error", "error_code": "AI_NOT_CONFIGURED", "message": "Gemini API key is not configured. Please set GEMINI_API_KEY in .env."}

        run_id = f"frun_{uuid.uuid4().hex[:10]}"
        api_key = settings.GEMINI_API_KEY
        model = settings.GEMINI_MODEL or "gemini-2.0-flash"
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"

        tools_payload = [{"functionDeclarations": GEMINI_FINANCIAL_TOOL_DECLARATIONS}]
        system_instruction_payload = {"parts": [{"text": SYSTEM_INSTRUCTION}]}
        contents = [{"role": "user", "parts": [{"text": query}]}]

        tools_called: List[Dict[str, Any]] = []
        retrieved_evidence: List[Any] = []
        final_report: Optional[Dict[str, Any]] = None
        error_code = None
        error_message = None
        turn_count = 0

        while turn_count < self.max_turns:
            turn_count += 1
            request_body = {
                "contents": contents,
                "tools": tools_payload,
                "systemInstruction": system_instruction_payload,
                "generationConfig": {"temperature": 0.1, "maxOutputTokens": 2048}
            }
            try:
                with httpx.Client(timeout=self.timeout_sec) as http_client:
                    response = http_client.post(url, json=request_body, headers={"Content-Type": "application/json"})
            except httpx.TimeoutException:
                error_code, error_message = "AI_TIMEOUT", f"Gemini API request timed out after {self.timeout_sec}s."
                break
            except Exception as e:
                error_code, error_message = "AI_PROVIDER_ERROR", f"Gemini HTTP connection failed: {str(e)}"
                break

            if response.status_code in (400, 403):
                error_code, error_message = "AI_AUTHENTICATION_FAILED", f"Gemini authentication failed (HTTP {response.status_code}): {response.text}"
                break
            elif response.status_code == 429:
                error_code, error_message = "AI_RATE_LIMITED", "Gemini API rate limit reached."
                break
            elif response.status_code != 200:
                error_code, error_message = "AI_PROVIDER_ERROR", f"Gemini returned error status HTTP {response.status_code}: {response.text}"
                break

            resp_data = response.json()
            candidates = resp_data.get("candidates", [])
            if not candidates:
                error_code, error_message = "INVALID_AI_OUTPUT", "Gemini returned no response candidates."
                break

            content_part = candidates[0].get("content", {})
            parts = content_part.get("parts", [])
            function_calls = [p["functionCall"] for p in parts if "functionCall" in p]

            if function_calls:
                contents.append(content_part)
                response_parts = []
                for fc in function_calls:
                    fn_name = fc.get("name")
                    fn_args = fc.get("args", {})

                    if fn_name in FINANCIAL_TOOL_REGISTRY:
                        try:
                            tool_result = FINANCIAL_TOOL_REGISTRY[fn_name](**fn_args)
                        except Exception as te:
                            tool_result = {"error": f"Tool execution failed: {str(te)}"}
                    else:
                        tool_result = {"error": f"Tool '{fn_name}' is not registered"}

                    tools_called.append({"tool_name": fn_name, "arguments": fn_args})
                    retrieved_evidence.append({"tool_name": fn_name, "result": json.loads(json.dumps(tool_result, default=str))})

                    response_parts.append({
                        "functionResponse": {"name": fn_name, "response": {"output": json.loads(json.dumps(tool_result, default=str))}}
                    })
                contents.append({"role": "user", "parts": response_parts})
            else:
                text_response = "".join([p.get("text", "") for p in parts if "text" in p])
                s_idx = text_response.find("{")
                e_idx = text_response.rfind("}") + 1
                if s_idx != -1 and e_idx > s_idx:
                    try:
                        final_report = json.loads(text_response[s_idx:e_idx])
                    except Exception:
                        final_report = {
                            "answer": text_response[:500],
                            "primary_drivers": [], "notable_transactions": [], "evidence": [],
                            "sources_consulted": [], "assumptions": [],
                            "goal_progress": None, "scenario_projection": None, "next_best_actions": [],
                            "insufficient_evidence": True
                        }
                else:
                    final_report = {
                        "answer": "The model did not return a structured answer.",
                        "primary_drivers": [], "notable_transactions": [], "evidence": [],
                        "sources_consulted": [], "assumptions": [],
                        "goal_progress": None, "scenario_projection": None, "next_best_actions": [],
                        "insufficient_evidence": True
                    }
                break

        now_str = datetime.now(timezone.utc).isoformat()
        conn = get_db_connection()
        c = conn.cursor()
        c.execute("""
            INSERT INTO financial_analysis_runs (run_id, query, tools_called_json, retrieved_evidence_json, model, response_json, created_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s);
        """, (
            run_id, query, json.dumps(tools_called), json.dumps(retrieved_evidence, default=str),
            model, json.dumps(final_report or {"error": error_message}), now_str
        ))
        conn.commit()
        c.close()
        conn.close()

        if final_report is None:
            return {"status": "error", "error_code": error_code or "AI_NO_RESPONSE", "message": error_message or "Gemini did not return a final answer within the turn limit.", "run_id": run_id}

        return {"status": "completed", "run_id": run_id, "model": model, "tools_called": tools_called, "report": final_report}


financial_copilot_agent = FinancialCopilotAgent()
