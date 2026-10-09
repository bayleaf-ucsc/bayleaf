import { SERVICES } from './services';

// Standalone HTML keeps this Worker independent of the API dashboard's Hono layout.
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!));

const styles = `
  * { box-sizing:border-box; }
  [hidden] { display:none !important; }
  body { margin:0; background:#f6f8f4; color:#24352b; font:1rem/1.65 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  main { max-width:840px; margin:auto; padding:clamp(1.5rem,6vw,4rem) 1.5rem; }
  a,summary { color:#1e5a3a; text-underline-offset:0.2em; }
  :focus-visible { outline:3px solid #2a5298; outline-offset:4px; }
  nav,.actions,.account { display:flex; flex-wrap:wrap; align-items:center; gap:0.75rem 1.5rem; }
  nav a:first-child { margin-right:auto; font-weight:700; }
  .account { justify-content:space-between; margin:2rem 0 1rem; }
  .account p { margin:0; overflow-wrap:anywhere; }
  .eyebrow { margin:2.5rem 0 0; color:#365a43; }
  h1 { font-size:clamp(2.25rem,8vw,3.6rem); line-height:1.1; letter-spacing:-0.04em; margin:1rem 0; }
  h2 { font-size:1.5rem; line-height:1.25; margin:0 0 1rem; }
  .lede { font-size:1.2rem; }
  .service { margin:2rem 0; padding:clamp(1rem,4vw,2rem); background:#fff; border:1px solid #b7cebe; border-radius:14px; }
  button,.button { display:inline-flex; justify-content:center; align-items:center; min-height:44px; padding:0.65rem 1rem; border:1px solid #1e5a3a; border-radius:6px; font:inherit; font-weight:600; cursor:pointer; }
  .button { background:#1e5a3a; color:#fff; text-decoration:none; }
  .button:hover { background:#16432b; }
  button.secondary { background:#fff; color:#1e5a3a; }
  button:disabled { cursor:wait; opacity:0.65; }
  .note,footer,.browser-timing,.browser-estimate { color:#48594e; font-size:0.9rem; }
  details { margin:1rem 0; }
  summary { cursor:pointer; padding:0.5rem 0; }
  .status-box { display:flex; align-items:center; gap:1rem; padding:0.75rem 1rem; background:#f0f6f2; border:1px solid #b7cebe; border-radius:6px; margin:1.25rem 0; }
  .status-box p { flex:1; margin:0; }
  .status-box button { flex-shrink:0; }
  .browser-timeline { padding-left:1.3rem; font-size:0.9rem; overflow-wrap:anywhere; }
  .browser-timeline li { margin:0.4rem 0; }
  .browser-meter { margin:1.2rem 0; }
  .browser-milestones { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:0.25rem; }
  .browser-milestone { position:relative; padding-top:1.5rem; font-size:0.75rem; color:#48594e; }
  .browser-track { height:6px; border-radius:3px; background:#dcebe1; margin-top:0.75rem; overflow:hidden; }
  .browser-fill { height:100%; background:#365a43; transform:scaleX(0); transform-origin:left; }
  .browser-pip { position:absolute; top:0; left:0; width:16px; height:16px; border-radius:50%; border:2px solid #767676; background:#fafafa; }
  .browser-milestone[data-state=done] .browser-pip { background:#365a43; border-color:#365a43; }
  .browser-milestone[data-state=current] { color:#003c6c; font-weight:600; }
  .browser-milestone[data-state=current] .browser-pip { border-color:#006aad; box-shadow:0 0 0 3px #dcebe1; }
  .browser-track[data-waiting=true] .browser-fill { animation:browser-working 2s ease-in-out infinite; }
  @keyframes browser-working { 50% { opacity:0.55; } }
  @media (prefers-reduced-motion:reduce) { .browser-fill { animation:none !important; } }
  footer { border-top:1px solid #b7cebe; margin-top:2.5rem; padding-top:1rem; }
  @media (max-width:380px) { main { padding:1.25rem 1rem; } .status-box { flex-wrap:wrap; } }
`;

const controls = `
  <div class="status-box">
    <p id="browser-status" role="status" aria-live="polite">Checking status…</p>
    <button type="button" class="secondary" id="browser-refresh" aria-label="Refresh OpenChamber status">Refresh</button>
  </div>
  <form id="browser-login" method="post" action="/login" hidden><button class="button" type="submit">Sign in again</button></form>
  <div id="browser-meter" class="browser-meter" hidden>
    <div id="browser-meter-bar" role="progressbar" aria-label="Estimated OpenChamber setup progress" aria-valuemin="0" aria-valuemax="100">
      <div id="browser-milestones" class="browser-milestones" aria-hidden="true"></div>
      <div id="browser-track" class="browser-track" aria-hidden="true"><div id="browser-fill" class="browser-fill"></div></div>
    </div>
    <p id="browser-estimate" class="browser-estimate"></p>
  </div>
  <p id="browser-timing" class="browser-timing" hidden></p>
  <p id="browser-previous" class="note" hidden></p>
  <details id="browser-progress" hidden><summary>Setup activity</summary><ol id="browser-timeline" class="browser-timeline"></ol></details>
  <div class="actions">
    <button type="button" class="button" id="browser-start" hidden>Set up OpenChamber</button>
    <a class="button" id="browser-open" hidden target="_blank" rel="noopener noreferrer">Open OpenChamber <span class="note-window">(new tab)</span></a>
  </div>
  <p id="browser-intro" class="note" hidden>First setup creates your sandbox and installs OpenChamber. Allow a few minutes.</p>
  <details><summary>Setup, restart &amp; help</summary>
    <div class="actions">
      <button type="button" class="secondary" id="browser-restart" hidden>Set up / restart OpenChamber</button>
    </div>
    <p class="note">Set up again to check the managed installation, refresh its BayLeaf configuration, and restart OpenChamber. Setup reuses installed applications where possible and preserves your sandbox files and agent history.</p>
    <p class="note">Private browser links last up to 24 hours. Return here for a new link if yours expires or your sandbox sleeps. Link expiry does not stop applications.</p>
    <p class="note">Setup stores your BayLeaf key inside your sandbox, where programs you run can access it. Use Chat or the file API to export files and history.</p>
    <p class="note"><a href="https://github.com/bayleaf-ucsc/bayleaf/blob/main/SUPPORT.md">Get help with your sandbox</a>.</p>
  </details>
  <noscript><p>Enable JavaScript to check status and set up OpenChamber. <a href="https://api.bayleaf.dev/dashboard#sandbox">Low-level sandbox and API access</a> is also available.</p></noscript>
`;

/** OpenChamber's evidence-gated, monotonic setup progress meter. */
const controlsScript = `(() => {
  for (const root of document.querySelectorAll('[data-service]')) {
    const el = id => root.querySelector('#browser-' + id);
    const endpoint = root.dataset.endpoint;
    const labels = { locating_sandbox:'Locating your sandbox', creating_sandbox:'Creating your sandbox',
      starting_sandbox:'Starting or restoring your sandbox', preparing_setup:'Preparing setup',
      checking:'Checking the managed installation', installing:'Installing browser tools',
      configuring:'Configuring the workspace', starting:'Starting OpenChamber', ready:'Ready',
      installing_openchamber:'Installing current OpenChamber', installing_opencode:'Preparing OpenCode with the upstream installer',
      starting_openchamber:'Starting OpenChamber', waiting_for_opencode:'Waiting for OpenCode to respond',
      connecting_bayleaf:'Connecting your BayLeaf account', loading_tools:'Loading BayLeaf tools and skills',
      checking_readiness:'Checking workspace readiness', registering_preview:'Creating private browser access',
      waiting_for_toolbox:'Waiting for the sandbox connection; retrying automatically',
      failed:'Setup failed', expired:'Browser link expired', stopped:'Browser access unavailable' };
    const errors = { node_22_required:'Your sandbox’s software needs an update. Contact BayLeaf support.',
      insufficient_disk:'Your sandbox needs more free storage. Free up space or contact BayLeaf support.',
      requires_2_gib:'Your sandbox needs more memory. Contact BayLeaf support to upgrade it and keep your files.',
      public_sandbox:'Your sandbox’s privacy settings need attention. Contact BayLeaf support.',
      port_in_use:'OpenChamber could not restart. Try again, or contact BayLeaf support.',
      credential_changed:'Your BayLeaf key changed. Set up OpenChamber again to refresh its configuration.',
      setup_interrupted:'Setup was interrupted. Retry setup to continue.', setup_timeout:'Setup timed out. Retry setup to continue.',
      installation_failed:'Setup could not finish. Try again, or contact BayLeaf support.',
      provider_configuration_unavailable:'Could not connect your sandbox to BayLeaf. Try again.',
      application_not_ready:'The workspace did not pass its readiness check. Retry reuses installed applications.',
      opencode_installation_failed:'OpenChamber could not install OpenCode. Retry setup to try the download again.',
      personal_key_required:'Create your personal BayLeaf key in the API dashboard first.',
      sandbox_missing:'The shared sandbox is missing. Set up OpenChamber to locate or create it.' };
    let timer, snapshot, busy = false, ready = false, requestVersion = 0, authExpired = false;
    const duration = seconds => {
      seconds = Math.max(0,Math.floor(seconds));
      return seconds < 60 ? seconds + 's' : Math.floor(seconds/60) + 'm ' + seconds%60 + 's';
    };
    const clock = at => new Date(at*1000).toLocaleTimeString();
    // Fresh setup, 2026-10-06: 26 seconds, with one-second timestamp resolution.
    // Zero-duration steps are evidence gates, not invented waiting budgets.
    // The penultimate 'ready' is application readiness, before private access.
    const plan = [
      ['locating_sandbox',0],['creating_sandbox',0],['starting_sandbox',1],
      ['preparing_setup',2],['checking',1],['installing_openchamber',13],
      ['configuring',0],['installing_opencode',3],['starting_openchamber',0],
      ['waiting_for_opencode',2],['connecting_bayleaf',1],['loading_tools',1],
      ['checking_readiness',0],['ready',0],['registering_preview',2]
    ];
    const milestones = [['Sandbox',0,3],['Install',3,8],['Start',8,10],['Connect',10,13],['Open',13,15]];
    const total=plan.reduce((sum,step)=>sum+step[1],0);
    const pips=milestones.map(([name])=>{
      const node=document.createElement('div');node.className='browser-milestone';
      const pip=document.createElement('span');pip.className='browser-pip';
      node.append(pip,document.createTextNode(name));el('milestones').append(node);return node;
    });
    let meterOperation, meterFloor=0, displayed=0, frame, lastFrame;
    const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
    function meter(s,now) {
      const visible=s.phase==='opening'&&!!s.started_at;
      el('meter').hidden=!visible;if(!visible)return;
      if(meterOperation!==s.operation){meterOperation=s.operation;meterFloor=0;displayed=0;lastFrame=undefined;}
      let index=0,at=s.started_at;
      for(const event of s.timeline||[]) {
        const candidate=plan.findIndex(step=>step[0]===event.step);
        if(candidate>index){index=candidate;at=event.at;}
        else if(candidate===index){at=Math.min(at,event.at);}
      }
      const elapsed=Math.max(0,now-at), budget=plan[index][1];
      // Never let a time estimate claim that an unconfirmed step has finished.
      const fraction=budget>0?0.9*Math.min(1,elapsed/budget):0;
      const done=plan.slice(0,index).reduce((sum,step)=>sum+step[1],0);
      meterFloor=Math.max(meterFloor,done+budget*fraction);
      const target=Math.min(99,100*meterFloor/total);
      const delta=lastFrame===undefined?0:Math.max(0,now-lastFrame);lastFrame=now;
      displayed=reducedMotion.matches?target:displayed+(target-displayed)*(1-Math.exp(-delta/0.25));
      el('fill').style.transform='scaleX('+(displayed/100)+')';
      const percent=Math.floor(displayed);
      const late=elapsed>=budget||s.progress==='waiting_for_toolbox';
      const remaining=Math.ceil(total-done-Math.min(elapsed,budget));
      const text=late?'Taking longer than estimated; waiting for confirmation':'About '+duration(remaining)+' remaining';
      el('track').dataset.waiting=String(late);
      const estimate=percent+'% estimated · '+text;
      if(el('estimate').textContent!==estimate)el('estimate').textContent=estimate;
      el('estimate').title='Approximate 26-second baseline from one fresh setup, not a guaranteed duration. Reused installations may skip steps.';
      el('meter-bar').setAttribute('aria-valuenow',String(percent));
      el('meter-bar').setAttribute('aria-valuetext',text);
      milestones.forEach(([,start,end],i)=>{pips[i].dataset.state=index>=end?'done':index>=start?'current':'pending';});
    }
    function animate() {
      frame=undefined;
      if(snapshot?.phase!=='opening'||!snapshot.started_at)return;
      meter(snapshot,Date.now()/1000);
      frame=requestAnimationFrame(animate);
    }
    function timing() {
      const s=snapshot;if(!s)return;
      const now=Math.floor(Date.now()/1000);
      el('timing').hidden=!s.started_at;
      const last=(s.timeline||[]).at(-1);
      const end=s.phase==='opening'?now:(last?.at||s.updated_at||now);
      el('timing').textContent=s.started_at ? 'Started '+clock(s.started_at)+' · '+duration(end-s.started_at)+' elapsed'
        +(s.phase==='opening'&&last?' · Current step '+duration(now-last.at):'')
        +(s.phase==='opening'&&s.heartbeat_at?' · Installer last reported '+duration(now-s.heartbeat_at)+' ago':'') : '';
      const events=s.timeline||[];
      el('progress').hidden=!events.length;
      el('timeline').replaceChildren(...events.map((event,i)=>{
        const li=document.createElement('li');const next=events[i+1];
        const elapsed=next?duration(next.at-event.at):s.phase==='opening'?duration(now-event.at)+' so far':'';
        li.textContent=clock(event.at)+' · '+(labels[event.step]||'Setup step')+(elapsed?' · '+elapsed:'')
          +(event.error?' · '+(errors[event.error]||'Setup could not complete')+' ['+event.error+']':'');
        return li;
      }));
    }
    function safeLink(value) {
      try { const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null; }
      catch { return null; }
    }
    function render(s) {
      snapshot=s;clearTimeout(timer);
      const url=safeLink(s.url);
      ready=s.phase==='ready'&&!!url;
      const opening=s.phase==='opening';
      el('status').textContent=s.error ? (errors[s.error]||'Could not open OpenChamber. Try again, or contact BayLeaf support.')
        :opening?(labels[s.progress]||'Preparing OpenChamber')+'…'
        :ready?'OpenChamber is ready.'
        :s.phase==='expired'?'Browser link expired. Resume for a new link. Your files are saved.'
        :s.machine==='absent'?'Ready for your first setup.'
        :'Your sandbox is '+(s.machine||'not open')+'. Set up or resume OpenChamber below.';
      el('start').hidden=ready||opening;
      el('start').textContent=s.phase==='failed'?'Retry OpenChamber setup':s.machine==='absent'||s.phase==='absent'?'Set up OpenChamber':'Set up / resume OpenChamber';
      el('intro').hidden=s.machine!=='absent';
      el('open').hidden=!ready;
      if(ready)el('open').href=url;else el('open').removeAttribute('href');
      el('restart').hidden=!ready;
      const previous=s.previous_failure;
      el('previous').hidden=!previous;
      el('previous').textContent=previous?'Previous attempt failed at '+clock(previous.at)+' after '+duration(previous.elapsed)
        +': '+(errors[previous.error]||'Setup could not complete')+' ['+previous.error+'].':'';
      if(s.phase==='failed')el('progress').open=true;
      timing();meter(s,Date.now()/1000);
      if(opening&&s.started_at&&frame===undefined)frame=requestAnimationFrame(animate);
      if(!opening&&frame!==undefined){cancelAnimationFrame(frame);frame=undefined;lastFrame=undefined;}
      if(opening)timer=setTimeout(refresh,5000);
    }
    function signedOut() {
      authExpired=true;ready=false;snapshot=undefined;clearTimeout(timer);
      if(frame!==undefined){cancelAnimationFrame(frame);frame=undefined;}
      for(const id of ['start','restart','open','meter','timing','progress','previous'])el(id).hidden=true;
      el('open').removeAttribute('href');el('login').hidden=false;
      el('status').textContent='Your session has expired. Sign in again to continue.';
    }
    async function refresh() {
      if(authExpired)return;
      const version=++requestVersion;
      try {
        const r=await fetch(endpoint+'/status',{cache:'no-store',credentials:'same-origin',redirect:'error'});
        if(version!==requestVersion)return;
        if(r.status===401){signedOut();return;}
        if(!r.ok)throw new Error('status');
        const result=await r.json();
        if(version===requestVersion)render(result);
      } catch {
        if(version===requestVersion){
          el('status').textContent='Could not check status. Try refreshing.';
          if(snapshot?.phase==='opening')timer=setTimeout(refresh,5000);
        }
      }
    }
    async function action(name) {
      if(busy||authExpired)return;
      busy=true;++requestVersion;clearTimeout(timer);
      const actionButtons=['start','restart','refresh'].map(el);
      actionButtons.forEach(b=>b.disabled=true);
      el('status').textContent=name==='restart'?'Requesting an OpenChamber restart…':'Requesting OpenChamber setup…';
      try {
        const r=await fetch(endpoint+'/'+name,{method:'POST',headers:{'X-BayLeaf-Action':'managed-service'},credentials:'same-origin',redirect:'error'});
        if(r.status===401){signedOut();return;}
        const result=await r.json();
        if(!r.ok) {
          if(typeof result.phase==='string')render(result);
          else el('status').textContent=errors[result.error]||'Could not submit the action. Refresh status before retrying.';
        } else await refresh();
      } catch {el('status').textContent='Could not submit the action. Refresh status before retrying.';}
      finally {busy=false;actionButtons.forEach(b=>b.disabled=authExpired);}
    }
    ['start','restart'].forEach(name=>el(name).addEventListener('click',()=>action(name)));
    el('refresh').addEventListener('click',()=>{if(!busy)refresh();});
    window.addEventListener('focus',()=>{if(!busy)refresh();});
    setInterval(()=>{if(!busy&&ready&&snapshot?.deadline<=Math.floor(Date.now()/1000))refresh();},30000);
    setInterval(timing,1000);
    refresh();
  }
})();`;

export function renderSandboxPage(session: { email: string; name?: string } | null): Response {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))));
  const cards = SERVICES.map(service => `<section class="service" id="${service.id}" aria-labelledby="${service.id}-title"${session ? ` data-service="${service.id}" data-endpoint="${service.endpoint}"` : ''}>
    <h2 id="${service.id}-title">${escapeHtml(service.name)}</h2>
    <p>${escapeHtml(service.description)}</p>
    ${session ? controls : '<p>Set up the workspace in your browser, then return to your files and projects whenever you need them.</p>'}
  </section>`).join('');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="BayLeaf Sandboxes: persistent workspaces for building, running, and previewing projects with an AI agent at UC Santa Cruz.">
<meta name="theme-color" content="#1e5a3a"><title>BayLeaf Sandboxes${session ? ' · Your workspace' : ''}</title>
<style nonce="${nonce}">${styles}</style></head><body><main>
<nav aria-label="BayLeaf home"><a href="https://bayleaf.dev">BayLeaf</a></nav>
${session ? `<div class="account"><p>Signed in as ${escapeHtml(session.name || session.email)}${session.name ? ` <span class="note">(${escapeHtml(session.email)})</span>` : ''}</p><form method="post" action="/logout"><button class="secondary" type="submit">Sign out</button></form></div>` : '<p class="eyebrow">For the UC Santa Cruz community</p>'}
<h1>BayLeaf Sandboxes</h1>
<p class="lede">A place to build, run, and try things out with an AI agent. Your files stay in your sandbox, ready for the next session.</p>
<p>Signing in starts waking your existing sandbox. ${session ? 'Choose setup below' : 'After signing in, choose setup'} to install or resume OpenChamber. Your first setup creates a sandbox if you do not have one.</p>
${session ? '' : '<form method="post" action="/login"><button class="button" type="submit">Sign in with UCSC</button></form>'}
${cards}
<h2>One sandbox, connected to BayLeaf</h2>
<p>OpenChamber, Chat’s sandbox tools, and the API reach the same sandbox files and processes. Chat and your sandbox agent keep separate conversation histories.</p>
<p><a href="https://api.bayleaf.dev/dashboard#sandbox">Low-level sandbox &amp; API controls</a></p>
<p class="note">Files and agent histories persist between sessions; running tasks stop when your sandbox sleeps. Sandboxes inactive for 90 days are deleted, including their files and histories. Export anything you need to keep.</p>
<p class="note">Inference uses zero-data-retention providers. Workspace files and history are stored, and operators can access that storage. <a href="https://github.com/bayleaf-ucsc/bayleaf/blob/main/PRIVACY.md">Read the privacy notice</a>.</p>
<footer>Part of <a href="https://bayleaf.dev">BayLeaf</a>, a situated counterplatform for Generative AI at UC Santa Cruz.</footer>
</main>${session ? `<script nonce="${nonce}">${controlsScript}</script>` : ''}</body></html>`;
  return new Response(html, { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`,
    // no-referrer suppresses Origin on native form POSTs in browsers. Keep
    // only the origin, never the path, so login/logout pass exact-Origin CSRF.
    'Referrer-Policy': 'strict-origin',
    'X-Content-Type-Options': 'nosniff',
  } });
}
