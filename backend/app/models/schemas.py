from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
from enum import Enum

class IncidentSeverity(str, Enum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"

class IncidentStatus(str, Enum):
    OPEN = "open"
    INVESTIGATING = "investigating"
    RESOLVED = "resolved"
    CLOSED = "closed"

class ActionTier(str, Enum):
    GREEN_OBSERVE = "green_observe"
    YELLOW_RECOMMEND = "yellow_recommend"
    RED_EXECUTE = "red_execute"

class PaymentStatus(str, Enum):
    CREATED = "created"
    AUTHORIZED = "authorized"
    CAPTURED = "captured"
    FAILED = "failed"
    REFUNDED = "refunded"

class CanonicalEvent(BaseModel):
    canonical_id: str
    event_source: str  # "synthetic", "razorpay_webhook", "simulator"
    event_type: str    # "payment.captured", "refund.processed", etc.
    entity_type: str   # "payment", "refund", "settlement", "dispute"
    entity_id: str
    merchant_id: str
    amount: float
    status: str
    payload: Dict[str, Any]
    ingested_at: str
    is_anomaly: bool = False
    anomaly_score: float = 0.0

class Incident(BaseModel):
    incident_id: str
    title: str
    type: str
    severity: IncidentSeverity
    status: IncidentStatus
    affected_merchants: int
    affected_transactions: int
    potential_exposure: float
    recoverable_exposure: float
    primary_gateway: Optional[str] = None
    error_code: Optional[str] = None
    anomaly_score: float
    detected_at: str
    description: str
    target_entity_id: Optional[str] = None

class HistoricalIncident(BaseModel):
    incident_id: str
    title: str
    type: str
    gateway: Optional[str] = None
    symptoms: List[str]
    root_cause: str
    resolution: str
    financial_exposure: float
    outcome: str
    summary_text: str
    similarity_score: float = 0.0

class AgentStep(BaseModel):
    step_number: int
    title: str
    description: str
    tool_name: str
    tool_input: Dict[str, Any]
    tool_output: Any
    timestamp: str

class InvestigationReport(BaseModel):
    investigation_id: str
    incident_id: str
    incident_type: str
    severity: IncidentSeverity
    confidence: float
    financial_exposure: float
    recoverable_exposure: float
    affected_merchants_count: int
    affected_transactions_count: int
    root_cause: str
    root_cause_hypothesis: str
    evidence: List[str]
    graph_blast_radius: Dict[str, Any]
    similar_incidents: List[HistoricalIncident]
    recommended_action: str
    action_name: str
    action_tier: ActionTier
    requires_approval: bool
    approval_status: str = "pending"
    agent_steps: List[AgentStep]
    investigated_at: str

class ActionApprovalRequest(BaseModel):
    approved: bool
    authorized_by: str
    operator_notes: Optional[str] = None

class AuditLogEntry(BaseModel):
    audit_id: str
    investigation_id: str
    incident_id: str
    timestamp: str
    actor: str
    action_name: str
    action_tier: str
    evidence_summary: List[str]
    tools_called: List[str]
    anomaly_score: float
    ai_confidence: float
    root_cause: str
    recommended_action: str
    approval_status: str
    human_approval: bool
    simulated_action_result: str
    financial_exposure: float

class MerchantBaseline(BaseModel):
    merchant_id: str
    merchant_name: str
    avg_payment_value: float
    payment_success_rate: float
    refund_rate: float
    chargeback_rate: float
    settlement_latency_hrs: float
    avg_retry_count: float
    failure_code_distribution: Dict[str, float]
    gateway_distribution: Dict[str, float]
    historical_anomaly_count: int
    historical_incident_count: int
    current_refund_rate: float
    current_failure_rate: float
    is_anomalous: bool

class AnomalySignal(BaseModel):
    entity_id: str
    entity_type: str
    anomaly_score: float
    is_anomaly: bool
    contributing_signals: List[str]
    raw_features: Dict[str, float]

# Wealth Navigator Models
class CreateGoalRequest(BaseModel):
    account_id: Optional[str] = None
    goal_name: str
    target_amount: float
    target_date: Optional[str] = None
    risk_preference: Optional[str] = "moderate"

class UpdateGoalRequest(BaseModel):
    current_amount: Optional[float] = None
    status: Optional[str] = None

class SimulateScenarioRequest(BaseModel):
    monthly_extra_savings: float = 0.0
    months: int = 12
