import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import * as authApi from '../../services/authApi'
import * as fhir from '../../services/fhirClient'
import { buildOrganizationResource, buildLocationResource } from '../../fhir/mappers'
import TraceRule from '../../components/TraceRule'
import Brand from '../../components/Brand'

// Deliberately talks to fhirClient rather than dataService. dataService writes through
// the offline outbox and logs an AuditEvent for every save, and administrators are not
// permitted to POST AuditEvent (it is not a directory resource), so each save would
// queue an audit write that can only ever come back 403 and retry forever. Directory
// management is an online, deliberate, low-volume activity that has no use for the
// offline queue. Administrator actions are still recorded server-side in access_log,
// which captures every request regardless of what the app layer chooses to log.

// Physical types from the FHIR location-physical-type value set. Kept to the four that
// actually describe how a hospital department is laid out.
const PHYSICAL_TYPES = [
  { code: 'wa', label: 'Ward' },
  { code: 'ro', label: 'Room' },
  { code: 'bu', label: 'Building' },
  { code: 'si', label: 'Site' },
]

// Starting suggestions for the name field, carried over from the list that used to be
// hardcoded in AdminUsers.jsx. Suggestions only: clicking one fills the box, it does
// not create anything, and a facility whose structure looks different just types its
// own. Nothing is auto-created.
const COMMON_DEPARTMENTS = [
  'Emergency',
  'Internal Medicine',
  'Surgery',
  'Pediatrics',
  'Obstetrics & Gynecology',
  'Cardiology',
  'ICU',
  'Radiology',
  'Laboratory',
  'Pharmacy',
  'Outpatient Clinic',
]

function slugify(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export default function AdminLocations() {
  const { user, signOut } = useAuth()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const [organization, setOrganization] = useState(null)
  const [candidates, setCandidates] = useState([])
  const [orgNameDraft, setOrgNameDraft] = useState('')

  const [locations, setLocations] = useState([])
  const [locationForm, setLocationForm] = useState({ name: '', physicalType: 'wa' })

  async function load() {
    setLoading(true)
    setError('')
    const claim = await authApi.getClaimedOrganization()
    if (!claim.ok) {
      setError(claim.error)
      return setLoading(false)
    }

    if (claim.organizationId) {
      try {
        const org = await fhir.readResource('Organization', claim.organizationId)
        setOrganization(org)
        setLocations(await fhir.searchResource('Location', { organization: org.id }))
      } catch (e) {
        setError(`Could not load the claimed organization: ${e.message}`)
      }
      return setLoading(false)
    }

    // No claim recorded yet. Show whatever organizations already exist so this
    // administrator can claim one rather than create a second record for a facility
    // that is already here. The name on their account pre-fills the box as a
    // convenience, but nothing is matched automatically: two facilities can share a
    // name, and merging them silently is the one failure this flow exists to prevent.
    try {
      setCandidates(await fhir.searchResource('Organization', {}))
    } catch (e) {
      setError(`Could not list existing organizations: ${e.message}`)
    }
    setOrgNameDraft(user?.organization || '')
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  async function claim(organizationId) {
    setBusy(true)
    setError('')
    const res = await authApi.claimOrganization(organizationId)
    setBusy(false)
    if (!res.ok) return setError(res.error)
    load()
  }

  async function createAndClaim(e) {
    e.preventDefault()
    const name = orgNameDraft.trim()
    if (!name) return setError('A name is required.')

    setBusy(true)
    setError('')
    try {
      // No id is supplied here on purpose. createResource on the server upserts when it
      // is given one, so passing a derived or guessed id could overwrite an existing
      // facility's record. Letting the server mint the id makes that impossible.
      const created = await fhir.createResource(
        'Organization',
        buildOrganizationResource({ key: slugify(name), name })
      )
      const res = await authApi.claimOrganization(created.id)
      setBusy(false)
      if (!res.ok) return setError(res.error)
      load()
    } catch (err) {
      setBusy(false)
      setError(err.message)
    }
  }

  async function addLocation(e) {
    e.preventDefault()
    const name = locationForm.name.trim()
    if (!name) return setError('A name is required.')

    setBusy(true)
    setError('')
    try {
      await fhir.createResource(
        'Location',
        buildLocationResource({
          key: `${slugify(organization.name)}:${slugify(name)}`,
          name,
          physicalType: locationForm.physicalType,
          organizationId: organization.id,
        })
      )
      setLocationForm({ name: '', physicalType: 'wa' })
      setLocations(await fhir.searchResource('Location', { organization: organization.id }))
    } catch (err) {
      setError(err.message)
    }
    setBusy(false)
  }

  const alreadyNamed = new Set(locations.map((l) => l.name?.toLowerCase()))

  return (
    <div className="app-shell">
      <div className="topbar">
        <Brand label="ADMINISTRATOR" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Link className="btn btn-ghost" to="/admin/users">
            Healthcare workers
          </Link>
          <span style={{ fontSize: 13.5, color: 'var(--ink-soft)' }}>{user?.name}</span>
          <button className="btn btn-ghost" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>

      <div className="page">
        <h1>Departments and wards</h1>
        <p className="hint" style={{ marginBottom: 18 }}>
          The places inside your facility that care actually happens in. Encounters reference these, so
          records can say where they came from.
        </p>
        <TraceRule />

        {error && <p className="err-text" style={{ marginBottom: 12 }}>{error}</p>}

        {loading ? (
          <div className="card empty-state">Loading…</div>
        ) : !organization ? (
          <>
            <div className="card" style={{ marginBottom: 24 }}>
              <h3 style={{ marginBottom: 8 }}>Which facility is yours?</h3>
              <p className="hint" style={{ marginBottom: 14 }}>
                This is asked once and recorded against your account. Nothing is matched automatically,
                because two facilities can genuinely share a name and merging them would put both of
                their records in one place.
              </p>

              {candidates.length > 0 && (
                <>
                  <p className="hint" style={{ marginBottom: 8 }}>
                    Already set up. Claim one if it is yours:
                  </p>
                  {candidates.map((org) => (
                    <div key={org.id} className="list-row">
                      <div>
                        <strong>{org.name}</strong>
                        <div className="mono hint">{org.identifier?.[0]?.value}</div>
                      </div>
                      <button className="btn btn-ghost" disabled={busy} onClick={() => claim(org.id)}>
                        This is mine
                      </button>
                    </div>
                  ))}
                </>
              )}

              <form onSubmit={createAndClaim} style={{ marginTop: candidates.length > 0 ? 20 : 0 }}>
                <div className="field" style={{ marginBottom: 12 }}>
                  <label>
                    {candidates.length > 0 ? 'Or add a new facility' : 'Facility name'}{' '}
                    <span className="req">*</span>
                  </label>
                  <input
                    type="text"
                    value={orgNameDraft}
                    onChange={(e) => setOrgNameDraft(e.target.value)}
                    placeholder="e.g. Riverside General Hospital"
                    required
                  />
                </div>
                <button className="btn btn-primary" type="submit" disabled={busy}>
                  Create and claim
                </button>
              </form>
            </div>
          </>
        ) : (
          <>
            <div className="card" style={{ marginBottom: 24 }}>
              <h3 style={{ marginBottom: 4 }}>{organization.name}</h3>
              <p className="mono hint" style={{ marginBottom: 14 }}>
                {organization.identifier?.[0]?.value}
              </p>

              <form onSubmit={addLocation}>
                <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label>Name <span className="req">*</span></label>
                    <input
                      type="text"
                      value={locationForm.name}
                      onChange={(e) => setLocationForm({ ...locationForm, name: e.target.value })}
                      placeholder="e.g. Cardiology"
                      required
                    />
                  </div>
                  <div className="field" style={{ width: 160 }}>
                    <label>Kind</label>
                    <select
                      value={locationForm.physicalType}
                      onChange={(e) => setLocationForm({ ...locationForm, physicalType: e.target.value })}
                    >
                      {PHYSICAL_TYPES.map((t) => (
                        <option key={t.code} value={t.code}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <p className="hint" style={{ marginBottom: 10 }}>
                  Common ones (fills the box, adds nothing on its own):{' '}
                  {COMMON_DEPARTMENTS.filter((d) => !alreadyNamed.has(d.toLowerCase())).map((d) => (
                    <button
                      key={d}
                      type="button"
                      className="btn btn-ghost"
                      style={{ padding: '2px 8px', marginRight: 6, fontSize: 12.5 }}
                      onClick={() => setLocationForm({ ...locationForm, name: d })}
                    >
                      {d}
                    </button>
                  ))}
                </p>

                <button className="btn btn-primary" type="submit" disabled={busy}>
                  Add
                </button>
              </form>
            </div>

            <h3 style={{ margin: '26px 0 12px' }}>All departments and wards</h3>
            {locations.length === 0 ? (
              <div className="card empty-state">Nothing added yet.</div>
            ) : (
              locations.map((l) => (
                <div key={l.id} className="list-row">
                  <div>
                    <strong>{l.name}</strong>
                    <div className="mono hint">
                      {PHYSICAL_TYPES.find((t) => t.code === l.physicalType?.[0]?.coding?.[0]?.code)?.label ||
                        'Ward'}
                      {' · '}
                      {l.identifier?.[0]?.value}
                    </div>
                  </div>
                  <span className="hint">{l.status === 'active' ? 'Active' : l.status}</span>
                </div>
              ))
            )}
          </>
        )}
      </div>
    </div>
  )
}
