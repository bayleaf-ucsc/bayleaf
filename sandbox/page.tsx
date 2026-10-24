import { SERVICES } from './services';
import { arrivalScript } from '../telemetry/browser/runtime';

// Standalone HTML keeps this Worker independent of the API dashboard's Hono layout.
// Signed-in pages may frame only preview-gateway origins (Desktop's live view).
// The gateway, not this list, limits framing to the owner's own Desktop.
const PREVIEW_FRAMES = 'https://*.bayleaf-proxies.dev';
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!));

const styles = `
  * { box-sizing:border-box; }
  [hidden] { display:none !important; }
  body { margin:0; background:#f6f8f4; color:#24352b; font:1rem/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  main { max-width:960px; margin:auto; padding:1.5rem; }
  a,summary { color:#1e5a3a; text-underline-offset:0.2em; }
  :focus-visible { outline:3px solid #2a5298; outline-offset:4px; }
  nav,.actions,.account { display:flex; flex-wrap:wrap; align-items:center; gap:0.5rem 1rem; }
  nav a:first-child { margin-right:auto; font-weight:700; }
  .account { font-size:0.85rem; }
  .account p { margin:0; overflow-wrap:anywhere; }
  .eyebrow { margin:0; color:#365a43; font-size:0.85rem; }
  h1 { font-size:clamp(2rem,6vw,2.8rem); line-height:1.1; letter-spacing:-0.04em; margin:2rem 0 0.75rem; }
  h2 { font-size:1.15rem; line-height:1.3; margin:0; }
  .lede { max-width:65ch; margin:0 0 1.5rem; color:#48594e; font-size:1.05rem; }
  .description { color:#48594e; margin:0.25rem 0 0; }
  .service details { font-size:0.85rem; margin:0.2rem 0 0; }
  .service details .actions { margin-top:0.5rem; }
  .note-window { font-size:0.75rem; font-weight:400; margin-left:0.5rem; }
  button,.button { display:inline-flex; justify-content:center; align-items:center; min-height:44px; padding:0.65rem 1rem; border:1px solid #1e5a3a; border-radius:6px; font:inherit; font-weight:600; cursor:pointer; }
  .button { background:#1e5a3a; color:#fff; text-decoration:none; }
  .button:hover { background:#16432b; }
  button.secondary { background:#fff; color:#1e5a3a; }
  button:disabled { cursor:wait; opacity:0.65; }
  .note,footer,.browser-timing { color:#48594e; font-size:0.9rem; }
  details { margin:1rem 0; }
  summary { cursor:pointer; padding:0.5rem 0; }
  .status-box { display:flex; align-items:center; gap:0.5rem; color:#365a43; font-size:0.85rem; margin:0.25rem 0 0; }
  .service[data-phase=opening] .status-box { color:#003c6c; }
  .status-box p { flex:1; margin:0; }
  .status-box:has(p:empty) { display:none; }
  .status-box button { flex-shrink:0; }
  .browser-timeline { padding-left:1.3rem; font-size:0.9rem; overflow-wrap:anywhere; }
  .browser-timeline li { margin:0.4rem 0; }
  .service-activity { display:none; flex-shrink:0; width:0.9rem; height:0.9rem; border:2px solid #b7cebe; border-top-color:currentColor; border-radius:50%; }
  .service[data-phase=opening] .service-activity { display:inline-block; animation:service-working 1.2s linear infinite; }
  @keyframes service-working { to { transform:rotate(360deg); } }
  @media (prefers-reduced-motion:reduce) { .service[data-phase=opening] .service-activity { animation:none; } }
  footer { display:flex; flex-wrap:wrap; justify-content:space-between; gap:0.5rem 1rem; margin-top:1.5rem; font-size:0.8rem; }
  @media (max-width:380px) { main { padding:1.25rem 1rem; } .status-box { flex-wrap:wrap; } }
  .tagline { font-size:1.25rem; font-weight:600; color:#365a43; margin:0 0 0.75rem; }
  .facts,.examples { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:1rem; margin:1.5rem 0; }
  .fact,.example { background:#fff; border:1px solid #d3e2d7; border-radius:10px; padding:1rem 1.1rem; }
  .fact h2,.example h3 { font-size:1rem; margin:0 0 0.4rem; }
  .fact p,.example p { font-size:0.925rem; color:#48594e; margin:0; }
  .directory { margin:2.25rem 0; }
  .directory > p { color:#48594e; font-size:0.9rem; }
  .group-title { font-size:0.8rem; text-transform:uppercase; letter-spacing:0.06em; color:#48594e; margin:1.5rem 0 0.25rem; }
  .services { display:block; list-style:none; padding:0; background:#fff; border:1px solid #b7cebe; border-radius:10px; margin:0; }
  .service { min-width:0; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:0.2rem 1.25rem; border-top:1px solid #e1ebe4; padding:1rem 1.1rem; }
  .service:first-child { border-top:0; }
  .service h4 { font-size:1.05rem; margin:0; }
  .app-url { font:0.8rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; }
  .app-url a { color:#48594e; }
  .service > .actions { grid-column:2; grid-row:1; align-self:center; }
  .service .actions > .button { width:auto; }
  .service > .status-box,.service > details,.service > form,.service > noscript { grid-column:1 / -1; }
  .service > .sharing-boundary { grid-column:1 / -1; margin:0.4rem 0; font-size:0.9rem; color:#48594e; overflow-wrap:anywhere; }
  .service[data-service=collabmd] > .actions { grid-column:1 / -1; grid-row:auto; }
  .service summary { padding:0.25rem 0; }
  .service .button { background:#fff; color:#1e5a3a; }
  .service .button:hover { background:#e5f0e8; }
  .service[data-phase=failed] .status-box { color:#6b231a; background:#fdf1ef; padding:0.6rem 0.85rem; border-radius:6px; }
  .examples { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .hero { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,420px); gap:1.5rem 2rem; align-items:center; margin-top:2rem; }
  .hero h1 { margin-top:0; }
  .hero .lede { margin-bottom:1rem; }
  .screen { min-width:0; }
  /* Xvfb runs at 1024x768; noVNC scales to fit, so a 4:3 box avoids letterboxing. */
  .screen-display { position:relative; aspect-ratio:4/3; background:#1f2a24; border:8px solid #2f3b34; border-radius:10px; overflow:hidden; }
  .screen-stand { width:28%; height:10px; margin:0 auto; background:#2f3b34; border-radius:0 0 6px 6px; }
  .screen-placeholder { position:absolute; inset:0; background:linear-gradient(160deg,#2f5240,#1f2a24 75%); }
  .screen-placeholder span { position:absolute; display:block; }
  .screen-placeholder .icon { left:5%; width:7%; aspect-ratio:1; background:#9fbfaa; opacity:0.35; border-radius:3px; }
  .screen-placeholder .icon:nth-child(1) { top:8%; }
  .screen-placeholder .icon:nth-child(2) { top:20%; }
  .screen-placeholder .icon:nth-child(3) { top:32%; }
  .screen-placeholder .window { left:24%; top:16%; width:52%; height:48%; border:1px solid #6f8c7a; background:#ffffff14; border-radius:4px; }
  .screen-placeholder .taskbar { left:0; right:0; bottom:0; height:7%; background:#111a15; }
  .screen-frame { position:absolute; inset:0; }
  .screen-frame iframe { display:block; width:100%; height:100%; border:0; }
  /* The placeholder is the control: its label appears on hover or focus. */
  .screen-connect { position:absolute; inset:0; width:100%; height:100%; min-height:0; padding:1rem; border:0; border-radius:0; background:transparent; }
  .screen-connect:hover { background:#00000040; }
  .screen-connect:focus-visible { outline-offset:-6px; outline-color:#fff; }
  .screen-connect span { padding:0.6rem 1rem; border-radius:6px; background:#1e5a3a; color:#fff; font-weight:600; opacity:0; transition:opacity 0.15s; }
  .screen-connect:hover span,.screen-connect:focus-visible span,.screen-connect[data-state] span { opacity:1; }
  .screen-connect[data-state=busy] { cursor:progress; }
  @media (hover:none) { .screen-connect span { opacity:1; } }
  @media (prefers-reduced-motion:reduce) { .screen-connect span { transition:none; } }
  .screen .actions { margin-top:0.75rem; }
  .flow { font-size:0.8rem; font-weight:600; color:#1e5a3a; margin:0 0 0.6rem; }
  .beyond { background:#eaf2ec; border-radius:10px; padding:1.1rem 1.25rem; margin:2rem 0; }
  .beyond p:last-child { margin-bottom:0; }
  .care { border-top:1px solid #b7cebe; padding-top:1.25rem; }
  .care details { margin:0.5rem 0; }
  .care summary { padding:0.3rem 0; font-weight:600; }
  .care details p { max-width:72ch; font-size:0.925rem; color:#48594e; }
  .callout { background:#fff; border-left:4px solid #b5651d; padding:0.65rem 0.9rem; font-size:0.925rem; }
  @media (max-width:760px) {
    .facts,.examples { grid-template-columns:1fr; }
    .hero { grid-template-columns:1fr; }
    .screen { max-width:420px; }
    .service { grid-template-columns:1fr; }
    .service > .actions { grid-column:1; grid-row:auto; margin-top:0.5rem; }
  }
`;

const controls = (service: typeof SERVICES[number]) => `
  <div class="status-box">
    <span class="service-activity" aria-hidden="true"></span>
    <p id="${service.id}-status" role="status" aria-live="polite">Checking status…</p>
  </div>
  <form id="${service.id}-login" method="post" action="/login" hidden><button class="button" type="submit">Sign in again</button></form>
  ${service.id === 'collabmd' ? '<p class="sharing-boundary">During an active sharing session, anyone with the link and room password can edit documents in <code>~/workspace/public-collaborative-docs/</code>. End sharing stops access, not file retention.</p>' : ''}
  <div class="actions">
    <button type="button" class="button" id="${service.id}-start" aria-label="Open ${escapeHtml(service.name)}" hidden>${escapeHtml(service.launch)}</button>
    <a class="button" id="${service.id}-open" aria-label="Open ${escapeHtml(service.name)} (new tab)" hidden target="_blank" rel="noopener noreferrer">Open <span class="note-window">(new tab)</span></a>
    <button type="button" class="secondary" id="${service.id}-copy-link" hidden>Copy link</button>
    <button type="button" class="secondary" id="${service.id}-copy-password" hidden>Copy room password</button>
    <button type="button" class="secondary" id="${service.id}-stop" hidden>${service.id === 'collabmd' ? 'End sharing' : 'Stop app'}</button>
  </div>
  <details class="app-help"><summary>Using ${escapeHtml(service.name)} here</summary>
    <p id="${service.id}-intro" class="note" hidden>${escapeHtml(service.intro)}</p>
    <p class="note">${escapeHtml(service.help)}</p>
    ${service.notes.map(note => `<p class="note">${escapeHtml(note)}</p>`).join('')}
  </details>
  <details id="${service.id}-troubleshoot" class="troubleshoot" hidden><summary id="${service.id}-repair-label">Troubleshooting &amp; repair</summary>
    <p class="note">Repair checks the installation and restarts this app, preserving saved files and histories. Save your work first: running tasks or connections in this app may be interrupted.</p>
    <div class="actions">
      <button type="button" class="secondary" id="${service.id}-restart" hidden>Restart ${escapeHtml(service.name)}</button>
    </div>
    <p id="${service.id}-timing" class="browser-timing" hidden></p>
    <p id="${service.id}-previous" class="note" hidden></p>
    <details id="${service.id}-progress" hidden><summary>Setup activity</summary><ol id="${service.id}-timeline" class="browser-timeline"></ol></details>
    <p class="note"><a href="https://github.com/bayleaf-ucsc/bayleaf/blob/main/SUPPORT.md">Get help with your sandbox</a>.</p>
  </details>
  <noscript><p>Enable JavaScript to check status and set up ${escapeHtml(service.name)}. <a href="https://api.bayleaf.dev/dashboard#sandbox">Low-level sandbox and API access</a> is also available.</p></noscript>
`;

/** Hero "screen": the placeholder is the button that connects (or signs in). */
const screenWidget = (signedIn: boolean) => `<section class="screen" id="screen" aria-label="Your sandbox’s screen">
  <div class="screen-display"><div class="screen-placeholder" id="screen-placeholder" aria-hidden="true"><span class="icon"></span><span class="icon"></span><span class="icon"></span><span class="window"></span><span class="taskbar"></span></div>
  ${signedIn ? `<div class="screen-frame" id="screen-frame"></div>
  <button type="button" class="screen-connect" id="screen-connect" hidden><span id="screen-cta">Connect to your desktop</span></button>`
    : '<form method="post" action="/login"><button type="submit" class="screen-connect"><span>Sign in to connect to your desktop</span></button></form>'}</div>
  <div class="screen-stand" aria-hidden="true"></div>
  ${signedIn ? `<div class="actions" id="screen-live" hidden>
    <a class="button" id="screen-popout" target="_blank" rel="noopener noreferrer">Open in new tab</a>
    <button type="button" class="secondary" id="screen-hide">Hide</button>
  </div>` : ''}
</section>`;

/** Shared managed-app status and controls; activity styling follows data-phase. */
const controlsScript = `(() => {
  const catalog = ${JSON.stringify(SERVICES).replaceAll('<', '\\u003c')};
  for (const root of document.querySelectorAll('[data-service]')) {
    const service = catalog.find(service => service.id === root.dataset.service);
    const el = id => root.querySelector('#' + service.id + '-' + id);
    const endpoint = root.dataset.endpoint;
    const {labels, errors} = service;
    let timer, snapshot, busy = false, ready = false, requestVersion = 0, authExpired = false;
    const duration = seconds => {
      seconds = Math.max(0,Math.floor(seconds));
      return seconds < 60 ? seconds + 's' : Math.floor(seconds/60) + 'm ' + seconds%60 + 's';
    };
    const clock = at => new Date(at*1000).toLocaleTimeString();
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
    function say(text){el('status').textContent=text;}
    // Desktop only: the hero's live screen, framed on demand. Nothing loads until
    // the owner clicks; the one-time code is minted then and never starts the app.
    // A click on a stopped Desktop runs the card's Start, then shows it once ready.
    const screen=service.id==='desktop'?(()=>{
      const $=id=>document.getElementById('screen-'+id);
      const connect=$('connect'),cta=$('cta'),live=$('live'),popout=$('popout'),hide=$('hide'),
        box=$('frame'),placeholder=$('placeholder');
      let pending=false,shownFor=null,autoShow=false;
      const frameLink=value=>{
        try { const u=new URL(value);
          return u.protocol==='https:'&&u.hostname.endsWith('.bayleaf-proxies.dev')&&u.pathname==='/__preview/embed'&&!u.username&&!u.password?u.href:null; }
        catch { return null; }
      };
      // Busy and error labels stay visible without hover; the card holds details.
      function state(name,text){
        if(name)connect.dataset.state=name;else delete connect.dataset.state;
        cta.textContent=text||'Connect to your desktop';
      }
      function close(focus){
        box.replaceChildren();live.hidden=true;placeholder.hidden=false;shownFor=null;
        connect.hidden=authExpired;state();
        if(focus&&!authExpired)connect.focus();
      }
      async function open(){
        if(pending||!ready||authExpired||busy)return;
        pending=true;state('busy','Connecting…');
        const link=snapshot?.url;
        try {
          const r=await fetch(endpoint+'/embed',{method:'POST',headers:{'X-BayLeaf-Action':'managed-service'},credentials:'same-origin',redirect:'error'});
          if(r.status===401){signedOut();return;}
          const result=await r.json();
          const target=r.ok?frameLink(result.url):null;
          if(!target||!ready||snapshot?.url!==link){
            say(errors[result.error]||'Could not show the desktop on this page. Use Open (new tab) instead.');
            state('error','Could not connect. Try again');return;
          }
          const frame=document.createElement('iframe');
          frame.title='Desktop (live view)';
          frame.referrerPolicy='origin';
          // Same-origin scripts for noVNC; no popups or top-level navigation of this page.
          frame.setAttribute('sandbox','allow-scripts allow-same-origin');
          frame.setAttribute('allow','fullscreen');
          frame.src=target;
          // Floor control would go here (not built; anyone may send input now):
          // load noVNC view_only while an agent holds the floor, and show a
          // "Take over" pill beside this frame that asks the owner's controller
          // for the human floor. See checkComputerFloor in api/src/computerUse.ts.
          box.replaceChildren(frame);placeholder.hidden=true;connect.hidden=true;live.hidden=false;shownFor=link;
          // Focus the controls below, not the desktop, which captures keys.
          hide.focus();
        } catch {
          say('Could not show the desktop on this page. Use Open (new tab) instead.');
          state('error','Could not connect. Try again');
        }
        finally {pending=false;}
      }
      // Only a click arms the automatic show; page loads never do.
      function maybeShow(){if(autoShow&&ready&&!busy&&!pending&&live.hidden){autoShow=false;open();}}
      function failed(){autoShow=false;state('error','Could not start. See Desktop below');}
      connect.addEventListener('click',async()=>{
        if(pending||busy||authExpired||autoShow||!live.hidden)return;
        if(ready)return open();
        autoShow=true;state('busy','Starting your desktop…');
        if(snapshot?.phase==='opening')return;
        if(el('start').hidden)return failed();
        await action('start');
        if(autoShow&&!ready&&snapshot?.phase!=='opening')failed();
        maybeShow();
      });
      hide.addEventListener('click',()=>close(true));
      // The link itself opens the new tab; closing the frame ends its connection.
      popout.addEventListener('click',()=>close(false));
      return {sync(link,phase){
        if(link)popout.href=link;else popout.removeAttribute('href');
        if(!live.hidden&&link!==shownFor)close(false);
        if(autoShow&&!link&&phase!=='opening')failed();
        connect.hidden=authExpired||!live.hidden;
        maybeShow();
      }};
    })():null;
    function safeLink(value) {
      try { const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null; }
      catch { return null; }
    }
    function render(s) {
      snapshot=s;clearTimeout(timer);
      const url=safeLink(s.url);
      ready=s.phase==='ready'&&!!url;
      const opening=s.phase==='opening';
      root.dataset.phase=s.phase;
       say(s.error ? (errors[s.error]||'Could not open '+service.name+'. Try again, or contact BayLeaf support.')
          :opening?(labels[s.progress]||'Preparing '+service.name)+'…'
          :s.phase==='stopped'?(s.access_revoked===false?'Revoking access; cleanup pending':s.cleanup_pending?'Access revoked; process cleanup pending':'Stopped. Saved files remain.')
          :ready?'Running':'');
      el('start').hidden=ready||opening||s.cleanup_pending||s.access_revoked===false;
       el('start').textContent=s.phase==='failed'?'Try again':service.launch;
       el('troubleshoot').hidden=!(ready||opening||s.error||s.previous_failure||s.phase==='failed');
       el('repair-label').textContent=s.error||s.previous_failure||s.phase==='failed'?'Troubleshooting & repair':opening?'Setup details':'Repair this app';
       el('start').setAttribute('aria-label',el('start').textContent+' '+service.name);
      el('intro').hidden=s.machine!=='absent';
      el('open').hidden=!ready;
      if(ready)el('open').href=url;else el('open').removeAttribute('href');
      el('restart').hidden=!ready;
      const stoppable=!!s.operation&&['opening','ready','expired','failed'].includes(s.phase);
      el('stop').hidden=!(stoppable||s.cleanup_pending||s.access_revoked===false);
      el('copy-link').hidden=!(ready&&service.id==='collabmd');
      el('copy-password').hidden=!(ready&&service.id==='collabmd'&&s.room_password);
      screen?.sync(ready?url:null,s.phase);
      const previous=s.previous_failure;
      el('previous').hidden=!previous;
      el('previous').textContent=previous?'Previous attempt failed at '+clock(previous.at)+' after '+duration(previous.elapsed)
        +': '+(errors[previous.error]||'Setup could not complete')+' ['+previous.error+'].':'';
       timing();
      if(opening||s.cleanup_pending||s.access_revoked===false)timer=setTimeout(refresh,5000);
    }
    function signedOut() {
      authExpired=true;ready=false;snapshot=undefined;clearTimeout(timer);
      root.dataset.phase='signed-out';
       for(const id of ['start','restart','stop','copy-link','copy-password','open','timing','progress','previous','troubleshoot'])el(id).hidden=true;
      el('open').removeAttribute('href');el('login').hidden=false;screen?.sync(null);
      say('Your session has expired. Sign in again to continue.');
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
          say('Could not check status. Try refreshing.');
          if(snapshot?.phase==='opening')timer=setTimeout(refresh,5000);
        }
      }
    }
    async function action(name) {
      if(busy||authExpired)return;
      busy=true;++requestVersion;clearTimeout(timer);
      const actionButtons=['start','restart','stop'].map(el);
      actionButtons.forEach(b=>b.disabled=true);
       say('Requesting '+service.name+(name==='stop'?' shutdown…':name==='restart'?' restart…':' setup…'));
      try {
        const r=await fetch(endpoint+'/'+name,{method:'POST',headers:{'X-BayLeaf-Action':'managed-service'},credentials:'same-origin',redirect:'error'});
        if(r.status===401){signedOut();return;}
        const result=await r.json();
        if(!r.ok) {
          if(typeof result.phase==='string')render(result);
          else say(errors[result.error]||'Could not submit the action. Refresh status before retrying.');
        } else await refresh();
      } catch {say('Could not submit the action. Refresh status before retrying.');}
      finally {busy=false;actionButtons.forEach(b=>b.disabled=authExpired);}
    }
    ['start','restart','stop'].forEach(name=>el(name).addEventListener('click',()=>action(name)));
    for(const [id,key] of [['copy-link','url'],['copy-password','room_password']]) {
      el(id).addEventListener('click',async()=>{
        if(!ready||!snapshot?.[key])return;
        try {await navigator.clipboard.writeText(snapshot[key]);say(id==='copy-link'?'Link copied':'Room password copied');}
        catch {say('Could not copy. Clipboard access is unavailable.');}
      });
    }
    window.addEventListener('focus',()=>{if(!busy)refresh();});
    setInterval(()=>{if(!busy&&ready&&snapshot?.deadline<=Math.floor(Date.now()/1000))refresh();},30000);
    setInterval(timing,1000);
    refresh();
  }
})();`;

export function renderSandboxPage(session: { email: string; name?: string } | null,
  { browserArrivalsEnabled = false }: { browserArrivalsEnabled?: boolean } = {}): Response {
  const collectArrival = !session && browserArrivalsEnabled === true;
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))));
  const cards = ['AI agents', 'Code & data', 'Basics'].map(group => `<h3 class="group-title">${escapeHtml(group)}</h3>
    ${group === 'AI agents' ? '<p class="note">An AI agent can do more than answer questions in chat. It can read and write files, run software, and carry out multi-step tasks in your sandbox.</p>' : ''}
    <ul class="services">${SERVICES.filter(service => service.group === group).sort((a,b) => group === 'Basics' ? (a.id === 'dufs' ? -1 : b.id === 'dufs' ? 1 : 0) : 0).map(service => `<li class="service" id="${service.id}" aria-labelledby="${service.id}-title"${session ? ` data-service="${service.id}" data-endpoint="${service.endpoint}"` : ''}>
    <div><h4 id="${service.id}-title">${escapeHtml(service.name)}</h4>
    <div class="app-url"><a href="${escapeHtml(service.url)}">${escapeHtml(service.url)}</a></div>
      <p class="description">${escapeHtml(service.description)}</p>
    </div>
       ${session ? controls(service) : ''}
  </li>`).join('')}</ul>`).join('');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="BayLeaf Sandboxes: managed apps and a shared workspace for the UC Santa Cruz community.">
<meta name="theme-color" content="#1e5a3a"><title>BayLeaf Sandboxes${session ? ' · Your workspace' : ''}</title>
<style nonce="${nonce}">${styles}</style></head><body><main>
<nav aria-label="BayLeaf home"><a href="https://bayleaf.dev">BayLeaf</a>
${session ? `<div class="account"><p>${escapeHtml(session.email)}</p><form method="post" action="/logout"><button class="secondary" type="submit">Sign out</button></form></div>` : '<p class="eyebrow">For the UC Santa Cruz community</p>'}</nav>
<div class="hero"><div>
<h1>BayLeaf Sandboxes</h1>
<p class="tagline">A small computer in the cloud for trying things out</p>
<p class="lede">Your sandbox is a separate computer that runs for you. Use it to try unfamiliar software, especially AI tools that work with your files, without installing anything on your own computer. You use its apps in your browser.</p>
${session ? '' : '<form method="post" action="/login"><button class="button" type="submit">Sign in with UCSC</button></form>'}
</div>${screenWidget(!!session)}</div>
<div class="facts">
<div class="fact"><h2>Kept separate</h2><p>Sandbox software runs separately from your personal computer. Upload files you want to work with there, rather than giving unfamiliar software access to your everyday files.</p></div>
<div class="fact"><h2>Shared files</h2><p>Every app below works in the same workspace folder. Upload a file once, then use it in any of them.</p></div>
<div class="fact"><h2>Sleeps when you’re done</h2><p>After you stop using it, your sandbox goes to sleep, releasing compute resources and keeping saved files. Waking it when you return can take a little longer.</p></div>
</div>
<section class="directory" aria-labelledby="apps-title"><h2 id="apps-title">Apps you can open</h2>
<p>Open as many or as few as you like. Each opens in a new tab; Desktop can also appear on the screen at the top of this page.</p>
<p>These are independent open-source projects that BayLeaf sets up for you. If you like one, you can often install it on your own computer later.</p>
${cards}</section>
<section aria-labelledby="ideas-title"><h2 id="ideas-title">Things you could try</h2><p class="note">The apps are more useful together, because they share the same files.</p>
<div class="examples"><div class="example"><h3>Build something, then look inside</h3><div class="flow">OpenChamber → VS Code</div><p>Ask an agent to build a small web app, then open the same project in VS Code to read how it works and make your own changes.</p></div>
<div class="example"><h3>Explore data, then hand it off</h3><div class="flow">Files → Nanobot → JupyterLab</div><p>Upload a dataset, ask Nanobot a few quick questions about it, then turn the analysis into a notebook for a collaborator.</p></div></div></section>
<section class="beyond" aria-labelledby="beyond-title"><h2 id="beyond-title">Not limited to this list</h2><p>Your sandbox is a whole computer, so you can install other software too. The apps above are convenient starting points we’ve heard people ask for. Ask an agent in OpenChamber or Nanobot to help you set up something else.</p><p>If an app becomes part of your routine, consider installing it on your own computer. Each project’s site explains how.</p></section>
<section class="care" id="care" aria-labelledby="care-title"><h2 id="care-title">Files, storage &amp; privacy</h2>
<p class="callout"><strong>Sandboxes unused for 90 days are deleted</strong>, along with their files and app histories. Download anything you want to keep.</p>
<details><summary>What happens when my sandbox sleeps?</summary><p>Saved files, settings, and app histories are kept. Running programs stop, including unfinished agent tasks. Unsaved work in an app may be lost.</p><p>Sandboxes normally sleep after about an hour of inactivity. Background activity can delay sleep. Opening an app restores access; signing in here also tries to wake an existing sandbox. Simply viewing this page does not keep it awake.</p></details>
<details><summary>Who can see what’s in my sandbox?</summary><p>Browser access to these apps is private to your account. Apps and agents inside the sandbox can access shared files, so isolation from your personal computer is not protection from software you run here.</p><p>AI inference uses zero-data-retention providers. Workspace files and app histories are stored, and operators can access that storage. See the <a href="https://github.com/bayleaf-ucsc/bayleaf/blob/main/PRIVACY.md">privacy notice</a>.</p></details>
<details><summary>Can I use my sandbox from BayLeaf Chat?</summary><p>Yes. <a href="https://chat.bayleaf.dev">BayLeaf Chat</a> can work with the same sandbox files. Its conversations are separate from OpenChamber and Nanobot.</p></details>
<details><summary>Advanced controls</summary><p><a href="https://api.bayleaf.dev/dashboard#sandbox">Sandbox &amp; API controls</a> include sandbox deletion and API key management.</p></details>
<p class="note"><a href="https://github.com/bayleaf-ucsc/bayleaf/blob/main/SUPPORT.md">Get help with your sandbox</a></p></section>
<footer><span>Part of <a href="https://bayleaf.dev">BayLeaf</a> at UC Santa Cruz.</span><a href="https://github.com/bayleaf-ucsc/bayleaf/blob/main/PRIVACY.md">Privacy notice</a></footer>
</main>${session ? `<script nonce="${nonce}">${controlsScript}</script>` : ''}${collectArrival ? `<script nonce="${nonce}">${arrivalScript('sandbox')}</script>` : ''}</body></html>`;
  return new Response(html, { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'${collectArrival ? ' https://telemetry.bayleaf.dev' : ''};${session ? ` frame-src ${PREVIEW_FRAMES};` : ''} base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`,
    // no-referrer suppresses Origin on native form POSTs in browsers. Keep
    // only the origin, never the path, so login/logout pass exact-Origin CSRF.
    'Referrer-Policy': 'strict-origin',
    'X-Content-Type-Options': 'nosniff',
  } });
}
