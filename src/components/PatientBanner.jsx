import { patientDisplayName, maskedNationalId } from '../context/PatientContext'

export default function PatientBanner({ patient, right }) {
  if (!patient) return null
  return (
    <div className="patient-banner">
      <div>
        <div className="name">{patientDisplayName(patient)}</div>
        <div className="meta">
          DOB {patient.birthDate || '—'} &nbsp;·&nbsp; ID {maskedNationalId(patient)} &nbsp;·&nbsp; MRN {patient.id}
        </div>
      </div>
      <div className="spacer" />
      {right}
    </div>
  )
}
