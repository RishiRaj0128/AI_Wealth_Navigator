import React from 'react';
import { Card, Button, Chip } from '../primitives';
import { ShieldCheck, ArrowLeft, Database, Lock } from '../icons';

export default function PrivacyPolicyView({ onBack }) {
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
              <ShieldCheck size={20} style={{ color: 'var(--cc-accent)' }} />
              <h1 style={{ fontSize: '22px', fontWeight: 700, margin: 0, letterSpacing: '-0.02em', color: 'var(--text)' }}>
                Privacy Policy
              </h1>
              <Chip label="Data Protection" variant="neutral" size="small" />
            </div>
            <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: 'var(--text-secondary)' }}>
              Effective Date: September 2024 • Version 1.0 (Demonstration & Research Prototype)
            </p>
          </div>
        </div>
      </div>

      {/* Summary Highlights */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
        <Card style={{ padding: '18px 20px', background: 'var(--bg-surface)' }}>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '8px' }}>
            <Database size={18} style={{ color: 'var(--cc-accent)' }} />
            <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)' }}>Isolated Database Storage</span>
          </div>
          <p style={{ margin: 0, fontSize: '13px', lineHeight: '1.6', color: 'var(--text-secondary)' }}>
            Financial transactions and account records reside inside a private PostgreSQL instance. Data is segregated and never shared with third-party aggregators or advertisers.
          </p>
        </Card>

        <Card style={{ padding: '18px 20px', background: 'var(--bg-surface)' }}>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '8px' }}>
            <Lock size={18} style={{ color: 'var(--sev-low)' }} />
            <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)' }}>Zero Data Retraining</span>
          </div>
          <p style={{ margin: 0, fontSize: '13px', lineHeight: '1.6', color: 'var(--text-secondary)' }}>
            Analytical requests forwarded to Google Gemini API are executed via stateless API endpoints. Your personal financial data is not used for foundation model training.
          </p>
        </Card>
      </div>

      {/* Policy Details */}
      <Card style={{ padding: '28px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
        <section>
          <h2 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>
            1. Information Processed by Wealth Navigator AI
          </h2>
          <p style={{ fontSize: '13px', lineHeight: '1.7', color: 'var(--text-secondary)', margin: '0 0 8px 0' }}>
            Wealth Navigator AI processes structured financial information necessary to compute cashflows, analyze category distributions, and identify variances:
          </p>
          <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '13px', lineHeight: '1.7', color: 'var(--text-secondary)' }}>
            <li><strong>Account Metadata:</strong> Account identifiers, account names, institution tags, and current balances.</li>
            <li><strong>Transaction Records:</strong> Transaction timestamps, merchant descriptions, normalized categories, transaction amounts, and payment methods.</li>
            <li><strong>Uploaded Artifacts:</strong> PDF/CSV document files parsed through ingestion pipelines.</li>
            <li><strong>Investigation Actions:</strong> Status transitions, resolution notes, and feedback flags recorded in the audit trail.</li>
          </ul>
        </section>

        <section>
          <h2 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>
            2. How Information is Used
          </h2>
          <p style={{ fontSize: '13px', lineHeight: '1.7', color: 'var(--text-secondary)', margin: 0 }}>
            Processed records are used exclusively to calculate cashflow metrics, detect spending anomalies (such as duplicate charges, elevated recurring bills, or sudden spikes in discretionary spending), calculate goal projection timelines, and provide factual context for AI Advisor questions.
          </p>
        </section>

        <section>
          <h2 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>
            3. Third-Party AI Sub-processors
          </h2>
          <p style={{ fontSize: '13px', lineHeight: '1.7', color: 'var(--text-secondary)', margin: 0 }}>
            When using the AI Advisor interface, structured context snippets (e.g. recent merchant summaries or cashflow totals) may be passed to Google Gemini API to interpret natural language queries and synthesize responses. Data transmission is encrypted via TLS 1.3. Google Cloud's API terms state that customer data submitted via enterprise Gemini APIs is not retained to train foundation models.
          </p>
        </section>

        <section>
          <h2 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>
            4. Security and Infrastructure Safeguards
          </h2>
          <p style={{ fontSize: '13px', lineHeight: '1.7', color: 'var(--text-secondary)', margin: 0 }}>
            In cloud environments, backend microservices execute inside private subnets within an AWS VPC behind Application Load Balancers with AWS WAF protection. Relational data is secured in RDS PostgreSQL with encryption at rest (AWS KMS) and security group isolation permitting traffic only from authenticated application tasks.
          </p>
        </section>

        <section>
          <h2 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text)', marginBottom: '8px' }}>
            5. User Control and Data Purge
          </h2>
          <p style={{ fontSize: '13px', lineHeight: '1.7', color: 'var(--text-secondary)', margin: 0 }}>
            Users retain complete control over their uploaded data. You can delete individual documents, wipe simulated goal parameters, or clear PostgreSQL transaction tables at any point through backend management utilities or container redeployment.
          </p>
        </section>
      </Card>
    </div>
  );
}
