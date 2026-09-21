const API_BASE = typeof window !== 'undefined' && window.location.hostname === '127.0.0.1' 
  ? 'http://127.0.0.1:8000/api' 
  : 'http://localhost:8000/api';


export async function fetchHealth() {
  const res = await fetch(`${API_BASE}/health`);
  if (!res.ok) throw new Error("Failed to fetch system health");
  return res.json();
}

export async function fetchAIStatus() {
  const res = await fetch(`${API_BASE}/ai/status`);
  if (!res.ok) throw new Error("Failed to fetch AI status");
  return res.json();
}

export async function fetchStats() {
  const res = await fetch(`${API_BASE}/stats`);
  if (!res.ok) throw new Error("Failed to fetch operational stats");
  return res.json();
}

export async function fetchSourceStats() {
  const res = await fetch(`${API_BASE}/stats/sources`);
  if (!res.ok) throw new Error("Failed to fetch source distribution");
  return res.json();
}

export async function fetchIncidents() {
  const res = await fetch(`${API_BASE}/incidents`);
  if (!res.ok) throw new Error("Failed to fetch incidents");
  return res.json();
}

export async function fetchIncidentDetail(incidentId) {
  const res = await fetch(`${API_BASE}/incidents/${incidentId}`);
  if (!res.ok) throw new Error("Failed to fetch incident detail");
  return res.json();
}

export async function runInvestigation(incidentId) {
  const res = await fetch(`${API_BASE}/incidents/${incidentId}/investigate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
  if (!res.ok) {
    const err = await res.json();
    const msg = typeof err.detail === "object" ? err.detail.message : (err.detail || "Investigation failed");
    throw new Error(msg);
  }
  return res.json();
}

export async function fetchInvestigation(investigationId) {
  const res = await fetch(`${API_BASE}/investigations/${investigationId}`);
  if (!res.ok) throw new Error("Failed to fetch investigation");
  return res.json();
}

export async function fetchInvestigationSteps(investigationId) {
  const res = await fetch(`${API_BASE}/investigations/${investigationId}/steps`);
  if (!res.ok) throw new Error("Failed to fetch investigation steps");
  return res.json();
}

export async function fetchIncidentInvestigations(incidentId) {
  const res = await fetch(`${API_BASE}/incidents/${incidentId}/investigations`);
  if (!res.ok) throw new Error("Failed to fetch incident investigations");
  return res.json();
}

// Action Governor API Functions (Phase D)
export async function proposeAction(data) {
  const res = await fetch(`${API_BASE}/actions/propose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to propose action");
  }
  return res.json();
}

export async function approveAction(actionId, notes = "Authorized per FinOps Policy") {
  const res = await fetch(`${API_BASE}/actions/${actionId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actor: "Human_Operator", operator_notes: notes })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to approve action");
  }
  return res.json();
}

export async function rejectAction(actionId, reason = "Human operator rejected action") {
  const res = await fetch(`${API_BASE}/actions/${actionId}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actor: "Human_Operator", reason })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to reject action");
  }
  return res.json();
}

export async function executeAction(actionId) {
  const res = await fetch(`${API_BASE}/actions/${actionId}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actor: "Human_Operator" })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Failed to execute action");
  }
  return res.json();
}

export async function fetchIncidentActions(incidentId) {
  const res = await fetch(`${API_BASE}/incidents/${incidentId}/actions`);
  if (!res.ok) throw new Error("Failed to fetch incident actions");
  return res.json();
}

export async function fetchAuditLogs() {
  const res = await fetch(`${API_BASE}/audit-logs`);
  if (!res.ok) throw new Error("Failed to fetch audit logs");
  return res.json();
}

export async function triggerAnomalyDetection() {
  const res = await fetch(`${API_BASE}/anomalies/detect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
  if (!res.ok) throw new Error("Failed to trigger anomaly detection");
  return res.json();
}

export async function generateLabData(payload = { payments: 800, merchants: 10, anomaly: "auto" }) {
  const res = await fetch(`${API_BASE}/incident-lab/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error("Failed to generate laboratory dataset");
  return res.json();
}

export async function fetchIncidentLabRuns(limit = 10) {
  const res = await fetch(`${API_BASE}/incident-lab/runs?limit=${limit}`);
  if (!res.ok) throw new Error("Failed to fetch Incident Lab run history");
  return res.json();
}

export async function downloadIncidentLabData() {
  const res = await fetch(`${API_BASE}/incident-lab/export`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Failed to export Incident Lab dataset");
  }
  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "moneyops-financial-data.xlsx";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

export async function ingestIncidentLabToCopilot() {
  const res = await fetch(`${API_BASE}/incident-lab/ingest-to-copilot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Failed to ingest Incident Lab dataset into Financial Copilot");
  }
  return res.json();
}

export async function syncRazorpay() {
  const res = await fetch(`${API_BASE}/razorpay/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || "Razorpay sync failed");
  }
  return res.json();
}

export async function fetchPayments(limit = 50, source = null) {
  const url = source ? `${API_BASE}/payments?limit=${limit}&source=${source}` : `${API_BASE}/payments?limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch payments");
  return res.json();
}

export async function fetchOrders(limit = 50, source = null) {
  const url = source ? `${API_BASE}/orders?limit=${limit}&source=${source}` : `${API_BASE}/orders?limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch orders");
  return res.json();
}

export async function fetchRefunds(limit = 50, source = null) {
  const url = source ? `${API_BASE}/refunds?limit=${limit}&source=${source}` : `${API_BASE}/refunds?limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch refunds");
  return res.json();
}

export async function fetchWebhooks(limit = 50) {
  const res = await fetch(`${API_BASE}/webhooks?limit=${limit}`);
  if (!res.ok) throw new Error("Failed to fetch webhooks");
  return res.json();
}

export async function fetchSimilarIncidents(incidentId) {
  const res = await fetch(`${API_BASE}/incidents/${incidentId}/similar`);
  if (!res.ok) throw new Error("Failed to fetch similar incidents");
  return res.json();
}

export async function fetchEvaluation() {
  const res = await fetch(`${API_BASE}/evaluation`);
  if (!res.ok) throw new Error("Failed to fetch evaluation metrics");
  return res.json();
}

export async function runBatchEvaluation() {
  const res = await fetch(`${API_BASE}/evaluation/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  });
  if (!res.ok) throw new Error("Failed to execute batch evaluation");
  return res.json();
}

// Financial Intelligence Copilot API Functions
export async function uploadFinancialDocument(file, documentType, accountName) {
  const formData = new FormData();
  formData.append("file", file);
  if (documentType) formData.append("document_type", documentType);
  if (accountName) formData.append("account_name", accountName);
  const res = await fetch(`${API_BASE}/financial/documents/upload`, {
    method: "POST",
    body: formData
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Document upload failed");
  }
  return res.json();
}

export async function fetchFinancialDocuments() {
  const res = await fetch(`${API_BASE}/financial/documents`);
  if (!res.ok) throw new Error("Failed to fetch financial documents");
  return res.json();
}

export async function fetchFinancialSummary() {
  const res = await fetch(`${API_BASE}/financial/summary`);
  if (!res.ok) throw new Error("Failed to fetch financial summary");
  return res.json();
}

export async function fetchFinancialAccounts() {
  const res = await fetch(`${API_BASE}/financial/accounts`);
  if (!res.ok) throw new Error("Failed to fetch financial accounts");
  return res.json();
}

export async function fetchFinancialTransactions(limit = 100, merchant = null) {
  const url = merchant
    ? `${API_BASE}/financial/transactions?limit=${limit}&merchant=${encodeURIComponent(merchant)}`
    : `${API_BASE}/financial/transactions?limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch financial transactions");
  return res.json();
}

export async function askCopilot(query) {
  const res = await fetch(`${API_BASE}/financial/copilot/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = typeof err.detail === "object" ? err.detail.message : (err.detail || "Copilot query failed");
    throw new Error(msg);
  }
  return res.json();
}

export async function fetchCopilotRuns(limit = 20) {
  const res = await fetch(`${API_BASE}/financial/copilot/runs?limit=${limit}`);
  if (!res.ok) throw new Error("Failed to fetch Copilot run history");
  return res.json();
}

export async function fetchCopilotRun(runId) {
  const res = await fetch(`${API_BASE}/financial/copilot/runs/${runId}`);
  if (!res.ok) throw new Error("Failed to fetch Copilot run detail");
  return res.json();
}

export function financialDocumentDownloadUrl(documentId, disposition = "attachment") {
  return `${API_BASE}/financial/documents/${documentId}/download?disposition=${disposition}`;
}

export async function fetchFinancialDocumentPreview(documentId) {
  const res = await fetch(`${API_BASE}/financial/documents/${documentId}/preview`);
  if (!res.ok) throw new Error("Failed to fetch document preview");
  return res.json();
}

export async function deleteFinancialDocument(documentId) {
  const res = await fetch(`${API_BASE}/financial/documents/${documentId}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Failed to delete document");
  }
  return res.json();
}

// Wealth Navigator: Goals, What-If Scenarios & Proactive Recommendations
export async function createFinancialGoal(goalData) {
  const res = await fetch(`${API_BASE}/financial/goals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(goalData)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Failed to create financial goal");
  }
  return res.json();
}

export async function fetchFinancialGoals(accountId = null, status = "all") {
  const params = new URLSearchParams();
  if (accountId) params.append("account_id", accountId);
  if (status) params.append("status", status);
  const res = await fetch(`${API_BASE}/financial/goals?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to fetch financial goals");
  return res.json();
}

export async function updateFinancialGoal(goalId, updateData) {
  const res = await fetch(`${API_BASE}/financial/goals/${goalId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updateData)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Failed to update financial goal");
  }
  return res.json();
}

export async function simulateGoalScenario(goalId, monthlyExtraSavings, months = 12) {
  const res = await fetch(`${API_BASE}/financial/goals/${goalId}/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      monthly_extra_savings: Number(monthlyExtraSavings) || 0,
      months: Number(months) || 12
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Failed to simulate savings scenario");
  }
  return res.json();
}

export async function fetchGoalRecommendations(goalId) {
  const res = await fetch(`${API_BASE}/financial/goals/${goalId}/recommendations`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Failed to fetch recommendations");
  }
  return res.json();
}



