import { useState } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { saveResource, listLocal } from '../services/dataService'
import { buildPatientResource, buildConsentResource } from '../fhir/mappers'
import { GENDER_CODES, MARITAL_STATUS_CODES, LANGUAGE_CODES } from '../fhir/codes'
import TraceRule from '../components/TraceRule'
import Brand from '../components/Brand'

const empty = {
  fullName: '',
  nationalId: '',
  dateOfBirth: '',
  sex: '',
  phone: '',
  address: '',
  emergencyContactName: '',
  emergencyContactPhone: '',
  primaryLanguage: '',
  maritalStatus: '',
  consent: false,
}

export default function RegisterPatient() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [form, setForm] = useState({ ...empty, fullName: params.get('name') || '' })
  const [errors, setErrors] = useState({})
  const [duplicate, setDuplicate] = useState(null)
  const [saving, setSaving] = useState(false)

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }))
    if (field === 'nationalId') checkDuplicate(value)
  }

  function checkDuplicate(nationalId) {
    if (nationalId.length !== 14) return setDuplicate(null)
    const match = listLocal('Patient').find((p) => p.identifier?.some((i) => i.value === nationalId))
    setDuplicate(match || null)
  }

  function validate() {
    const e = {}
    if (form.fullName.trim().length < 2 || form.fullName.trim().length > 100 || !/^[A-Za-z\u0600-\u06FF\s-]+$/.test(form.fullName))
      e.fullName = 'Enter 2–100 characters, letters and spaces only.'
    if (!/^\d{14}$/.test(form.nationalId)) e.nationalId = 'National ID must be exactly 14 digits.'
    if (!form.dateOfBirth || new Date(form.dateOfBirth) > new Date()) e.dateOfBirth = 'Enter a valid date, not in the future.'
    if (!form.sex) e.sex = 'Required.'
    if (!/^[\d+\-\s()]{7,}$/.test(form.phone)) e.phone = 'Enter a valid phone number with country code.'
    if (!form.consent) e.consent = 'Consent to treat is required to proceed.'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function submit(e) {
    e.preventDefault()
    if (duplicate) return
    if (!validate()) return
    setSaving(true)
    const patient = await saveResource('Patient', buildPatientResource(form))
    await saveResource('Consent', buildConsentResource(patient.id), { auditAction: 'write-consent' })
    setSaving(false)
    navigate(`/patient/${patient.id}`)
  }

  return (
    <div className="app-shell">
      <div className="topbar">
        <Brand label="DOCTOR PORTAL" />
        <Link to="/dashboard" className="btn btn-ghost">
          ← Dashboard
        </Link>
      </div>
      <div className="page">
        <h1>Register patient</h1>
        <p className="hint" style={{ marginBottom: 18 }}>
          A new FHIR Patient record. Address and emergency contact aren't required for this MVP.
        </p>
        <TraceRule />

        {duplicate && (
          <div className="card" style={{ borderColor: 'var(--accent)', background: 'var(--accent-soft)' }}>
            <strong>A patient with this National ID already exists.</strong>
            <p className="hint" style={{ margin: '6px 0 10px' }}>
              {duplicate.name?.[0]?.text} · DOB {duplicate.birthDate}
            </p>
            <Link to={`/patient/${duplicate.id}`} className="btn btn-secondary">
              Open existing chart instead
            </Link>
          </div>
        )}

        <form onSubmit={submit}>
          <div className="card">
            <h3 style={{ marginBottom: 14 }}>Demographics</h3>
            <div className="field-grid">
              <div className={`field ${errors.fullName ? 'invalid' : ''}`}>
                <label>Full name <span className="req">*</span></label>
                <input type="text" value={form.fullName} onChange={(e) => set('fullName', e.target.value)} />
                {errors.fullName && <span className="err-text">{errors.fullName}</span>}
              </div>
              <div className={`field ${errors.nationalId ? 'invalid' : ''}`}>
                <label>National ID <span className="req">*</span></label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={14}
                  className="mono"
                  value={form.nationalId}
                  onChange={(e) => set('nationalId', e.target.value.replace(/\D/g, ''))}
                />
                {errors.nationalId && <span className="err-text">{errors.nationalId}</span>}
              </div>
              <div className={`field ${errors.dateOfBirth ? 'invalid' : ''}`}>
                <label>Date of birth <span className="req">*</span></label>
                <input type="date" value={form.dateOfBirth} onChange={(e) => set('dateOfBirth', e.target.value)} />
                {errors.dateOfBirth && <span className="err-text">{errors.dateOfBirth}</span>}
              </div>
              <div className={`field ${errors.sex ? 'invalid' : ''}`}>
                <label>Sex <span className="req">*</span></label>
                <select value={form.sex} onChange={(e) => set('sex', e.target.value)}>
                  <option value="">Select…</option>
                  {GENDER_CODES.map((g) => (
                    <option key={g.code} value={g.code}>
                      {g.display}
                    </option>
                  ))}
                </select>
                {errors.sex && <span className="err-text">{errors.sex}</span>}
              </div>
              <div className={`field ${errors.phone ? 'invalid' : ''}`}>
                <label>Phone number <span className="req">*</span></label>
                <input type="tel" placeholder="+20 10 1234 5678" value={form.phone} onChange={(e) => set('phone', e.target.value)} />
                {errors.phone && <span className="err-text">{errors.phone}</span>}
              </div>
              <div className="field">
                <label>Address</label>
                <input type="text" value={form.address} onChange={(e) => set('address', e.target.value)} />
              </div>
              <div className="field">
                <label>Emergency contact name</label>
                <input type="text" value={form.emergencyContactName} onChange={(e) => set('emergencyContactName', e.target.value)} />
              </div>
              <div className="field">
                <label>Emergency contact phone</label>
                <input type="tel" value={form.emergencyContactPhone} onChange={(e) => set('emergencyContactPhone', e.target.value)} />
              </div>
              <div className="field">
                <label>Primary language</label>
                <select value={form.primaryLanguage} onChange={(e) => set('primaryLanguage', e.target.value)}>
                  <option value="">Select…</option>
                  {LANGUAGE_CODES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.display}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Marital status</label>
                <select value={form.maritalStatus} onChange={(e) => set('maritalStatus', e.target.value)}>
                  <option value="">Select…</option>
                  {MARITAL_STATUS_CODES.map((m) => (
                    <option key={m.code} value={m.code}>
                      {m.display}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="card" style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              style={{ marginTop: 3 }}
              checked={form.consent}
              onChange={(e) => set('consent', e.target.checked)}
            />
            <div>
              <strong>Consent to treat</strong>
              <p className="hint">Patient (or guardian) has consented to treatment. Required to create this record.</p>
              {errors.consent && <p className="err-text">{errors.consent}</p>}
            </div>
          </div>

          <button className="btn btn-primary" type="submit" disabled={saving || !!duplicate}>
            {saving ? 'Saving…' : 'Create patient record'}
          </button>
        </form>
      </div>
    </div>
  )
}
