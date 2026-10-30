import Link from 'next/link'
import type { Board, BrandProgress, Flag, StepProgress, Tally } from '@/lib/bfcm/dashboard'
import { PHASE_LABEL } from '@/lib/bfcm/production'
import styles from './BfcmProductionBoard.module.css'

const percent = ({ made, total }: Tally) => total ? Math.round(made / total * 100) : 0
const number = (n: number) => n.toLocaleString('en-US')
const shortDate = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const daysText = (days: number) => days < 0 ? `${-days}d ago` : days === 0 ? 'today' : `${days}d`
const STAGE_LABEL = { none: 'Not onboarded', draft: 'Plan in progress', locked: 'Plan locked' }

type Counts = Pick<Board, 'made' | 'inWork' | 'waiting' | 'notStarted' | 'total'>
function ProgressBar({ counts, label }: { counts: Counts; label: string }) {
  const parts = [
    { key: 'made', value: counts.made, name: 'Made', className: styles.made },
    { key: 'inWork', value: counts.inWork, name: 'In production', className: styles.inWork },
    { key: 'waiting', value: counts.waiting, name: 'Waiting on client', className: styles.waiting },
  ]
  return <div className={styles.bar} role="img" aria-label={`${label}: ${number(counts.made)} of ${number(counts.total)} made`}>
    {parts.filter(p => p.value > 0).map(p => <span key={p.key} className={p.className} style={{ width: `${p.value / Math.max(counts.total, 1) * 100}%` }} title={`${p.name}: ${number(p.value)}`} />)}
  </div>
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return <div className={styles.stat}><span className={styles.statLabel}>{label}</span><strong className={styles.statValue}>{value}</strong><span className={styles.statNote}>{note}</span></div>
}

function Flags({ flags }: { flags: Flag[] }) {
  if (!flags.length) return <span className={styles.faint}>On track</span>
  return <ul className={styles.flags}>{flags.map(f => <li key={f.text} className={f.level === 'critical' ? styles.critical : styles.warning}>{f.text}</li>)}</ul>
}

const STEP_STATUS: Record<StepProgress['status'], { mark: string; name: string; className: string }> = {
  todo: { mark: '○', name: 'Not started', className: styles.stepTodo },
  in_progress: { mark: '◐', name: 'In progress', className: styles.stepWork },
  waiting_client: { mark: '◷', name: 'Waiting on client', className: styles.stepWaiting },
  done: { mark: '✓', name: 'Done', className: styles.stepDone },
}

function Steps({ steps }: { steps: StepProgress[] }) {
  if (!steps.length) return <span className={styles.faint}>No tasks</span>
  return <ul className={styles.steps}>{steps.map(step => {
    const status = STEP_STATUS[step.status]
    return <li key={step.kind} className={status.className} title={`${step.label}: ${status.name}`}><span aria-hidden="true">{status.mark}</span> {step.label}<span className={styles.srOnly}>: {status.name}</span></li>
  })}</ul>
}

function BrandRow({ brand }: { brand: BrandProgress }) {
  return <tr>
    <th scope="row">
      <Link href={`/bfcm-creatives/${brand.slug}`} className={styles.brand}>{brand.name}</Link>
      <span className={styles.faint}>{STAGE_LABEL[brand.stage]}</span>
    </th>
    <td className={styles.progressCell}>
      <div className={styles.cellHead}><strong>{number(brand.made)}</strong> of {number(brand.total)}<span className={styles.faint}>{percent(brand)}%</span></div>
      <ProgressBar counts={brand} label={brand.name} />
    </td>
    <td className={styles.num}>{brand.statics.made} / {brand.statics.total}</td>
    <td className={styles.num}>{brand.motion.made} / {brand.motion.total}</td>
    <td className={styles.launch}>{brand.launch ? <><span className={brand.launch.days < 0 ? styles.lateText : undefined}>{shortDate(brand.launch.date)} · {daysText(brand.launch.days)}</span><span className={styles.faint}>{brand.launch.label}</span></> : <span className={styles.faint}>{brand.made === brand.total ? 'All made' : 'No date'}</span>}</td>
    <td className={styles.num}>{brand.needPerDay === null ? '—' : Math.ceil(brand.needPerDay)}</td>
    <td className={styles.next}><Steps steps={brand.steps} /></td>
    <td className={styles.flagCell}><Flags flags={brand.flags} /></td>
  </tr>
}

export default function BfcmProductionBoard({ board }: { board: Board | null }) {
  if (!board) return <section className={styles.section}><h2 className={styles.title}>Production progress</h2><p role="alert" className="card" style={{ marginTop: 16 }}>Unable to load production. Reload to try again.</p></section>
  const left = board.total - board.made
  return <section className={styles.section} aria-labelledby="bfcm-production-title">
    <div className={styles.head}>
      <h2 id="bfcm-production-title" className={styles.title}>Production progress</h2>
      <p className={styles.sub}>Made counts come from each subtask’s “made so far”. Pace is calendar days to each launch.</p>
    </div>

    <div className={styles.stats}>
      <Stat label="Creatives made" value={`${percent(board)}%`} note={`${number(board.made)} of ${number(board.total)}`} />
      <Stat label="Still to make" value={number(left)} note={`${number(board.inWork)} in production · ${number(board.waiting)} waiting on client`} />
      <Stat label="Needed per day" value={number(Math.ceil(board.needPerDay))} note={board.undatedLeft ? `${number(board.undatedLeft)} more have no launch date` : 'to hit every launch'} />
      <Stat label="Actual per day" value={number(Math.round(board.madePerDay))} note={`7-day average · ${number(board.madeToday)} made today`} />
      <Stat label="Next launch" value={board.launch ? daysText(board.launch.days) : '—'} note={board.launch ? `${board.launch.brand} · ${board.launch.label}, ${shortDate(board.launch.date)}` : 'No launch dates yet'} />
    </div>

    <div className={styles.overall}>
      <ProgressBar counts={board} label="All brands" />
      <ul className={styles.legend}>
        <li><i className={styles.made} />Made {number(board.made)}</li>
        <li><i className={styles.inWork} />In production {number(board.inWork)}</li>
        <li><i className={styles.waiting} />Waiting on client {number(board.waiting)}</li>
        <li><i className={styles.rest} />Not started {number(board.notStarted)}</li>
      </ul>
      <ul className={styles.facts}>
        <li>Statics {number(board.statics.made)} / {number(board.statics.total)}</li>
        <li>Motion {number(board.motion.made)} / {number(board.motion.total)}</li>
        <li>{PHASE_LABEL.pre} {number(board.phases.pre.made)} / {number(board.phases.pre.total)}</li>
        <li>{PHASE_LABEL.bf} {number(board.phases.bf.made)} / {number(board.phases.bf.total)}</li>
        <li>Tasks: {board.tasks.done} done · {board.tasks.inProgress} in progress · {board.tasks.waiting} waiting on client · {board.tasks.todo} not started</li>
        <li>{board.locked} of {board.brands.length} plans locked</li>
        <li>{board.withTasks} of {board.brands.length} brands have tasks</li>
        <li className={board.overdue ? styles.lateText : undefined}>{board.overdue} {board.overdue === 1 ? 'task' : 'tasks'} overdue</li>
      </ul>
    </div>

    <h3 className={styles.subTitle}>By brand, soonest launch first</h3>
    <ul className={styles.legend}>{Object.values(STEP_STATUS).map(status => <li key={status.name} className={status.className}><span aria-hidden="true">{status.mark}</span> {status.name}</li>)}</ul>
    <div className={`${styles.scroll} ${styles.brandTable}`}>
      <table className={styles.table}>
        <thead><tr><th scope="col">Brand</th><th scope="col">Made</th><th scope="col" className={styles.num}>Statics</th><th scope="col" className={styles.num}>Motion</th><th scope="col">Next launch</th><th scope="col" className={styles.num}>Per day</th><th scope="col">Steps</th><th scope="col">Needs attention</th></tr></thead>
        <tbody>{board.brands.map(brand => <BrandRow key={brand.slug} brand={brand} />)}</tbody>
      </table>
    </div>

    <h3 className={styles.subTitle}>Who has what</h3>
    {board.people.length === 0 ? <p className={styles.faint}>No open tasks are assigned yet.</p> : <div className={styles.scroll}>
      <table className={`${styles.table} ${styles.people}`}>
        <thead><tr><th scope="col">Person</th><th scope="col" className={styles.num}>Open tasks</th><th scope="col" className={styles.num}>Overdue</th><th scope="col" className={styles.num}>Creatives on them</th></tr></thead>
        <tbody>{board.people.map(p => <tr key={p.id}><th scope="row">{p.name}</th><td className={styles.num}>{p.open}</td><td className={`${styles.num} ${p.overdue ? styles.lateText : ''}`}>{p.overdue}</td><td className={styles.num}>{number(p.creatives)}</td></tr>)}</tbody>
      </table>
    </div>}
  </section>
}
