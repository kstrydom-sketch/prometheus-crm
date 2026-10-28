'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { LockKeyhole, UnlockKeyhole, Check, ArrowLeft, ArrowRight, Play, X } from 'lucide-react'
import { CATEGORIES, approveCopies, lockDraft, reopenDraft, stageQuantities, updateDraft, validateAllocation, validateCopies, validateDraft, validateOffers, type Brand, type Draft, type DraftPatch, type StageOffer } from '@/lib/bfcm/model'
import styles from './BfcmPlanner.module.css'

export type MotionReference = { id: string; title: string; category: string; format: string; thumbnailUrl: string; videoUrl: string }
export type SaveOperation = 'save' | 'approve' | 'lock' | 'reopen' | 'apply-offers'
export type SaveResult = { ok: true; version: number; draft?: Draft } | { ok: false; error: string }
type Props = { brand: Brand; initialDraft: Draft; initialVersion: number; saveAction: (draft: Draft, expectedVersion: number, operation: SaveOperation) => Promise<SaveResult>; motionReferences: MotionReference[]; sourceNotice?: string; backHref?: string }

const ALLOCATION_GROUPS = [
  { label: 'Statics', categories: CATEGORIES.filter(c => c.id === 'textOffer' || c.id === 'refreshedStatic' || c.id === 'newStatic') },
  { label: 'Motion', categories: CATEGORIES.filter(c => c.id === 'refreshedVideo' || c.id === 'motionGraphics') },
]

function ReferenceThumbnail({reference}:{reference:MotionReference}) {
  const [failed,setFailed]=useState(false)
  if(failed) return <div className={styles.preview} style={{display:'grid',placeItems:'center',padding:12,fontSize:12,textAlign:'center'}}>The image is unavailable. Select “Watch” to open the reference.</div>
  // Verified external references intentionally bypass the application image proxy.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={styles.preview} src={reference.thumbnailUrl} alt={reference.title} loading="lazy" decoding="async" onError={()=>setFailed(true)}/>
}

function OfferBlock({ title, offer, disabled, onChange }: {title:string; offer:StageOffer; disabled:boolean; onChange:(offer:StageOffer)=>void}) {
  const patch = (value: Partial<StageOffer>) => onChange({...offer, ...value})
  return <div className={styles.offerBlock}><h3>{title}</h3>
    <label className={styles.field}>Current offer<input className={styles.input} value={offer.offer} disabled={disabled} placeholder="E.g., discount + offer conditions" onChange={e=>patch({offer:e.target.value})}/></label>
    <div className={styles.dates}><label className={styles.field}>Start<input className={styles.input} type="date" lang="en-US" value={offer.startDate} disabled={disabled} onChange={e=>patch({startDate:e.target.value})}/></label><label className={styles.field}>End<input className={styles.input} type="date" lang="en-US" value={offer.endDate} disabled={disabled} onChange={e=>patch({endDate:e.target.value})}/></label></div>
    <label className={styles.check}><input type="checkbox" checked={offer.sitewide} disabled={disabled} onChange={e=>patch({sitewide:e.target.checked})}/>Sitewide</label>
    {!offer.sitewide && <label className={styles.field}>Included products or collections<input className={styles.input} value={offer.included} disabled={disabled} onChange={e=>patch({included:e.target.value})} placeholder="Products, collections or links"/></label>}
    <label className={styles.check}><input type="checkbox" checked={offer.hasExclusions} disabled={disabled} onChange={e=>patch({hasExclusions:e.target.checked})}/>Has exclusions</label>
    {offer.hasExclusions && <label className={styles.field}>Exclusions<input className={styles.input} value={offer.exclusions} disabled={disabled} onChange={e=>patch({exclusions:e.target.value})} placeholder="What is excluded from this offer?"/></label>}
  </div>
}

export default function BfcmPlanner({brand, initialDraft, initialVersion, saveAction, motionReferences, sourceNotice, backHref="/bfcm-creatives"}:Props) {
  const [draft,setDraft]=useState(initialDraft)
  const latest=useRef(initialDraft)
  const version=useRef(initialVersion)
  const savedRevision=useRef(initialDraft.revision)
  const queue=useRef<Promise<boolean>>(Promise.resolve(true))
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null)
  const [saveState,setSaveState]=useState<'saved'|'pending'|'saving'|'error'>('saved')
  const [error,setError]=useState('')
  const [step,setStep]=useState(1)
  const [busy,setBusy]=useState(false)
  const [summary,setSummary]=useState(initialDraft.status==='locked')
  const [confirmed,setConfirmed]=useState(false)
  const [showReopen,setShowReopen]=useState(false)
  const [showApplyOffers,setShowApplyOffers]=useState(false)
  const [filter,setFilter]=useState('All')
  const [playing,setPlaying]=useState<MotionReference|null>(null)
  const [playbackError,setPlaybackError]=useState(false)
  const [historyVersion,setHistoryVersion]=useState<number|null>(null)
  const locked=draft.status==='locked'
  const disabled=locked||busy
  const refs=motionReferences.slice(0,10)
  const categories=['All',...new Set(refs.map(r=>r.category))]
  const total=CATEGORIES.reduce((sum,c)=>sum+draft.allocation[c.id],0)
  const split=stageQuantities(brand.cap,draft.prePercent)
  const allocationGroups=ALLOCATION_GROUPS.map(group=>({
    ...group,
    subtotal:group.categories.reduce((sum,c)=>sum+draft.allocation[c.id],0),
    cap:brand.contract.kind==='exact'
      ?group.categories.reduce((sum,c)=>sum+(brand.contract as Extract<Brand['contract'],{kind:'exact'}>).quantities[c.id],0)
      :brand.contract.kind==='grouped'?(group.label==='Statics'?brand.contract.static:brand.contract.motion):null,
  }))

  const persist=useCallback((value:Draft, operation:SaveOperation='save'):Promise<boolean>=> {
    const task=async()=>{
      if(operation==='save' && value.revision<=savedRevision.current) return true
      setSaveState('saving')
      try {
        const result=await saveAction(value,version.current,operation)
        if(!result.ok) throw new Error(result.error)
        version.current=result.version
        const saved=result.draft??value
        savedRevision.current=saved.revision
        if(operation!=='save' && result.draft) {latest.current=result.draft;setDraft(result.draft)}
        setSaveState(latest.current.revision===savedRevision.current?'saved':'pending')
        setError('')
        return true
      }catch(e){setSaveState('error');setError(e instanceof Error?e.message:'Could not save. Please try again.');return false}
    }
    queue.current=queue.current.then(task,task)
    return queue.current
  },[saveAction])

  const flush=useCallback(async()=>{if(timer.current){clearTimeout(timer.current);timer.current=null} return persist(latest.current)},[persist])
  const edit=(patch:DraftPatch)=>{
    try{const next=updateDraft(latest.current,patch); latest.current=next;setDraft(next);setSaveState('pending');setError('');setConfirmed(false)
      if(timer.current)clearTimeout(timer.current)
      timer.current=setTimeout(()=>{timer.current=null;void persist(latest.current)},800)
    }catch(e){setError(e instanceof Error?e.message:'Could not update the plan.')}
  }
  useEffect(()=>{
    const warn=(event:BeforeUnloadEvent)=>{if(latest.current.revision!==savedRevision.current){event.preventDefault();event.returnValue=''}}
    window.addEventListener('beforeunload',warn)
    return()=>{window.removeEventListener('beforeunload',warn);if(timer.current)clearTimeout(timer.current)}
  },[])
  useEffect(()=>{
    const intercept=(event:MouseEvent)=>{
      if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||latest.current.revision===savedRevision.current)return
      const anchor=(event.target as Element).closest?.('a[href]') as HTMLAnchorElement|null
      if(!anchor||anchor.target==='_blank'||anchor.hasAttribute('download')||anchor.origin!==window.location.origin)return
      event.preventDefault();event.stopPropagation()
      void flush().then(ok=>{if(ok)window.location.assign(anchor.href)})
    }
    document.addEventListener('click',intercept,true)
    return()=>document.removeEventListener('click',intercept,true)
  },[flush])
  useEffect(()=>{
    if(!playing&&!showReopen&&!showApplyOffers)return
    const previous=document.activeElement as HTMLElement|null
    const dialog=document.querySelector<HTMLElement>('[data-bfcm-dialog]')
    const focusable=()=>Array.from(dialog?.querySelectorAll<HTMLElement>('button:not([disabled]),video[controls],a[href],input:not([disabled])')??[])
    focusable()[0]?.focus()
    const close=(event:KeyboardEvent)=>{
      if(event.key==='Escape'&&!busy){setPlaying(null);setShowReopen(false);setShowApplyOffers(false)}
      if(event.key==='Tab'){
        const items=focusable(),first=items[0],last=items[items.length-1]
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}
      }
    }
    window.addEventListener('keydown',close)
    return()=>{window.removeEventListener('keydown',close);previous?.focus()}
  },[playing,showReopen,showApplyOffers,busy])

  async function go(next:number){
    const errors=next>1?[...validateOffers(latest.current.offers),...validateAllocation(brand,latest.current.allocation)]:[]
    if(errors.length){setError(errors.join(' '));return}
    if(next===3 && latest.current.approvedCopiesRevision!==latest.current.copyRevision){setError('Confirm all 30 copy lines before continuing.');return}
    setBusy(true);if(await flush()){setStep(next);setSummary(false);setError('')}setBusy(false)
  }
  async function transition(operation:Exclude<SaveOperation,'save'>){
    setBusy(true)
    try{
      if(!(await flush()))return
      const before=latest.current
      const next=operation==='approve'?approveCopies(before):operation==='lock'?lockDraft(brand,before,confirmed):operation==='reopen'?reopenDraft(before,true):before
      if(await persist(before,operation)){
        // The server may return its authoritative version (including lock time).
        if(latest.current===before){latest.current=next;setDraft(next);savedRevision.current=next.revision;setSaveState('saved')}
        if(operation==='apply-offers')setShowApplyOffers(false)
        if(operation==='approve'){setStep(3);setSummary(false)}
        if(operation==='lock')setSummary(true)
        if(operation==='reopen'){setShowReopen(false);setSummary(false);setStep(1);setConfirmed(false)}
      }
    }catch(e){setError(e instanceof Error?e.message:'Could not complete this action.')}finally{setBusy(false)}
  }
  function review(){const errors=validateDraft(brand,latest.current);if(errors.length){setError(errors.join(' '));return}setError('');setSummary(true)}

  return <main lang="en" className={styles.root}><div className={styles.wrap}>
    <div className={styles.topline}><Link className={styles.back} href={backHref} onClick={async e=>{if(latest.current.revision!==savedRevision.current){e.preventDefault();setError('Save your changes before returning to the list.')}}}><ArrowLeft size={13} style={{display:'inline',verticalAlign:'middle'}}/> BFCM Creatives</Link><div className={`${styles.save} ${saveState==='saved'?styles.saved:''}`} role="status">{saveState==='saved'?<><Check size={13}/>Saved to CRM</>:saveState==='saving'?'Saving…':saveState==='error'?'Not saved':'Unsaved changes'}{saveState==='error'&&<button className={styles.tinyButton} disabled={busy} onClick={()=>void flush()}>Try again</button>}</div></div>
    <header style={{marginTop:28}}><h1 className={styles.heading}>{brand.name}</h1><p className={styles.subtle}>{brand.cap} creatives</p></header>
    <nav className={styles.steps} aria-label="Plan steps">{['Offers & quantity','Copy','Motion & audio'].map((label,i)=><button className={styles.step} key={label} aria-current={!summary&&step===i+1?'step':undefined} disabled={busy||locked} onClick={()=>void go(i+1)}><span>{i+1}</span>{label}</button>)}</nav>
    {error&&<div className={styles.error} role="alert">{error}</div>}
    {locked&&<div className={styles.locked}><strong><LockKeyhole size={16} style={{display:'inline',verticalAlign:'middle'}}/> BFCM plan locked</strong><p style={{fontSize:13,marginTop:6}}>Version {draft.history.length} confirmed. Reopen the plan explicitly to make changes.</p></div>}
    {!summary&&step===1&&<>
      <section className={styles.panel}><h2>Offers</h2><p className={styles.subtle}>Enter the current offer and dates for each stage.</p><div className={styles.offerGrid} style={{marginTop:20}}>{(['pre','bf'] as const).map(stage=><OfferBlock key={stage} title={stage==='pre'?'01 · Pre-Black Friday':'02 · Black Friday'} offer={draft.offers[stage]} disabled={disabled} onChange={offer=>edit({offers:{...draft.offers,[stage]:offer}})}/>)}</div></section>
      <section className={styles.panel}><h2>Quantity & allocation</h2><p className={styles.subtle}>{brand.contract.kind==='exact'?'Contracted quantities by category.':brand.contract.kind==='grouped'?`Contract: ${brand.contract.static} static + ${brand.contract.motion} motion. Category allocation is adjustable.`:'Flexible allocation.'}</p>
        <div className={styles.split}><div className={styles.splitLabels}><span>Pre-BF <strong>{draft.prePercent}%</strong> · {split.pre}</span><span>Black Friday <strong>{100-draft.prePercent}%</strong> · {split.bf}</span></div><input aria-label="Pre-BF creative percentage" type="range" min="0" max="100" value={draft.prePercent} disabled={disabled} onChange={e=>edit({prePercent:Number(e.target.value)})}/><span className={styles.subtle}>Suggested split: 30% / 70%</span></div>
        {allocationGroups.map(group=><section key={group.label} className={styles.allocationGroup} aria-label={`${group.label} allocation`}><div className={styles.allocationGroupHeader}><h3>{group.label}</h3><span aria-label={`${group.label} subtotal`}>{group.subtotal}{group.cap!==null?` / ${group.cap}`:''}</span></div>{group.categories.map(c=>{const isLocked=draft.allocationLocks.includes(c.id);const maximum=brand.contract.kind==='exact'?brand.contract.quantities[c.id]:brand.cap;return <div className={styles.allocation} key={c.id}><span>{c.label}</span><input aria-label={`${c.label} quantity`} type="range" min="0" max={maximum} value={draft.allocation[c.id]} disabled={disabled||isLocked} onChange={e=>edit({allocation:{...draft.allocation,[c.id]:Number(e.target.value)}})}/><input className={styles.input} aria-label={`${c.label} edit quantity`} type="number" min="0" max={maximum} value={draft.allocation[c.id]} disabled={disabled||isLocked} onChange={e=>edit({allocation:{...draft.allocation,[c.id]:Number(e.target.value)}})}/><button className={styles.lock} aria-label={`${isLocked?'Unlock':'Lock'} ${c.label}`} aria-pressed={isLocked} disabled={disabled} onClick={()=>edit({allocationLocks:isLocked?draft.allocationLocks.filter(id=>id!==c.id):[...draft.allocationLocks,c.id]})}>{isLocked?<LockKeyhole size={13} style={{margin:'auto'}}/>:<UnlockKeyhole size={13} style={{margin:'auto'}}/>}</button></div>})}</section>)}
        <div className={styles.totals}><span>Total allocated</span><span>{total} / {brand.cap}</span></div>
      </section></>}
    {!summary&&step===2&&<section className={styles.panel}><h2>Copy</h2><p className={styles.subtle}>Edit any line. By confirming, you also approve the lines you leave unchanged.</p>{sourceNotice&&<div className={styles.warning}>{sourceNotice}</div>}<button className={styles.secondary} disabled={disabled} style={{marginTop:12}} onClick={()=>setShowApplyOffers(true)}>Generate with AI · current offers</button><div style={{marginTop:20}}>{draft.copies.map((copy,i)=><div className={styles.copyrow} key={copy.id}><span className={styles.number}>{String(i+1).padStart(2,'0')}</span><textarea aria-label={`Copy ${i+1}`} className={styles.textarea} rows={2} value={copy.text} disabled={disabled} onChange={e=>edit({copies:draft.copies.map(c=>c.id===copy.id?{...c,text:e.target.value}:c)})}/><span className={styles.tag}>{{'BF anterior':'Previous BF',Recente:'Recent',Nova:'New'}[copy.source]}</span></div>)}</div></section>}
    {!summary&&step===3&&<section className={styles.panel}><h2>Motion references</h2><p className={styles.subtle}>Style references, not editable templates.</p><div className={styles.filters}>{categories.map(category=><button className={styles.filter} aria-pressed={filter===category} key={category} onClick={()=>setFilter(category)}>{category}</button>)}</div>
      {refs.length?<div className={styles.motions}>{refs.filter(r=>filter==='All'||r.category===filter).map(ref=><article key={ref.id} className={`${styles.motion} ${draft.motionIds.includes(ref.id)?styles.motionSelected:''}`}>
        <ReferenceThumbnail reference={ref}/>
        <div className={styles.motionBody}><div className={styles.motionTitle}>{ref.title}</div><div className={styles.subtle} style={{fontSize:10}}>{ref.category} · {ref.format}</div><div className={styles.motionActions}><button className={styles.tinyButton} onClick={()=>{setPlaying(ref);setPlaybackError(false)}} aria-label={`Watch ${ref.title}`}><Play size={10} style={{display:'inline'}}/> Watch</button><label className={styles.check} style={{margin:0,fontSize:10}}><input type="checkbox" checked={draft.motionIds.includes(ref.id)} disabled={disabled} aria-label={`Select ${ref.title}`} onChange={e=>edit({motionIds:e.target.checked?[...draft.motionIds,ref.id]:draft.motionIds.filter(id=>id!==ref.id)})}/>Use</label></div></div>
      </article>)}</div>:<div className={styles.empty}>References are being verified. Unavailable players will not be shown.</div>}
      <div className={styles.options}><label className={styles.check}><input type="checkbox" checked={draft.voiceover} disabled={disabled} onChange={e=>edit({voiceover:e.target.checked})}/>Allow voiceover</label><label className={styles.check}><input type="checkbox" checked={draft.sfx} disabled={disabled} onChange={e=>edit({sfx:e.target.checked})}/>Allow sound effects (SFX)</label></div>
    </section>}
    {summary&&<section className={styles.panel}><h2>Review plan</h2><div className={styles.summaryGrid}>{(['pre','bf'] as const).map(stage=><div key={stage} className={styles.summaryItem}><strong>{stage==='pre'?'Pre-Black Friday':'Black Friday'} · {stage==='pre'?split.pre:split.bf} creatives</strong>{draft.offers[stage].offer}<br/>{draft.offers[stage].startDate} → {draft.offers[stage].endDate}<br/>{draft.offers[stage].sitewide?'Sitewide':draft.offers[stage].included}{draft.offers[stage].hasExclusions&&<><br/>Excluding: {draft.offers[stage].exclusions}</>}</div>)}</div><div className={styles.summaryGrid}>{allocationGroups.map(group=><div key={group.label} className={styles.summaryItem}><div className={styles.allocationGroupHeader}><strong>{group.label}</strong><span aria-label={`${group.label} subtotal`}>{group.subtotal}{group.cap!==null?` / ${group.cap}`:''}</span></div>{group.categories.map(c=><div key={c.id} style={{display:'flex',justifyContent:'space-between'}}><span>{c.label}</span><span>{draft.allocation[c.id]}</span></div>)}</div>)}</div><p className={styles.subtle} style={{marginTop:16}}>30 copy lines {draft.approvedCopiesRevision===draft.copyRevision?'approved':'awaiting approval'} · {draft.motionIds.length} selected references · Voiceover {draft.voiceover?'allowed':'not allowed'} · SFX {draft.sfx?'allowed':'not allowed'}</p>{!locked&&<label className={styles.check}><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/>I confirm this plan’s offers, quantities, copy lines and references.</label>}</section>}
    {draft.history.length>0&&<details className={styles.panel}><summary style={{cursor:'pointer',fontSize:14,fontWeight:700}}>History · {draft.history.length} {draft.history.length===1?'version':'versions'}</summary>{draft.history.map(v=><div className={styles.history} key={v.version}><div className={styles.inline}><strong>Version {v.version}</strong><span className={styles.subtle}>{new Date(v.lockedAt).toLocaleString('en-US')}</span><button className={styles.tinyButton} onClick={()=>setHistoryVersion(historyVersion===v.version?null:v.version)}>{historyVersion===v.version?'Hide':'View version'}</button></div>{historyVersion===v.version&&<div style={{marginTop:12}}><p>Pre-BF: {v.snapshot.offers.pre.offer}</p><p>BF: {v.snapshot.offers.bf.offer}</p><p className={styles.subtle}>{v.snapshot.prePercent}% Pre-BF · {v.snapshot.motionIds.length} references</p>{v.snapshot.copies.map((c,i)=><p key={c.id} className={styles.subtle}>{i+1}. {c.text}</p>)}</div>}</div>)}</details>}
    <footer className={styles.footer}><div>{locked?<span className={styles.subtle}>Confirmed</span>:<button className={styles.secondary} disabled={busy||(!summary&&step===1)} onClick={()=>summary?setSummary(false):void go(step-1)}><ArrowLeft size={13} style={{display:'inline',verticalAlign:'middle'}}/> Back</button>}</div><div className={styles.inline}>{locked?<button className={styles.secondary} disabled={busy} onClick={()=>setShowReopen(true)}>Reopen plan</button>:summary?<button className={styles.primary} disabled={!confirmed||busy} onClick={()=>void transition('lock')}>{busy?'Saving…':'Confirm · BFCM plan locked'}</button>:step===2?<button className={styles.primary} disabled={busy||validateCopies(draft.copies).length>0} onClick={()=>void transition('approve')}>Confirm all 30 copy lines <Check size={14} style={{display:'inline',verticalAlign:'middle'}}/></button>:step===3?<button className={styles.primary} disabled={busy} onClick={review}>Review plan <ArrowRight size={14} style={{display:'inline',verticalAlign:'middle'}}/></button>:<button className={styles.primary} disabled={busy} onClick={()=>void go(2)}>Continue <ArrowRight size={14} style={{display:'inline',verticalAlign:'middle'}}/></button>}</div></footer>
    {showApplyOffers&&<div className={styles.modalBackdrop}><div className={styles.modal} role="dialog" data-bfcm-dialog aria-modal="true" aria-labelledby="apply-offers-title"><h2 id="apply-offers-title" style={{fontWeight:750,fontSize:20}}>Generate 30 copy lines with AI?</h2><p className={styles.subtle} style={{margin:'16px 0'}}>Gemini will generate new copy from the website and current offers. This replaces all 30 lines, including your edits, with new versions using the current Pre-BF and Black Friday offers. Review the lines and confirm again before approval.</p><div className={styles.inline}><button className={styles.secondary} disabled={busy} onClick={()=>setShowApplyOffers(false)}>Cancel</button><button className={styles.primary} disabled={busy} onClick={()=>void transition('apply-offers')}>Replace all 30 copy lines</button></div></div></div>}
    {showReopen&&<div className={styles.modalBackdrop}><div className={styles.modal} role="dialog" data-bfcm-dialog aria-modal="true" aria-labelledby="reopen-title"><h2 id="reopen-title" style={{fontWeight:750,fontSize:20}}>Reopen this plan?</h2><p className={styles.subtle} style={{margin:'16px 0'}}>The current version will remain in history. You must confirm the copy lines again before locking a new version.</p><div className={styles.inline}><button className={styles.secondary} disabled={busy} onClick={()=>setShowReopen(false)}>Cancel</button><button className={styles.primary} disabled={busy} onClick={()=>void transition('reopen')}>Yes, reopen</button></div></div></div>}
    {playing&&<div className={styles.modalBackdrop} onClick={()=>setPlaying(null)}><div className={styles.modal} role="dialog" data-bfcm-dialog aria-modal="true" aria-label={playing.title} onClick={e=>e.stopPropagation()}><div className={styles.topline}><strong>{playing.title}</strong><button autoFocus className={styles.tinyButton} aria-label="Close video" onClick={()=>setPlaying(null)}><X size={16}/></button></div>{playbackError?<div className={styles.error}>This reference is currently unavailable. Close the video and choose another.</div>:<video controls playsInline preload="metadata" poster={playing.thumbnailUrl} src={playing.videoUrl} onError={()=>setPlaybackError(true)}/>}<p className={styles.subtle}>Visual reference · Not an editable template.</p></div></div>}
  </div></main>
}
