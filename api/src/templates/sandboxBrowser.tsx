import type { FC } from 'hono/jsx';
import { css } from 'hono/css';
import { btnStyle } from './layout';

const controlsStyle = css`
  [hidden] { display: none !important; }
  summary { cursor: pointer; color: #006aad; }
  .browser-secondary { background: transparent; border: 1px solid #767676;
    border-radius: 4px; padding: 0.45rem 0.7rem; font: inherit; cursor: pointer; }
  .browser-actions { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
  .browser-note { color: #555; font-size: 0.9rem; }
  .browser-status-box { display: flex; align-items: center; gap: 0.75rem;
    background: #f0f6f2; border: 1px solid #b7cebe; border-radius: 6px;
    padding: 0.65rem 0.85rem; margin: 0 0 1rem; }
  .browser-status-box p { margin: 0; flex: 1; font-size: 0.9rem; }
  .browser-refresh { display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; flex-shrink: 0; background: transparent;
    border: none; border-radius: 4px; color: #365a43; cursor: pointer; }
  .browser-refresh:hover { background: #dcebe1; }
  .browser-timeline { padding-left:1.3rem; font-size:0.9rem; }
  .browser-timeline li { margin:0.4rem 0; }
  .browser-timing { color:#555; font-size:0.85rem; }
  .browser-meter { margin:1.2rem 0; }
  .browser-milestones { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:0.5rem; }
  .browser-milestone { position:relative; padding-top:1.5rem; font-size:0.75rem; color:#555; }
  .browser-milestone::before { content:''; position:absolute; top:0.4rem; left:0; right:0;
    height:4px; border-radius:2px; background:#dcebe1; }
  .browser-milestone::after { content:''; position:absolute; top:0.4rem; left:0;
    width:var(--fill,0%); height:4px; border-radius:2px; background:#365a43;
    transition:width 0.35s linear; }
  .browser-pip { position:absolute; top:0; left:0; width:16px; height:16px; border-radius:50%;
    border:2px solid #767676; background:#fafafa; box-sizing:border-box; z-index:1; }
  .browser-milestone[data-state=done] .browser-pip { background:#365a43; border-color:#365a43; }
  .browser-milestone[data-state=current] { color:#003c6c; font-weight:600; }
  .browser-milestone[data-state=current] .browser-pip { border-color:#006aad; box-shadow:0 0 0 3px #dcebe1; }
  .browser-milestone[data-state=current]::after { animation:browser-working 2s ease-in-out infinite; }
  @keyframes browser-working { 50% { opacity:0.55; } }
  @media (prefers-reduced-motion:reduce) {
    .browser-milestone::after { transition:none; animation:none !important; }
  }
  .browser-milestone[data-state=failed] .browser-pip { border-color:#a01830; background:#f8d7da; }
  .browser-estimate { font-size:0.85rem; color:#555; margin:0.75rem 0 0; }
`;

/** Progressive enhancement: the rest of the sandbox/API card remains usable. */
export const SandboxBrowserControls: FC = () => <section class={controlsStyle} id="sandbox" aria-label="Browser access">
  <div class="browser-status-box">
    <p id="browser-status" role="status" aria-live="polite">Checking status…</p>
    <button type="button" class="browser-refresh" id="browser-refresh" aria-label="Refresh status" title="Refresh status">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 17.9 17" />
      </svg>
    </button>
  </div>
  <div id="browser-meter" class="browser-meter" hidden>
    <div id="browser-meter-bar" role="progressbar" aria-label="Estimated sandbox setup progress" aria-valuemin="0" aria-valuemax="100">
      <div id="browser-milestones" class="browser-milestones" aria-hidden="true"></div>
    </div>
    <p id="browser-estimate" class="browser-estimate"></p>
  </div>
  <p id="browser-timing" class="browser-timing" hidden></p>
  <p id="browser-previous" class="browser-note" hidden></p>
  <details id="browser-progress" hidden>
    <summary>Setup activity</summary>
    <ol id="browser-timeline" class="browser-timeline"></ol>
  </details>
  <div class="browser-actions">
    <button type="button" class={btnStyle} id="browser-start" hidden>Set up sandbox</button>
    <a class={btnStyle} id="browser-open" hidden target="_blank" rel="noopener noreferrer">Open sandbox</a>
    <span class="browser-note" id="browser-deadline"></span>
    <button type="button" class="browser-secondary" id="browser-continue" hidden>Extend 6 hours</button>
  </div>
  <p id="browser-intro" class="browser-note" hidden>Opens OpenChamber with BayLeaf and your files. First setup takes a few minutes.</p>
  <details style="margin-top:1rem"><summary>Browser options &amp; help</summary>
    <div class="browser-actions" style="margin-top:0.75rem">
      <button type="button" class="browser-secondary" id="browser-restart" hidden>Restart interface</button>
      <button type="button" class="browser-secondary" id="browser-stop" hidden>End browser work</button>
    </div>
    <p class="browser-note">Browser access lasts six hours. You can extend it during the last hour.
      Idle sleep may happen sooner. Files and history persist; running tasks stop when the sandbox sleeps.</p>
    <p class="browser-note">This is the same sandbox used by Chat and the API. Setup stores your BayLeaf key inside it,
      where programs you run can access it. Use Chat or the file API to export files and history.</p>
  </details>
  <noscript>Enable JavaScript for browser setup, or use the ordinary-key /sandbox/browser API.</noscript>
  <script dangerouslySetInnerHTML={{ __html: `(() => {
    const el = id => document.getElementById('browser-' + id);
    const labels = { locating_sandbox:'Locating your sandbox', creating_sandbox:'Creating your sandbox',
      starting_sandbox:'Starting or restoring your sandbox', preparing_setup:'Preparing browser setup',
       checking:'Checking the managed installation', installing:'Installing browser tools',
       configuring:'Configuring the workspace', starting:'Starting OpenChamber', ready:'Ready',
       installing_openchamber:'Installing current OpenChamber', installing_opencode:'Preparing OpenCode with the upstream installer',
       starting_openchamber:'Starting OpenChamber', waiting_for_opencode:'Waiting for OpenCode to respond',
       connecting_bayleaf:'Connecting your BayLeaf account', loading_tools:'Loading BayLeaf tools and skills',
       checking_readiness:'Checking workspace readiness', registering_preview:'Creating private browser access',
       waiting_for_toolbox:'Waiting for the sandbox connection; retrying automatically',
       failed:'Setup failed', expired:'Work period expired', stopped:'Browser work ended' };
    const errors = { node_22_required:'Your sandbox’s software needs an update. Contact BayLeaf support.',
      insufficient_disk:'Your sandbox needs more free storage. Free up space or contact BayLeaf support.', requires_2_gib:'Your sandbox needs more memory. Contact BayLeaf support to upgrade it and keep your files.',
      public_sandbox:'Your sandbox’s privacy settings need attention. Contact BayLeaf support.',
      port_in_use:'The browser interface could not restart. Try again, or contact BayLeaf support.',
      credential_changed:'Your BayLeaf key changed. Resume to refresh browser configuration.',
      setup_interrupted:'Setup was interrupted. Resume to retry.', setup_timeout:'Setup timed out. Resume to retry.',
      installation_failed:'Setup could not finish. Try again, or contact BayLeaf support.',
      provider_configuration_unavailable:'Could not connect your sandbox to BayLeaf. Try again.',
       application_not_ready:'The workspace did not pass its readiness check. Retry reuses installed applications.',
       opencode_installation_failed:'OpenChamber could not install OpenCode. Retry setup to try the download again.',
      personal_key_required:'Create your personal BayLeaf key first.', sandbox_missing:'The shared sandbox is missing. Resume to locate or create it.' };
     let timer, deadline, snapshot, busy = false, ready = false, requestVersion = 0;
     const duration = seconds => {
       seconds = Math.max(0,Math.floor(seconds));
       return seconds < 60 ? seconds + 's' : Math.floor(seconds/60) + 'm ' + seconds%60 + 's';
     };
      const clock = at => new Date(at*1000).toLocaleTimeString();
      // First observed clean setup, 2026-10-05: measured seconds + 1 per step.
      // The penultimate 'ready' is application readiness, before private access.
      const plan = [
        ['locating_sandbox',1],['creating_sandbox',2],['starting_sandbox',2],
        ['preparing_setup',3],['checking',1],['installing_openchamber',13],
        ['configuring',1],['installing_opencode',4],['starting_openchamber',2],
        ['waiting_for_opencode',3],['connecting_bayleaf',1],['loading_tools',2],
        ['checking_readiness',1],['ready',3],['registering_preview',2]
      ];
      const milestones = [['Sandbox',0,3],['Install',3,8],['Start',8,10],['Connect',10,13],['Open',13,15]];
      const total=plan.reduce((sum,step)=>sum+step[1],0);
      const pips=milestones.map(([name])=>{
        const node=document.createElement('div');node.className='browser-milestone';
        const pip=document.createElement('span');pip.className='browser-pip';
        node.append(pip,document.createTextNode(name));el('milestones').append(node);return node;
      });
      let meterOperation, meterFloor=0;
      function meter(s,now) {
        const visible=s.phase==='opening'&&!!s.started_at;
        el('meter').hidden=!visible;if(!visible)return;
        if(meterOperation!==s.operation){meterOperation=s.operation;meterFloor=0;}
        let index=0,at=s.started_at;
        for(const event of s.timeline||[]) {
          const candidate=plan.findIndex(step=>step[0]===event.step);
          if(candidate>=index){index=candidate;at=event.at;}
        }
        const elapsed=Math.max(0,now-at), budget=plan[index][1];
        const complete=s.phase==='ready'&&!!s.url;
        const opening=s.phase==='opening';
        // Never let a time estimate claim that an unconfirmed step has finished.
        // Exponential approach: brisk initially, then slower while awaiting evidence.
        // At the expected duration we show ~80% of this step, never its completion.
        const fraction=opening?0.97*(1-Math.exp(-elapsed/(budget*0.6))):0;
        const done=plan.slice(0,index).reduce((sum,step)=>sum+step[1],0);
        meterFloor=Math.max(meterFloor,done+budget*fraction);
        const percent=complete?100:Math.min(99,Math.floor(100*meterFloor/total));
        const late=opening&&(elapsed>=budget||s.progress==='waiting_for_toolbox');
        const remaining=Math.ceil(total-done-Math.min(elapsed,budget));
        const text=complete?'Workspace ready':s.phase==='failed'?'Setup paused at a failed step'
          :late?'Taking longer than estimated; waiting for confirmation'
          :'About '+duration(remaining)+' remaining';
        el('estimate').textContent=complete?text:percent+'% estimated · '+text;
        el('estimate').title='Initial estimate: 41 seconds, based on one fresh setup plus one second per step. Reused installations may skip steps.';
        el('meter-bar').setAttribute('aria-valuenow',String(percent));
        el('meter-bar').setAttribute('aria-valuetext',text);
        milestones.forEach(([,start,end],i)=>{
          const finished=complete||index>=end;
          const active=!finished&&index>=start;
          const size=plan.slice(start,end).reduce((sum,step)=>sum+step[1],0);
          const before=plan.slice(0,start).reduce((sum,step)=>sum+step[1],0);
          pips[i].style.setProperty('--fill',(complete?100:Math.max(0,Math.min(100,100*(meterFloor-before)/size)))+'%');
          pips[i].dataset.state=finished?'done':active?(s.phase==='failed'?'failed':'current'):'pending';
        });
      }
      function timing() {
       const s=snapshot;if(!s)return;
        const now=Math.floor(Date.now()/1000);
        meter(s,now);
       el('timing').hidden=!s.started_at;
       const last=(s.timeline||[]).at(-1);
       const end=s.phase==='opening'?now:(last?.at||s.updated_at||now);
       el('timing').textContent=s.started_at ? 'Started '+clock(s.started_at)+' · '+duration(end-s.started_at)+' elapsed'
         +(s.phase==='opening'&&last?' · Current step '+duration(now-last.at):'')
         +(s.phase==='opening'&&s.heartbeat_at?' · Installer last reported '+duration(now-s.heartbeat_at)+' ago':'') : '';
       const events=s.timeline||[];
       el('progress').hidden=!events.length;
       el('timeline').replaceChildren(...events.map((event,i)=>{
         const li=document.createElement('li');
         const next=events[i+1];
         const elapsed=next?duration(next.at-event.at):s.phase==='opening'?duration(now-event.at)+' so far':'';
         li.textContent=clock(event.at)+' · '+(labels[event.step]||'Setup step')+(elapsed?' · '+elapsed:'')
           +(event.error?' · '+(errors[event.error]||'Setup could not complete')+' ['+event.error+']':'');
         return li;
       }));
     }
     function render(s) {
       snapshot=s;
      clearTimeout(timer);
      deadline = s.deadline > Math.floor(Date.now()/1000) ? s.deadline : null;
      ready = s.phase === 'ready' && !!s.url;
      const opening = s.phase === 'opening';
      el('status').textContent = s.error ? (errors[s.error] || 'Could not open your sandbox. Try again, or contact BayLeaf support.')
        : opening ? (labels[s.progress] || 'Preparing your sandbox') + '…'
        : ready ? 'Ready'
        : s.phase === 'expired' ? 'Browser access ended. Your files are saved.'
        : s.machine === 'absent' ? 'Ready to set up.'
        : 'Your sandbox is ' + (s.machine || 'not open') + '.';
      el('start').hidden = ready || opening;
      el('start').textContent = s.phase === 'failed' ? 'Retry setup' : s.machine === 'absent' ? 'Set up sandbox' : 'Resume sandbox';
      el('intro').hidden = s.machine !== 'absent';
      el('open').hidden = !ready;
      if (ready) el('open').href = s.url; else el('open').removeAttribute('href');
      el('restart').hidden = !ready;
       el('stop').hidden = !(ready || opening);
       const previous=s.previous_failure;
       el('previous').hidden=!previous;
       el('previous').textContent=previous?'Previous attempt failed at '+clock(previous.at)+' after '+duration(previous.elapsed)
         +': '+(errors[previous.error]||'Setup could not complete')+' ['+previous.error+'].':'';
        if(s.phase==='failed')el('progress').open=true;
       timing();
      if (opening) timer = setTimeout(refresh, 5000);
      countdown();
    }
    function countdown() {
      const remaining = deadline ? Math.max(0, deadline - Math.floor(Date.now()/1000)) : 0;
      const minutes = Math.ceil(remaining/60);
      el('deadline').textContent = ready && remaining ? (minutes >= 60 ? Math.floor(minutes/60) + 'h ' + minutes%60 + 'm' : minutes + 'm') + ' remaining' : '';
      el('continue').hidden = !ready || !remaining || remaining > 3600;
      if (deadline && remaining === 0) { deadline = null; refresh(); }
    }
    async function refresh() {
      const version = ++requestVersion;
      try { const r = await fetch('/sandbox/browser/status', { cache:'no-store' }); const result = await r.json();
        if (version === requestVersion) render(result); }
      catch { if (version === requestVersion) el('status').textContent = 'Could not check status. Try refreshing.'; }
    }
    async function action(name) {
      if (busy) return;
      if (name === 'stop' && !confirm('End browser work and stop its managed tasks? Shared sandbox files are preserved.')) return;
      busy = true;
      ++requestVersion;
      clearTimeout(timer);
      document.querySelectorAll('#sandbox button').forEach(b => b.disabled = true);
      try {
        const r = await fetch('/sandbox/browser/' + name, { method:'POST', headers:{ 'X-BayLeaf-Action':'sandbox-browser' } });
        const result = await r.json();
        if (!r.ok) render(result); else await refresh();
      } catch { el('status').textContent = 'Could not submit the action. Refresh status before retrying.'; }
      finally { busy=false; document.querySelectorAll('#sandbox button').forEach(b => b.disabled = false); }
    }
    ['start','continue','restart','stop'].forEach(name => el(name).addEventListener('click', () => action(name)));
    el('refresh').addEventListener('click', refresh);
    window.addEventListener('focus', () => { if (!busy) refresh(); });
     setInterval(countdown, 30000);
      setInterval(timing,1000);
      setInterval(()=>{if(snapshot?.phase==='opening')meter(snapshot,Date.now()/1000);},100);
    refresh();
  })();` }} />
</section>;
