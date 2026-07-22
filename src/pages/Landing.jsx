import { Link } from 'react-router-dom'
import TraceRule from '../components/TraceRule'

const PILLARS = [
  {
    title: 'One record, not five logins',
    body: 'Daoval pulls a patient\'s history together across the systems your hospital already runs, instead of asking clinicians to piece it together by hand.',
  },
  {
    title: 'Built on FHIR',
    body: 'Encounters, observations, and patient records are structured to the FHIR standard from the moment they\'re entered — so the data is portable by default, not as an afterthought.',
  },
  {
    title: 'Fast at the bedside',
    body: 'Encounter entry is built for speed during a real shift — structured underneath, quick to use on top.',
  },
]

export default function Landing() {
  return (
    <div className="app-shell">
      <div className="topbar">
        <div className="brand">Daoval</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/sign-in?portal=clinician" className="btn btn-secondary">
            Clinician sign in
          </Link>
          <Link to="/sign-in?portal=admin" className="btn btn-primary">
            Administrator sign in
          </Link>
        </div>
      </div>

      <div style={{ maxWidth: 760, margin: '0 auto', padding: '72px 24px 48px', textAlign: 'center' }}>
        <h1 style={{ fontSize: 38, lineHeight: 1.15, marginBottom: 16, letterSpacing: '-0.015em' }}>
          Unifying fragmented patient records, one hospital at a time.
        </h1>
        <p style={{ fontSize: 16, color: 'var(--ink-soft)', maxWidth: 560, margin: '0 auto 28px' }}>
          Daoval connects your hospital's clinical documentation into a single, FHIR-structured record —
          so the next clinician who sees this patient isn't starting from zero.
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Link to="/sign-in?portal=clinician" className="btn btn-secondary" style={{ fontSize: 15, padding: '11px 24px' }}>
            I'm a doctor or nurse
          </Link>
          <Link to="/sign-in?portal=admin" className="btn btn-primary" style={{ fontSize: 15, padding: '11px 24px' }}>
            I'm an administrator
          </Link>
        </div>
      </div>

      <div style={{ maxWidth: 800, margin: '0 auto', padding: '0 24px 24px' }}>
        <TraceRule animate tall />
      </div>

      <div style={{ maxWidth: 900, margin: '0 auto', padding: '0 24px 80px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 20 }}>
        {PILLARS.map((p) => (
          <div key={p.title} className="card">
            <h3 style={{ marginBottom: 8, fontSize: 16 }}>{p.title}</h3>
            <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', lineHeight: 1.55 }}>{p.body}</p>
          </div>
        ))}
      </div>

      <div style={{ textAlign: 'center', padding: '0 24px 60px' }}>
        <p className="hint">
          Accounts are provisioned by your hospital's Daoval administrator — there's no public sign-up.
        </p>
      </div>
    </div>
  )
}
