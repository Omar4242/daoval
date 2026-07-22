// Coded value sets referenced by the spec. Typeaheads (ICD-10, SNOMED, RxNorm, CVX) are
// stubbed with a representative sample list — wire these to your terminology server
// (e.g. a FHIR $expand on a HAPI FHIR ValueSet, or an external service like a national
// terminology server) in place of TYPEAHEAD_* below.

export const GENDER_CODES = [
  { code: 'male', display: 'Male' },
  { code: 'female', display: 'Female' },
  { code: 'other', display: 'Other' },
  { code: 'unknown', display: 'Unknown' },
]

export const MARITAL_STATUS_CODES = [
  { code: 'S', display: 'Never Married' },
  { code: 'M', display: 'Married' },
  { code: 'D', display: 'Divorced' },
  { code: 'W', display: 'Widowed' },
  { code: 'UNK', display: 'Unknown' },
]

export const LANGUAGE_CODES = [
  { code: 'ar', display: 'Arabic' },
  { code: 'en', display: 'English' },
  { code: 'fr', display: 'French' },
]

export const ENCOUNTER_CLASS_CODES = [
  { code: 'AMB', display: 'Ambulatory' },
  { code: 'EMER', display: 'Emergency' },
  { code: 'IMP', display: 'Inpatient' },
]

export const ALLERGY_CRITICALITY = [
  { code: 'low', display: 'Low' },
  { code: 'high', display: 'High' },
  { code: 'unable-to-assess', display: 'Unable to assess' },
]

export const ALLERGY_VERIFICATION = [
  { code: 'unconfirmed', display: 'Unconfirmed' },
  { code: 'confirmed', display: 'Confirmed' },
  { code: 'refuted', display: 'Refuted' },
]

export const CONDITION_CLINICAL_STATUS = [
  { code: 'active', display: 'Active' },
  { code: 'resolved', display: 'Resolved' },
  { code: 'recurrence', display: 'Recurrence' },
]

export const MEDICATION_FREQUENCY = [
  { code: 'QD', display: 'Once daily' },
  { code: 'BID', display: 'Twice daily' },
  { code: 'TID', display: 'Three times daily' },
  { code: 'QID', display: 'Four times daily' },
  { code: 'PRN', display: 'As needed' },
]

export const AMENDMENT_REASON_CODES = [
  { code: 'correction', display: 'Correction' },
  { code: 'addendum', display: 'Addendum' },
  { code: 'late-entry', display: 'Late entry' },
]

export const SMOKING_STATUS_CODES = [
  { code: '449868002', display: 'Current every day smoker' },
  { code: '428041000124106', display: 'Current some day smoker' },
  { code: '8517006', display: 'Former smoker' },
  { code: '266919005', display: 'Never smoked' },
  { code: '266927001', display: 'Unknown if ever smoked' },
]

// LOINC codes for each vital, with plausible ranges from spec 8.2 (out-of-range warns, never blocks).
export const VITALS_CONFIG = [
  { key: 'systolicBp', label: 'Systolic BP', unit: 'mmHg', loinc: '8480-6', min: 60, max: 260 },
  { key: 'diastolicBp', label: 'Diastolic BP', unit: 'mmHg', loinc: '8462-4', min: 30, max: 150 },
  { key: 'heartRate', label: 'Heart rate', unit: 'bpm', loinc: '8867-4', min: 20, max: 250 },
  { key: 'temperature', label: 'Temperature', unit: '\u00b0C', loinc: '8310-5', min: 30, max: 43 },
  { key: 'respiratoryRate', label: 'Respiratory rate', unit: 'breaths/min', loinc: '9279-1', min: 5, max: 60 },
  { key: 'spo2', label: 'SpO\u2082', unit: '%', loinc: '2708-6', min: 0, max: 100 },
  { key: 'weight', label: 'Weight', unit: 'kg', loinc: '29463-7', min: 0.5, max: 350 },
  { key: 'height', label: 'Height', unit: 'cm', loinc: '8302-2', min: 30, max: 250 },
]

// Sample typeahead source lists (swap for a real terminology service call — e.g. a FHIR
// $expand against a ValueSet on your HAPI FHIR / terminology server). Broader than a
// minimal demo set so common free-typed searches ("fever", "cough", "flu") actually
// resolve to something selectable; still a sample, not a full ICD-10-CM catalog.
export const TYPEAHEAD_ICD10 = [
  { code: 'J06.9', display: 'Acute upper respiratory infection, unspecified' },
  { code: 'J00', display: 'Acute nasopharyngitis (common cold)' },
  { code: 'J02.9', display: 'Acute pharyngitis, unspecified (sore throat)' },
  { code: 'J03.90', display: 'Acute tonsillitis, unspecified' },
  { code: 'J11.1', display: 'Influenza with other respiratory manifestations (flu)' },
  { code: 'J20.9', display: 'Acute bronchitis, unspecified (cough)' },
  { code: 'J18.9', display: 'Pneumonia, unspecified organism' },
  { code: 'R50.9', display: 'Fever, unspecified' },
  { code: 'R05.9', display: 'Cough, unspecified' },
  { code: 'R51', display: 'Headache' },
  { code: 'R11.0', display: 'Nausea' },
  { code: 'R11.2', display: 'Nausea with vomiting, unspecified' },
  { code: 'R10.4', display: 'Other and unspecified abdominal pain' },
  { code: 'K59.00', display: 'Constipation, unspecified' },
  { code: 'A09', display: 'Infectious gastroenteritis and colitis, unspecified (diarrhea)' },
  { code: 'K21.9', display: 'Gastro-esophageal reflux disease without esophagitis' },
  { code: 'I10', display: 'Essential (primary) hypertension' },
  { code: 'E11.9', display: 'Type 2 diabetes mellitus without complications' },
  { code: 'E10.9', display: 'Type 1 diabetes mellitus without complications' },
  { code: 'E78.5', display: 'Hyperlipidemia, unspecified' },
  { code: 'E03.9', display: 'Hypothyroidism, unspecified' },
  { code: 'J45.909', display: 'Unspecified asthma, uncomplicated' },
  { code: 'J44.9', display: 'Chronic obstructive pulmonary disease, unspecified (COPD)' },
  { code: 'N39.0', display: 'Urinary tract infection, site not specified' },
  { code: 'N30.90', display: 'Cystitis, unspecified' },
  { code: 'M54.5', display: 'Low back pain' },
  { code: 'M25.50', display: 'Pain in unspecified joint' },
  { code: 'M79.1', display: 'Myalgia (muscle pain)' },
  { code: 'M54.2', display: 'Cervicalgia (neck pain)' },
  { code: 'L03.90', display: 'Cellulitis, unspecified' },
  { code: 'L30.9', display: 'Dermatitis, unspecified (rash)' },
  { code: 'H10.9', display: 'Conjunctivitis, unspecified' },
  { code: 'H66.90', display: 'Otitis media, unspecified (ear infection)' },
  { code: 'F41.9', display: 'Anxiety disorder, unspecified' },
  { code: 'F32.9', display: 'Major depressive disorder, single episode, unspecified' },
  { code: 'G43.909', display: 'Migraine, unspecified' },
  { code: 'R42', display: 'Dizziness and giddiness' },
  { code: 'R53.83', display: 'Fatigue' },
  { code: 'Z00.00', display: 'Encounter for general adult medical examination' },
  { code: 'Z23', display: 'Encounter for immunization' },
]

export const TYPEAHEAD_SNOMED_ALLERGEN = [
  { code: '387517004', display: 'Amoxicillin' },
  { code: '7980predni', display: 'Penicillin' },
  { code: '227355004', display: 'Peanut' },
  { code: '256259004', display: 'Latex' },
  { code: '763875007', display: 'Ibuprofen' },
]

export const TYPEAHEAD_RXNORM = [
  { code: '308136', display: 'Amoxicillin 500 MG Oral Capsule' },
  { code: '197361', display: 'Metformin 500 MG Oral Tablet' },
  { code: '197436', display: 'Amlodipine 5 MG Oral Tablet' },
  { code: '866924', display: 'Atorvastatin 20 MG Oral Tablet' },
  { code: '313782', display: 'Acetaminophen 500 MG Oral Tablet' },
]

export const TYPEAHEAD_CVX = [
  { code: '208', display: 'COVID-19 vaccine' },
  { code: '158', display: 'Influenza, injectable' },
  { code: '133', display: 'Pneumococcal conjugate PCV 13' },
  { code: '115', display: 'Tdap' },
  { code: '03', display: 'MMR' },
]
