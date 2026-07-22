import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { getPatient, saveResource, getLocal } from '../../services/dataService'
import { buildEncounterResource } from '../../fhir/mappers'
import { usePatientContext } from '../../context/PatientContext'
import PatientBanner from '../../components/PatientBanner'
import SyncStatus from '../../components/SyncStatus'
import { ENCOUNTER_CLASS_CODES } from '../../fhir/codes'
import CodeTypeahead from '../../components/CodeTypeahead'
import { TYPEAHEAD_ICD10 } from '../../fhir/codes'

import VitalsSection from './Vitals'
import HistorySection from './History'
import AllergiesSection from './Allergies'
import ExamSection from './Exam'
import AssessmentSection from './Assessment'
import PlanSection from './Plan'
import PreventiveCareSection from './PreventiveCare'

const SECTIONS = [
  { id: 'meta', label: 'Visit' },
  { id: 'vitals', label: 'Vitals' },
  { id: 'history', label: 'History' },
  { id: 'allergies', label: 'Allergies' },
  { id: 'exam', label: 'Exam findings' },
  { id: 'assessment', label: 'Assessment' },
  { id: 'plan', label: 'Plan' },
  { id: 'preventive', label: 'Preventive care' },
]

function nowLocalDatetime() {
  const d = new Date()
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}

const emptyState = {
  meta: { encounterType: 'ambulatory', dateTime: nowLocalDatetime(), reasonCoded: null, reasonFreeText: '' },
  vitals: {},
  history: { chiefComplaint: '', hpi: '' },
  allergies: [],
  exam: { notes: '' },
  assessment: [],
  plan: { medications: [], followUpInstructions: '', followUpDate: '', attachments: [] },
  preventive: { smokingStatus: null, immunizations: [] },
}

export default function NewEncounter() {
  const { patientId, encounterId } = useParams()
  const navigate = useNavigate()
  const { patient, setPatient } = usePatientContext()
  const [encId, setEncId] = useState(encounterId || null)
  const [form, setForm] = useState(emptyState)
  const [savedAt, setSavedAt] = useState(null)
  const saveTimer = useRef(null)

  useEffect(() => {
    getPatient(patientId).then(setPatient)
  }, [patientId, setPatient])

  useEffect(() => {
    if (!encounterId) return
    // Resume an existing draft. The full clinical form (vitals/allergies/exam/etc.,
    // not just visit meta) travels as `_draftForm` on the Encounter resource itself,
    // so it's already wherever the Encounter is — synced to the server when online,
    // or sitting in the in-memory outbox when it isn't. If we have a full draft,
    // prefer it wholesale; otherwise fall back to reconstructing just the visit
    // meta from the FHIR fields (e.g. an encounter that was never drafted here).
    const enc = getLocal('Encounter', encounterId)
    if (!enc) return
    if (enc._draftForm) {
      setForm(enc._draftForm)
      return
    }
    setForm((f) => ({
      ...f,
      meta: {
        encounterType: enc.class?.code === 'AMB' ? 'ambulatory' : enc.class?.code === 'EMER' ? 'emergency' : 'inpatient',
        dateTime: enc.period?.start?.slice(0, 16) || nowLocalDatetime(),
        reasonCoded: enc.reasonCode?.[0]?.coding?.[0]
          ? { code: enc.reasonCode[0].coding[0].code, display: enc.reasonCode[0].coding[0].display }
          : null,
        reasonFreeText: enc.reasonCode?.[0]?.text || '',
      },
    }))
  }, [encounterId])

  function updateSection(section, patch) {
    setForm((f) => ({ ...f, [section]: typeof patch === 'function' ? patch(f[section]) : { ...f[section], ...patch } }))
    scheduleAutosave()
  }

  function scheduleAutosave() {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => autosave(), 2000)
  }

  async function autosave() {
    if (!patientId) return
    // The full clinical form (vitals/allergies/exam/etc. are only turned into their
    // own FHIR resources at Review & Sign) rides along as `_draftForm` on the
    // Encounter resource so it's autosaved through the normal save path — no
    // separate local-only storage needed.
    const resource = { ...buildEncounterResource(patientId, form.meta, encId), _draftForm: form }
    const saved = await saveResource('Encounter', resource)
    setEncId(saved.id)
    setSavedAt(new Date())
    return saved.id
  }

  async function goToReview() {
    clearTimeout(saveTimer.current)
    const id = await autosave()
    navigate(`/patient/${patientId}/encounter/${id}/review`)
  }

  function scrollTo(id) {
    document.getElementById(`section-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="app-shell">
      <div className="topbar">
        <div className="brand">
          Daoval <small>DOCTOR PORTAL</small>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <SyncStatus />
          <span className="hint">{savedAt ? `Autosaved ${savedAt.toLocaleTimeString()}` : 'Not yet saved'}</span>
          <Link to={`/patient/${patientId}`} className="btn btn-ghost">
            Exit to chart
          </Link>
        </div>
      </div>
      <PatientBanner patient={patient} />

      <div className="page wide" style={{ display: 'flex', gap: 28, alignItems: 'flex-start' }}>
        <nav
          style={{
            position: 'sticky',
            top: 76,
            width: 168,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          {SECTIONS.map((s) => (
            <button key={s.id} className="btn btn-ghost" style={{ justifyContent: 'flex-start' }} onClick={() => scrollTo(s.id)}>
              {s.label}
            </button>
          ))}
          <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={goToReview}>
            Review &amp; sign →
          </button>
        </nav>

        <div style={{ flex: 1, minWidth: 0 }}>
          <h1>New encounter</h1>
          <p className="hint" style={{ marginBottom: 16 }}>
            One continuous page — move freely between sections. Autosaves 2 seconds after you stop typing.
          </p>

          <div id="section-meta" className="card section-anchor">
            <h3 style={{ marginBottom: 14 }}>Visit</h3>
            <div className="field-grid">
              <div className="field">
                <label>Encounter type <span className="req">*</span></label>
                <select
                  value={form.meta.encounterType}
                  onChange={(e) => updateSection('meta', { encounterType: e.target.value })}
                >
                  {ENCOUNTER_CLASS_CODES.map((c) => (
                    <option key={c.code} value={c.code === 'AMB' ? 'ambulatory' : c.code === 'EMER' ? 'emergency' : 'inpatient'}>
                      {c.display}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Date / time <span className="req">*</span></label>
                <input
                  type="datetime-local"
                  value={form.meta.dateTime}
                  onChange={(e) => updateSection('meta', { dateTime: e.target.value })}
                  onBlur={autosave}
                />
              </div>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Reason for visit <span className="req">*</span></label>
                <CodeTypeahead
                  options={TYPEAHEAD_ICD10}
                  value={form.meta.reasonCoded}
                  placeholder="Search ICD-10, or just type free text…"
                  allowFreeText
                  onFreeText={(text) => updateSection('meta', { reasonFreeText: text, reasonCoded: null })}
                  onSelect={(opt) => updateSection('meta', { reasonCoded: opt, reasonFreeText: '' })}
                />
                <span className="hint">Coded resolves to a valid ICD-10; free text needs 3–500 characters.</span>
              </div>
            </div>
          </div>

          <VitalsSection value={form.vitals} onChange={(v) => updateSection('vitals', v)} onBlurAutosave={autosave} />
          <HistorySection value={form.history} onChange={(v) => updateSection('history', v)} onBlurAutosave={autosave} />
          <AllergiesSection value={form.allergies} onChange={(v) => updateSection('allergies', () => v)} />
          <ExamSection value={form.exam} onChange={(v) => updateSection('exam', v)} onBlurAutosave={autosave} />
          <AssessmentSection value={form.assessment} onChange={(v) => updateSection('assessment', () => v)} />
          <PlanSection value={form.plan} onChange={(v) => updateSection('plan', () => v)} onBlurAutosave={autosave} />
          <PreventiveCareSection value={form.preventive} onChange={(v) => updateSection('preventive', () => v)} />

          <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={goToReview}>
            Review &amp; sign →
          </button>
        </div>
      </div>
    </div>
  )
}

export { emptyState }
