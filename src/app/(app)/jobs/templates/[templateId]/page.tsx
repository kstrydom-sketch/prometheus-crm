import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { createClient, getCachedUser } from '@/lib/supabase/server'
import { canEditTemplates } from '@/lib/permissions'
import type { WorkflowTemplate } from '@/lib/jobs/model'
import type { TemplateInput } from '@/lib/jobs/templates'
import TemplateEditor from '@/components/jobs/TemplateEditor'
import '@/components/jobs/jobs.css'

const BLANK: TemplateInput = {
  name: '', description: '', uses_month_slot: false, done_label: 'Done', due_label: 'Due',
  stages: [], steps: [],
}

// /jobs/templates/new (optionally ?from=<id> to start from a copy) or /jobs/templates/<id>.
export default async function TemplatePage({ params, searchParams }: {
  params: Promise<{ templateId: string }>
  searchParams: Promise<{ from?: string }>
}) {
  const [{ templateId }, { from }] = await Promise.all([params, searchParams])
  const user = await getCachedUser()
  if (!user) redirect('/login')
  const canManage = canEditTemplates(user.email)
  const isNew = templateId === 'new'
  if (isNew && !canManage) redirect('/jobs/templates')
  const supabase = await createClient()

  const sourceId = isNew ? from : templateId
  const { data } = sourceId ? await supabase.from('workflow_templates').select('*').eq('id', sourceId).maybeSingle() : { data: null }
  const source = data as WorkflowTemplate | null
  if (!isNew && !source) notFound()
  const { count } = isNew ? { count: 0 } : await supabase.from('jobs').select('id', { count: 'exact', head: true }).eq('template_id', templateId)

  const initial: TemplateInput = source
    ? {
        name: isNew ? `${source.name} (copy)` : source.name,
        description: source.description ?? '', uses_month_slot: source.uses_month_slot,
        done_label: source.done_label, due_label: source.due_label, stages: source.stages, steps: source.steps,
      }
    : BLANK
  const title = isNew ? 'New workflow' : source!.name

  return (
    <div className="mo-page">
      <div><Link href="/jobs/templates" className="mo-crumb">← Workflows</Link></div>
      <div>
        <h1 className="mo-h1">{title}</h1>
        {!canManage && <p className="mo-sub">Read only. Ask management to change this workflow.</p>}
        {source?.archived_at && !isNew && <p className="mo-sub">Archived: it can&apos;t be picked for new jobs. Jobs already made from it carry on.</p>}
      </div>
      <TemplateEditor key={templateId + (from ?? '')} id={isNew ? null : templateId} initial={initial} readOnly={!canManage}
        archived={!!source?.archived_at && !isNew} runningJobs={count ?? 0} />
    </div>
  )
}
