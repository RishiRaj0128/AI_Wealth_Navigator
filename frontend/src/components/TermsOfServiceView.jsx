import React from 'react';
import { Card, Button, Chip } from '../primitives';
import { FileText, ShieldCheck, ArrowLeft } from '../icons';

export default function TermsOfServiceView({ onBack }) {
  return (
    <div style={{ maxWidth: '960px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* Header bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {onBack && (
            <Button variant="ghost" onClick={onBack} icon={ArrowLeft}>
              Back
            </Button>
          )}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <FileText size={20} style={{ color: 'var(--text-secondary)' }} />
              <h1 style={{ fontSize: '22px', fontWeight: 700, margin: 0, letterSpacing: '-0.02em', color: 'var(--text)' }}>
                Terms of Service
              </h1>
              <Chip label="Platform Agreement" variant="neutral" size="small" />
            </div>
            <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: 'var(--text-secondary)' }}>
              Effective Date: September 2024 • Version 1.0 (Demonstration & Research Prototype)
            </p>
          </div>
        </div>
      </div>

      {/* Mandatory Regulatory & Advisory Notice */}
      <Card style={{ borderLeft: '4px solid var(--sev-high)', padding: '18px 20px', background: 'var(--bg-surface)' }}>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
          <ShieldCheck size={20} style={{ color: 'var(--sev-high)', marginTop: '2px', flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', marginBottom: '4px' }}>
              Non-Advisory & Informational Use Notice
            </div>
            <p style={{ margin: 0, fontSize: '13px', lineHeight: '1.6', color: 'var(--text-secondary)' }}>
              Wealth Navigator AI is an algorithmic financial aggregation, transaction variance detection, and scenario simulation technology platform. 
              Wealth Navigator AI is not a registered investment advisor (RIA), broker-dealer, fiduciary, tax consultant, or legal counsel under the Securities and Exchange Board of India (SEBI), the US Securities and Exchange Commission (SEC), or any regulatory jurisdiction.
              No automated insight, scenario projection, cashflow trajectory, or LLM-generated advisor output constitutes investment, tax, or legal advice.
            </p>
          </div>
        </div>
      </Card>

      {/* Terms Sections */}
      <Card style={{ padding: '28px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <section>
          <h2 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>
            1. Scope and Nature of Platform
          </h2>
          <p style={{ fontSize: '13px', lineHeight: '1.7', color: 'var(--text-secondary)', margin: 0 }}>
            The platform provides structured financial analytics, discrepancy detection (e.g. unexpected fee spikes, subscription escalations), deterministic goal projections, and multi-turn financial document queries. The service operates either on user-provided transaction records (CSV/PDF) or deterministic synthetic financial benchmarks provided for demonstration purposes.
          </p>
        </section>

        <section>
          <h2 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>
            2. Source Data and Financial Documents
          </h2>
          <p style={{ fontSize: '13px', lineHeight: '1.7', color: 'var(--text-secondary)', margin: 0 }}>
            Calculations, including monthly savings rate estimations, liquid asset reserves, and incident anomaly flags, are strictly derived from the records ingested into your local or dedicated PostgreSQL database. The user maintains sole responsibility for validating that uploaded bank statements, credit card invoices, and investment schedules represent accurate and authorized records.
          </p>
        </section>

        <section>
          <h2 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>
            3. Artificial Intelligence and Model Limitations
          </h2>
          <p style={{ fontSize: '13px', lineHeight: '1.7', color: 'var(--text-secondary)', margin: 0 }}>
            The AI Advisor feature integrates large language model capabilities (Google Gemini) with structured analytical tool calling. While the system implements grounding protocols against transaction tables and balance records, generative language models may occasionally produce approximations, incomplete category groupings, or conversational misinterpretations. Users should verify calculation details before making capital allocation decisions.
          </p>
        </section>

        <section>
          <h2 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>
            4. User Responsibilities & Account Security
          </h2>
          <p style={{ fontSize: '13px', lineHeight: '1.7', color: 'var(--text-secondary)', margin: 0 }}>
            Users agree not to upload fraudulent documents, malicious binaries, or data for which they do not possess lawful authorization. API keys and deployment environment variables (such as database credentials and AI API keys) configured within self-hosted or cloud deployments remain under the operational control of the deployer.
          </p>
        </section>

        <section>
          <h2 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>
            5. Limitation of Liability
          </h2>
          <p style={{ fontSize: '13px', lineHeight: '1.7', color: 'var(--text-secondary)', margin: 0 }}>
            To the maximum extent permitted by applicable law, Wealth Navigator AI and its contributors shall not be held liable for any direct, indirect, incidental, or consequential damages, including without limitation lost capital, missed investment opportunities, tax penalties, or misreported account balances resulting from reliance on the software.
          </p>
        </section>

        <section>
          <h2 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>
            6. Modifications and Inquiries
          </h2>
          <p style={{ fontSize: '13px', lineHeight: '1.7', color: 'var(--text-secondary)', margin: 0 }}>
            These terms may be updated as new analytical modules, integrations, and regulatory standards are introduced. For administrative inquiries regarding the platform's architectural specifications, consult the system documentation in the repository or contact the deployment maintainer.
          </p>
        </section>
      </Card>
    </div>
  );
}
