import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient, getCachedUser } from '@/lib/supabase/server'
import { getCachedProfiles } from '@/lib/profiles'
import { canEditTemplates } from '@/lib/permissions'
import { DONE_STAGE, stageInfo, templateLength, type WorkflowTemplate } from '@/lib/jobs/model'
import '@/components/jobs/jobs.css'

const when = (iso: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso))

export default async function TemplatesPage() {
  const user = await getCachedUser()
  if (!user) redirect('/login')
  const supabase = await createClient()
  const profiles = await getCachedProfiles()
  const canManage = canEditTemplates(user.email)

  const [{ data: templatesRaw }, { data: jobsRaw }] = await Promise.all([
    supabase.from('workflow_templates').select('*').order('archived_at', { nullsFirst: true }).order('sort_order').order('name'),
    supabase.from('jobs').select('template_id, status').not('template_id', 'is', null),
  ])
  const templates = (templatesRaw ?? []) as WorkflowTemplate[]
  const jobs = jobsRaw ?? []
  const count = (id: string) => jobs.filter(j => j.template_id === id && (j.status === 'active' || j.status === 'on_hold')).length
  const nameOf = (id: string | null) => profiles.find(p => p.id === id)?.full_name ?? null

  return (
    <div className="mo-page">
      <div><Link href="/jobs" className="mo-crumb">← Jobs</Link></div>
      <div className="mo-spread">
        <div>
          <h1 className="mo-h1">Workflows</h1>
          <p className="mo-sub">
            The step lists new jobs start from. A job copies its workflow when it&apos;s created, so changes here only affect new jobs.
            {!canManage && ' Only management can change them.'}
          </p>
        </div>
        {canManage && <Link href="/jobs/templates/new" className="btn-primary">+ New workflow</Link>}
      </div>

      <section className="mo-panel">
        {templates.length === 0 && <p className="mo-empty">No workflows yet.</p>}
        {templates.map(t => {
          const editor = nameOf(t.updated_by)
          return (
            <div key={t.id} className="tp-card" style={t.archived_at ? { opacity: 0.6 } : undefined}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                <div className="mo-row" style={{ gap: 10 }}>
                  <Link href={`/jobs/templates/${t.id}`} style={{ fontWeight: 700, fontSize: 17, color: 'var(--text-primary)' }}>{t.name}</Link>
                  {t.uses_month_slot && <span className="mo-pill">Month + slot</span>}
                  {t.archived_at && <span className="mo-pill">Archived</span>}
                </div>
                {t.description && <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>{t.description}</span>}
                <div className="mo-row" style={{ gap: 6 }}>
                  {[...t.stages.map(s => s.key), DONE_STAGE].map(k => {
                    const info = stageInfo(t.stages, k, t.done_label)
                    return <span key={k} className="mo-pill" style={{ fontSize: 12.5, color: info.fg, background: info.bg }}>{info.label}</span>
                  })}
                </div>
                <span className="mo-muted" style={{ fontSize: 13 }}>
                  {t.steps.length} steps · {t.due_label} on day {templateLength(t.steps)}
                  {editor ? ` · last changed by ${editor}, ${when(t.updated_at)}` : ''}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
                <Link href={`/jobs?show=active&type=${t.id}`} className="mo-crumb">{count(t.id)} active job{count(t.id) === 1 ? '' : 's'} →</Link>
                {canManage && <Link href={`/jobs/templates/new?from=${t.id}`} className="mo-crumb">Duplicate</Link>}
              </div>
            </div>
          )
        })}
      </section>
    </div>
  )
}
