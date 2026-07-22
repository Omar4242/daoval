import { createContext, useContext, useState } from 'react'

const PatientContext = createContext(null)

export function PatientProvider({ children }) {
  const [patient, setPatient] = useState(null)
  const [activeEncounter, setActiveEncounter] = useState(null)

  return (
    <PatientContext.Provider value={{ patient, setPatient, activeEncounter, setActiveEncounter }}>
      {children}
    </PatientContext.Provider>
  )
}

export function usePatientContext() {
  return useContext(PatientContext)
}

export function patientDisplayName(patient) {
  if (!patient) return ''
  return patient.name?.[0]?.text || [patient.name?.[0]?.given?.join(' '), patient.name?.[0]?.family].filter(Boolean).join(' ')
}

export function maskedNationalId(patient) {
  const id = patient?.identifier?.find((i) => i.system === 'urn:daoval:national-id')?.value
  if (!id) return '—'
  return `••••••••${id.slice(-4)}`
}
