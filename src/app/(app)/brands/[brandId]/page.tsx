import { notFound, redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient, getCachedUser } from '@/lib/supabase/server'
import { canEdit } from '@/lib/permissions'
import { getCachedProfiles } from '@/lib/profiles'
import { updateBrandDetails, deleteBrand } from '@/lib/actions'
import ConfirmDeleteForm from '@/components/ConfirmDeleteForm'
import ProfitEngineerSelect from '@/components/ProfitEngineerSelect'
import ClientPortalButton from '@/components/ClientPortalButton'
import OnboardingTranscriptField from '@/components/OnboardingTranscriptField'
import type { Brand, Project, PipelineStatus, BrandDna, BrandDocument, BrandComment } from '@/lib/types'
import { PIPELINE_STATUS_LABELS, PIPELINE_STATUS_ORDER, profileName } from '@/lib/types'
import ProjectCard from '@/components/ProjectCard'
import BrandDnaPanel from '@/components/BrandDnaPanel'
import BrandGuidelines from '@/components/preview/BrandGuidelines'
import BrandDocuments from '@/components/preview/BrandDocuments'
import BrandBrief from '@/components/preview/BrandBrief'
import BrandThread from '@/components/preview/BrandThread'
import ClientRulesBoard from '@/components/brand/ClientRulesBoard'
import ContactsCard from '@/components/brand/ContactsCard'
import IntakeAnswers from '@/components/brand/IntakeAnswers'
import { loadRules, type BrandContact } from '@/lib/brands/profile'
import { formatDue, isOpen, jobStage, orderSteps, stageInfo, STEP_STATUS, type Job, type JobStep } from '@/lib/jobs/model'
import '@/components/jobs/jobs.css'
import '@/components/brand/brand.css'

// Two-step Gemini research + synthesis for Brand DNA can run 30-90s. Vercel's
// default function timeout would cut it off — mirror the pattern used on the
// project pages for the AI image-edit flows. Building from an uploaded brand
// guideline is heavier still: a 40-page PDF is read page by page, so this sits
// at 300 rather than 120.
export const maxDuration = 300

// The brand page is the source of truth for a client. It opens read-only:
// what they have told us, the work in flight, who to talk to, our notes and
// their files. Account details open for editing behind "Edit details".

type BrandJob = Pick<Job, 'id' | 'name' | 'kind' | 'status' | 'due_date' | 'due_label' | 'stages' | 'done_label'> & {
  job_steps: Array<Pick<JobStep, 'id' | 'title' | 'status' | 'stage' | 'is_group' | 'due_date' | 'assignee_id' | 'sort_order' | 'parent_id'>>
}

export default async function BrandPage({
  params, searchParams,
}: {
  params: Promise<{ brandId: string }>
  searchParams: Promise<{ edit?: string }>
}) {
  const [{ brandId }, { edit }] = await Promise.all([params, searchParams])
  const supabase = await createClient()
  const user = await getCachedUser()
  const isAuthorized = await canEdit(user?.email)
  const editing = isAuthorized && edit === '1'

  const { data: brand } = await supabase
    .from('brands')
    .select('*')
    .eq('id', brandId)
    .single()

  if (!brand) notFound()

  // Brand page renders ProjectCard for each row and reads only these fields.
  // The big JSON copy columns (ad_headlines/ad_subcopies/ad_eyebrows/body_copy)
  // and the full ad-brief fields belong to the project detail page, not here.
  // Everything new (contacts, rules, jobs) is tolerant of its migration not
  // having run: supabase-js returns { data: null, error } and the section shows
  // its empty state.
  const [
    { data: projects }, { data: peRows }, { data: dnaRow }, { data: docRows },
    { data: contactRows }, { data: commentRows }, { data: jobRows }, rules, profiles,
  ] = await Promise.all([
    supabase
      .from('projects')
      .select('id, name, brand_id, due_date, is_complete, journey_id, marketing_moment, lp_stage, creatives_stage, lp_approved, creatives_approved, share_token, moment_code')
      .eq('brand_id', brandId)
      .order('due_date', { ascending: true }),
    supabase.from('profit_engineers').select('name').order('name', { ascending: true }),
    supabase.from('brand_dna').select('*').eq('brand_id', brandId).eq('is_active', true).maybeSingle(),
    supabase.from('brand_documents').select('*').eq('brand_id', brandId).order('created_at', { ascending: false }),
    supabase.from('brand_contacts').select('*').eq('brand_id', brandId).order('sort_order'),
    supabase.from('brand_comments').select('*').eq('brand_id', brandId).order('created_at', { ascending: false }),
    supabase
      .from('jobs')
      .select('id, name, kind, status, due_date, due_label, stages, done_label, job_steps(id, title, status, stage, is_group, due_date, assignee_id, sort_order, parent_id)')
      .eq('brand_id', brandId)
      .in('status', ['active', 'on_hold'])
      .order('due_date', { ascending: true }),
    loadRules(supabase, brandId, { includeRetired: true }),
    getCachedProfiles(),
  ])

  const b = brand as Brand
  const allProjects = (projects ?? []) as Project[]
  const engineerNames = (peRows ?? []).map((r: { name: string }) => r.name)
  const dna = (dnaRow ?? null) as BrandDna | null
  const documents = (docRows ?? []) as BrandDocument[]
  const docsOf = (k: 'guidelines' | 'intake' | 'other') => documents.filter(d => (d.kind ?? 'other') === k)
  const contacts = (contactRows ?? []) as BrandContact[]
  const brandComments = (commentRows ?? []) as BrandComment[]
  const jobs = (jobRows ?? []) as unknown as BrandJob[]
  const people = Object.fromEntries(profiles.map(p => [p.id, profileName(p)]))

  const active = allProjects.filter(p => !p.is_complete)
  const done = allProjects.filter(p => p.is_complete)
  const projectNames = Object.fromEntries(allProjects.map(p => [p.id, p.name]))
  const hasGuidelines = docsOf('guidelines').length > 0 || !!b.brand_guidelines

  const clientNumStr = b.client_number != null ? `#${String(b.client_number).padStart(3, '0')}` : null
  const billing = b.is_trial ? { label: 'On trial', color: 'var(--warning)' } : b.is_active ? { label: 'Active', color: 'var(--success)' } : { label: 'Inactive', color: 'var(--danger)' }
  const fmtDate = (d: string) => new Date(d.length === 10 ? `${d}T12:00:00Z` : d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

  async function saveDetails(formData: FormData) {
    'use server'
    await updateBrandDetails(formData)
    redirect(`/brands/${brandId}`)
  }

  return (
    <div className="mo-page">
      <div>
        <Link href="/brands" className="mo-crumb">← Brands</Link>
      </div>

      {/* Header: who they are and the account at a glance */}
      <header className="mo-panel mo-panel-pad bp-head">
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', minWidth: 0 }}>
          {dna?.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={dna.logo_url} alt="" className="bp-mark" style={{ objectFit: 'contain', background: 'var(--surface-2)', border: '1px solid var(--border)' }} loading="lazy" decoding="async" />
          ) : (
            <div className="bp-mark" style={{ background: `hsl(${b.name.charCodeAt(0) * 7 % 360}, 45%, 38%)` }}>{b.name.charAt(0).toUpperCase()}</div>
          )}
          <div style={{ minWidth: 0 }}>
            <div className="mo-row" style={{ gap: 10 }}>
              <h1 className="mo-h1">{b.name}</h1>
              {clientNumStr && <span className="mo-pill" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}>{clientNumStr}</span>}
              <BDStageBadge status={b.pipeline_status} />
              <span className="mo-pill" style={{ color: billing.color, background: `color-mix(in srgb, ${billing.color} 14%, transparent)` }}>{billing.label}</span>
            </div>
            <div className="bp-facts">
              {b.website && <a href={b.website} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>{b.website.replace(/^https?:\/\//, '').replace(/\/$/, '')} ↗</a>}
              {b.start_date && <span>Client since <b>{fmtDate(b.start_date)}</b></span>}
              {b.profit_engineer && <span>Profit engineer <b>{b.profit_engineer}</b></span>}
              {isAuthorized && b.monthly_retainer != null && <span>Retainer <b>${Number(b.monthly_retainer).toLocaleString('en-US')}/mo</b></span>}
            </div>
          </div>
        </div>
        <div className="bp-actions">
          {isAuthorized && !editing && <Link href={`/brands/${brandId}?edit=1`} className="btn-secondary" style={{ fontSize: 14 }}>Edit details</Link>}
          <Link href={`/brands/${brandId}/projects/new`} className="btn-primary" style={{ fontSize: 14 }}>+ New project</Link>
        </div>
      </header>

      {editing && (
        <AccountDetailsForm b={b} brandId={brandId} engineerNames={engineerNames} action={saveDetails} />
      )}

      <div className="bp-layout">
        <div className="bp-col">
          <ClientRulesBoard
            brandId={brandId}
            brandName={b.name}
            rules={rules}
            people={people}
            projects={projectNames}
            canEdit={isAuthorized}
          />

          {/* Work in flight: jobs from the new workflows, and production cards */}
          <section className="mo-panel" aria-label="Active work">
            <div className="bp-card-head" style={{ paddingBottom: 12 }}>
              <h2 className="mo-h2">Active work <span className="mo-count">· {jobs.length + active.length}</span></h2>
              <Link href={`/brands/${brandId}/projects/new`} className="bp-link">+ New project</Link>
            </div>
            {jobs.length === 0 && active.length === 0 ? (
              <p className="bp-empty" style={{ padding: '0 24px 20px' }}>Nothing in flight for {b.name}.</p>
            ) : (
              <>
                {jobs.length > 0 && (
                  <ul className="bp-work">
                    {jobs.map(j => {
                      const work = orderSteps(j.job_steps).filter(s => !s.is_group)
                      const key = jobStage(j.stages, work)
                      const stage = key ? stageInfo(j.stages, key, j.done_label) : null
                      const next = work.find(s => isOpen(s.status))
                      const doneCount = work.filter(s => !isOpen(s.status)).length
                      return (
                        <li key={j.id}>
                          <span className="mo-row" style={{ gap: 10 }}>
                            <Link href={`/jobs/${j.id}`}>{j.name}</Link>
                            {stage && <span className="mo-pill" style={{ color: stage.fg, background: stage.bg }}>{stage.label}</span>}
                            {j.status === 'on_hold' && <span className="mo-pill mo-late">On hold</span>}
                          </span>
                          <span className="mo-muted" style={{ fontSize: 13.5, textAlign: 'right' }}>
                            {j.kind === 'workflow' && <>{doneCount}/{work.length} steps · </>}{j.due_label} {formatDue(j.due_date)}
                          </span>
                          {next && (
                            <span className="bp-next">
                              Next: <b style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{next.title}</b>
                              {' · '}{next.assignee_id ? people[next.assignee_id] ?? 'Someone' : 'Unassigned'}
                              {' · '}{formatDue(next.due_date)}{' · '}
                              <span style={{ color: STEP_STATUS[next.status].fg, fontWeight: 600 }}>{STEP_STATUS[next.status].label}</span>
                            </span>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
                {active.length > 0 && (
                  <div style={{ padding: '14px 24px 20px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <p className="bp-label">Production cards</p>
                    {active.map(p => (
                      <ProjectCard showMomentCode key={p.id} project={p} href={`/brands/${brandId}/projects/${p.id}`} />
                    ))}
                  </div>
                )}
              </>
            )}
            {done.length > 0 && (
              <details style={{ padding: '12px 24px 18px', borderTop: '1px solid var(--border)' }}>
                <summary style={{ cursor: 'pointer', fontSize: 14, color: 'var(--text-muted)', fontWeight: 600 }}>Completed · {done.length}</summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12, opacity: 0.7 }}>
                  {done.map(p => (
                    <ProjectCard showMomentCode key={p.id} project={p} href={`/brands/${brandId}/projects/${p.id}`} />
                  ))}
                </div>
              </details>
            )}
          </section>

          {/* Our notes about the client: the pinned summary, then the running thread */}
          {isAuthorized && (
            <section className="mo-panel" aria-label="Internal notes">
              <div className="bp-card-head">
                <div>
                  <h2 className="mo-h2">Internal notes</h2>
                  <p className="bp-purpose">What the team has learned about {b.name}. Never shown to the client.</p>
                </div>
              </div>
              <div className="bp-card-body">
                <BrandBrief
                  key={`${b.brand_notes ?? ''}::${b.ai_sensitivity ?? ''}`}
                  brandId={brandId}
                  brandName={b.name}
                  notes={b.brand_notes ?? null}
                  sensitivity={b.ai_sensitivity ?? null}
                />
                <BrandThread
                  brandId={brandId}
                  brandName={b.name}
                  comments={brandComments}
                  currentUserId={user?.id ?? null}
                />
              </div>
            </section>
          )}
          {!isAuthorized && b.brand_notes && (
            <section className="mo-panel mo-panel-pad" aria-label="Internal notes">
              <h2 className="mo-h2" style={{ marginBottom: 8 }}>Internal notes</h2>
              <p style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.7, whiteSpace: 'pre-wrap', margin: 0 }}>{b.brand_notes}</p>
            </section>
          )}

          {/* Their files: guidelines (every client should have them), intake, everything else */}
          {isAuthorized && (
            <section className="mo-panel" aria-label="Files">
              <div className="bp-card-head">
                <h2 className="mo-h2">Files <span className="mo-count">· {documents.length}</span></h2>
              </div>
              <div className="bp-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
                <div>
                  <p className="bp-label">Brand guidelines</p>
                  {!hasGuidelines && <div className="bp-warn" style={{ marginBottom: 10 }}>No brand guidelines on file. Every client should have them: ask {contacts.find(c => c.is_primary)?.name ?? 'the client'} for their brand book.</div>}
                  <BrandGuidelines
                    key={brandId}
                    brandId={brandId}
                    brandName={b.name}
                    guidelines={b.brand_guidelines ?? null}
                    documents={docsOf('guidelines')}
                    documentKind="guidelines"
                  />
                </div>
                <div>
                  <p className="bp-label">Intake</p>
                  <IntakeAnswers brandId={brandId} answers={b.intake_answers ?? null} canEdit={isAuthorized} />
                  <BrandDocuments
                    brandId={brandId}
                    documents={docsOf('intake')}
                    kind="intake"
                    title="Intake files"
                    uploadLabel="Upload intake form"
                    uploadHint="The filled-in intake form or questionnaire"
                    emptyText="No intake files."
                  />
                </div>
                <div>
                  <p className="bp-label">Everything else they have shared</p>
                  <BrandDocuments
                    brandId={brandId}
                    documents={docsOf('other')}
                    kind="other"
                    title="Other files"
                    uploadLabel="Upload a file"
                    uploadHint="Product sheets, price lists, research, anything the client sends"
                    emptyText="Nothing else yet."
                  />
                </div>
              </div>
            </section>
          )}

          {isAuthorized && <BrandDnaPanel brandId={brandId} dna={dna} />}
        </div>

        <aside className="bp-col">
          <ContactsCard
            brandId={brandId}
            contacts={contacts}
            channel={b.preferred_channel ?? null}
            channelDetails={b.channel_details ?? null}
            canEdit={isAuthorized}
          />

          {isAuthorized && (
            <section className="mo-panel" aria-label="Account">
              <div className="bp-card-head">
                <h2 className="mo-h2">Account</h2>
                {!editing && <Link href={`/brands/${brandId}?edit=1`} className="bp-link" style={{ fontSize: 13 }}>Edit</Link>}
              </div>
              <div className="bp-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <dl className="bp-dl">
                  <dt>Billing</dt><dd style={{ color: billing.color, fontWeight: 600 }}>{billing.label}</dd>
                  <dt>Retainer</dt><dd>{b.monthly_retainer != null ? `$${Number(b.monthly_retainer).toLocaleString('en-US')}/mo` : '—'}</dd>
                  <dt>Start date</dt><dd>{b.start_date ? fmtDate(b.start_date) : '—'}</dd>
                  <dt>Profit engineer</dt><dd>{b.profit_engineer ?? '—'}</dd>
                  <dt>BD stage</dt><dd>{PIPELINE_STATUS_LABELS[b.pipeline_status]}</dd>
                  <dt>Meta ad account</dt><dd>{b.meta_ad_account_id ?? '—'}</dd>
                  <dt>Account created</dt><dd>{fmtDate(b.created_at)}</dd>
                </dl>
                <div>
                  <p className="bp-label">Client portal link</p>
                  <ClientPortalButton brandId={brandId} initialToken={b.client_token ?? null} />
                </div>
              </div>
            </section>
          )}

          {isAuthorized && (
            <ConfirmDeleteForm
              action={deleteBrand.bind(null, brandId)}
              message={`Delete "${b.name}" and all its projects? This cannot be undone.`}
            >
              <button type="submit" className="bp-link" style={{ color: 'var(--danger)', fontSize: 13, fontWeight: 500 }}>
                Delete brand
              </button>
            </ConfirmDeleteForm>
          )}
        </aside>
      </div>
    </div>
  )
}

function AccountDetailsForm({
  b, brandId, engineerNames, action,
}: {
  b: Brand
  brandId: string
  engineerNames: string[]
  action: (formData: FormData) => Promise<void>
}) {
  const currentStatus = b.is_trial ? 'trial' : b.is_active ? 'active' : 'inactive'
  const statusOptions = [
    { value: 'active', label: 'Active', color: 'var(--success)' },
    { value: 'inactive', label: 'Inactive', color: 'var(--danger)' },
    { value: 'trial', label: 'On Trial', color: 'var(--warning)' },
  ]
  const stageColors: Record<string, string> = {
    intro_contact: 'var(--text-muted)',
    discovery_call: '#60a5fa',
    offer_prep: 'var(--warning)',
    active: 'var(--success)',
  }
  return (
    <section className="mo-panel mo-panel-pad" aria-label="Edit account details">
      <div className="mo-spread" style={{ marginBottom: 18 }}>
        <h2 className="mo-h2">Edit account details</h2>
        <Link href={`/brands/${brandId}`} className="bp-link bp-link-muted">Cancel</Link>
      </div>
      <form action={action}>
        <input type="hidden" name="brand_id" value={brandId} />
        {/* brand_notes is edited in Internal notes; carried through so this save does not clear it. */}
        <input type="hidden" name="brand_notes" value={b.brand_notes ?? ''} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 20, marginBottom: 20 }}>
          <div>
            <label>Monthly Retainer ($)</label>
            <input name="monthly_retainer" type="number" min="0" step="1" defaultValue={b.monthly_retainer ?? ''} placeholder="e.g. 5000" />
          </div>
          <div>
            <label>Start Date</label>
            <input name="start_date" type="date" defaultValue={b.start_date ?? ''} />
          </div>
          <div>
            <label>Profit Engineer</label>
            <ProfitEngineerSelect engineers={engineerNames} current={b.profit_engineer} />
          </div>
          <div>
            <label>Meta Ad Account ID</label>
            <input name="meta_ad_account_id" defaultValue={b.meta_ad_account_id ?? ''} placeholder="act_1234567890" />
            <span style={{ display: 'block', marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
              Feeds the Results tab on this brand&apos;s projects.
            </span>
          </div>
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', marginBottom: 8 }}>BD Pipeline Stage</label>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {PIPELINE_STATUS_ORDER.map((status, i) => {
              const isActive = b.pipeline_status === status
              const color = stageColors[status]
              return (
                <label key={status} style={{
                  display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                  padding: '6px 12px', borderRadius: 7, fontSize: 12, fontWeight: 500,
                  border: `1px solid ${isActive ? color : 'var(--border)'}`,
                  background: isActive ? `color-mix(in srgb, ${color} 15%, transparent)` : 'transparent',
                  color: isActive ? color : 'var(--text-muted)',
                  letterSpacing: 0, textTransform: 'none', marginBottom: 0,
                }}>
                  <input type="radio" name="pipeline_status" value={status} defaultChecked={isActive} style={{ width: 'auto', padding: 0 }} />
                  {i + 1}. {PIPELINE_STATUS_LABELS[status]}
                </label>
              )
            })}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20, padding: '10px 16px', background: 'var(--surface-raised)', borderRadius: 8, border: '1px solid var(--border)', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)', flex: 1 }}>Billing status</span>
          <div style={{ display: 'flex', gap: 4 }}>
            {statusOptions.map(opt => (
              <label key={opt.value} style={{
                display: 'flex', alignItems: 'center', gap: 5,
                cursor: 'pointer', textTransform: 'none', letterSpacing: 0,
                fontSize: 12, fontWeight: 500, marginBottom: 0,
                padding: '5px 10px', borderRadius: 6,
                background: currentStatus === opt.value ? `color-mix(in srgb, ${opt.color} 15%, transparent)` : 'transparent',
                border: `1px solid ${currentStatus === opt.value ? opt.color : 'transparent'}`,
                color: currentStatus === opt.value ? opt.color : 'var(--text-muted)',
              }}>
                <input type="radio" name="client_status" value={opt.value} defaultChecked={currentStatus === opt.value} style={{ width: 'auto', padding: 0 }} />
                {opt.label}
              </label>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 20 }}>
          <OnboardingTranscriptField initialValue={b.onboarding_transcript ?? null} />
        </div>

        <div className="bp-actions">
          <button type="submit" className="btn-primary" style={{ fontSize: 14 }}>Save account details</button>
          <Link href={`/brands/${brandId}`} className="bp-link bp-link-muted">Cancel</Link>
        </div>
      </form>
    </section>
  )
}

const BD_COLORS: Record<PipelineStatus, string> = {
  intro_contact:  'var(--bd-intro)',
  discovery_call: 'var(--bd-discovery)',
  offer_prep:     'var(--bd-offer)',
  active:         'var(--bd-active)',
}

function BDStageBadge({ status }: { status: PipelineStatus }) {
  const color = BD_COLORS[status]
  return (
    <span className="mo-pill" style={{
      color,
      background: `color-mix(in srgb, ${color} 14%, transparent)`,
    }}>
      {PIPELINE_STATUS_LABELS[status]}
    </span>
  )
}
