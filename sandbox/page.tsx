import { SERVICES } from './services';

// Standalone HTML keeps this Worker independent of the API dashboard's Hono layout.
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!));

const styles = `
  * { box-sizing:border-box; }
  [hidden] { display:none !important; }
  body { margin:0; background:#f6f8f4; color:#24352b; font:1rem/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  main { max-width:1120px; margin:auto; padding:1.5rem; }
  a,summary { color:#1e5a3a; text-underline-offset:0.2em; }
  :focus-visible { outline:3px solid #2a5298; outline-offset:4px; }
  nav,.actions,.account { display:flex; flex-wrap:wrap; align-items:center; gap:0.5rem 1rem; }
  nav a:first-child { margin-right:auto; font-weight:700; }
  .account { font-size:0.85rem; }
  .account p { margin:0; overflow-wrap:anywhere; }
  .eyebrow { margin:0; color:#365a43; font-size:0.85rem; }
  h1 { font-size:clamp(2rem,6vw,2.8rem); line-height:1.1; letter-spacing:-0.04em; margin:2rem 0 0.75rem; }
  h2 { font-size:1.15rem; line-height:1.3; margin:0; }
  .lede { max-width:65ch; margin:0 0 1.5rem; color:#48594e; }
  .services { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); align-items:start; gap:1rem; margin:1.5rem 0; }
  .service { min-width:0; padding:1.25rem; background:#fff; border:1px solid #b7cebe; border-radius:10px; }
  .description { color:#48594e; margin:0.75rem 0; min-height:4.5em; }
  .service details { font-size:0.85rem; margin:0.75rem 0 0; }
  .service details .actions { margin-top:0.5rem; }
  .service .actions > .button { width:100%; }
  .note-window { font-size:0.75rem; font-weight:400; margin-left:0.5rem; }
  .workspace-info { border-top:1px solid #b7cebe; padding-top:0.5rem; font-size:0.9rem; }
  .workspace-info p { max-width:80ch; }
  button,.button { display:inline-flex; justify-content:center; align-items:center; min-height:44px; padding:0.65rem 1rem; border:1px solid #1e5a3a; border-radius:6px; font:inherit; font-weight:600; cursor:pointer; }
  .button { background:#1e5a3a; color:#fff; text-decoration:none; }
  .button:hover { background:#16432b; }
  button.secondary { background:#fff; color:#1e5a3a; }
  button:disabled { cursor:wait; opacity:0.65; }
  .note,footer,.browser-timing { color:#48594e; font-size:0.9rem; }
  details { margin:1rem 0; }
  summary { cursor:pointer; padding:0.5rem 0; }
  .status-box { display:flex; align-items:center; gap:0.5rem; color:#365a43; font-size:0.85rem; margin:1rem 0 0.75rem; }
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
  @media (max-width:800px) { .services { grid-template-columns:1fr; } .description { min-height:0; } }
  @media (max-width:380px) { main { padding:1.25rem 1rem; } .status-box { flex-wrap:wrap; } }
`;

const controls = (service: typeof SERVICES[number]) => `
  <div class="status-box">
    <span class="service-activity" aria-hidden="true"></span>
    <p id="${service.id}-status" role="status" aria-live="polite">Checking status…</p>
  </div>
  <form id="${service.id}-login" method="post" action="/login" hidden><button class="button" type="submit">Sign in again</button></form>
  <div class="actions">
    <button type="button" class="button" id="${service.id}-start" aria-label="Launch ${escapeHtml(service.name)}" hidden>${escapeHtml(service.launch)}</button>
    <a class="button" id="${service.id}-open" aria-label="Open ${escapeHtml(service.name)} (new tab)" hidden target="_blank" rel="noopener noreferrer">Open <span class="note-window">(new tab)</span></a>
  </div>
  <details><summary>App help &amp; diagnostics</summary>
    <p id="${service.id}-intro" class="note" hidden>${escapeHtml(service.intro)}</p>
    <div class="actions">
      <button type="button" class="secondary" id="${service.id}-restart" hidden>Set up / restart ${escapeHtml(service.name)}</button>
    </div>
    <p class="note">${escapeHtml(service.help)}</p>
    ${service.notes.map(note => `<p class="note">${escapeHtml(note)}</p>`).join('')}
    <p id="${service.id}-timing" class="browser-timing" hidden></p>
    <p id="${service.id}-previous" class="note" hidden></p>
    <details id="${service.id}-progress" hidden><summary>Setup activity</summary><ol id="${service.id}-timeline" class="browser-timeline"></ol></details>
    <p class="note"><a href="https://github.com/bayleaf-ucsc/bayleaf/blob/main/SUPPORT.md">Get help with your sandbox</a>.</p>
  </details>
  <noscript><p>Enable JavaScript to check status and set up ${escapeHtml(service.name)}. <a href="https://api.bayleaf.dev/dashboard#sandbox">Low-level sandbox and API access</a> is also available.</p></noscript>
`;

/** Shared managed-app status and controls; activity styling follows data-phase. */
const controlsScript = `(() => {
  for (const button of document.querySelectorAll('[data-access-action]')) {
    button.addEventListener('click', async () => {
      const action = button.dataset.accessAction;
      if (action === 'revoke' && !confirm('Revoke this sandbox’s API access and managed browser links? Your ordinary API key and files remain. Deliberate app setup can authorize access again.')) return;
      button.disabled = true;
      const status = document.getElementById('access-status');
      try {
        const r = await fetch('/access/' + action, {method:'POST', headers:{'X-BayLeaf-Action':'managed-service'}});
        status.textContent = r.ok ? (action === 'revoke' ? 'Sandbox access revoked.' : 'Sandbox credential rotated. Requests may fail for up to 15 seconds while Daytona updates.') : 'Could not change sandbox access. Refresh and try again.';
        if (r.ok && action === 'revoke') window.dispatchEvent(new Event('focus'));
      } catch { status.textContent = 'Could not reach the service.'; }
      finally { button.disabled = false; }
    });
  }
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
       el('status').textContent=s.error ? (errors[s.error]||'Could not open '+service.name+'. Try again, or contact BayLeaf support.')
         :opening?(labels[s.progress]||'Preparing '+service.name)+'…'
         :'';
      el('start').hidden=ready||opening;
       el('start').textContent=s.phase==='failed'?'Try again':service.launch;
       el('start').setAttribute('aria-label',el('start').textContent+' '+service.name);
      el('intro').hidden=s.machine!=='absent';
      el('open').hidden=!ready;
      if(ready)el('open').href=url;else el('open').removeAttribute('href');
      el('restart').hidden=!ready;
      const previous=s.previous_failure;
      el('previous').hidden=!previous;
      el('previous').textContent=previous?'Previous attempt failed at '+clock(previous.at)+' after '+duration(previous.elapsed)
        +': '+(errors[previous.error]||'Setup could not complete')+' ['+previous.error+'].':'';
       timing();
      if(opening)timer=setTimeout(refresh,5000);
    }
    function signedOut() {
      authExpired=true;ready=false;snapshot=undefined;clearTimeout(timer);
      root.dataset.phase='signed-out';
      for(const id of ['start','restart','open','timing','progress','previous'])el(id).hidden=true;
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
      const actionButtons=['start','restart'].map(el);
      actionButtons.forEach(b=>b.disabled=true);
       el('status').textContent='Requesting '+service.name+(name==='restart'?' restart…':' setup…');
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
     <p class="description">${escapeHtml(service.description)}</p>
      ${session ? controls(service) : ''}
  </section>`).join('');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="BayLeaf Sandboxes: managed apps and a shared workspace for the UC Santa Cruz community.">
<meta name="theme-color" content="#1e5a3a"><title>BayLeaf Sandboxes${session ? ' · Your workspace' : ''}</title>
<style nonce="${nonce}">${styles}</style></head><body><main>
<nav aria-label="BayLeaf home"><a href="https://bayleaf.dev">BayLeaf</a>
${session ? `<div class="account"><p>${escapeHtml(session.email)}</p><form method="post" action="/logout"><button class="secondary" type="submit">Sign out</button></form></div>` : '<p class="eyebrow">For the UC Santa Cruz community</p>'}</nav>
<h1>BayLeaf Sandboxes</h1>
<p class="lede">Your sandbox can run several managed apps, but it falls asleep once you disconnect from it. The same sandbox and files are also accessible from <a href="https://chat.bayleaf.dev">BayLeaf Chat</a>.</p>
${session ? '' : '<form method="post" action="/login"><button class="button" type="submit">Sign in with UCSC</button></form>'}
<div class="services" aria-label="Managed apps">${cards}</div>
${session ? `<section aria-labelledby="access-title"><h2 id="access-title">Sandbox API access</h2>
<p>Your sandbox has its own credential, held by Daytona. Code uses a placeholder for access to api.bayleaf.dev and shares your existing allowances. Revoking your ordinary API key does not revoke this access.</p>
<button type="button" class="secondary" data-access-action="rotate">Rotate sandbox credential</button>
<button type="button" class="secondary" data-access-action="revoke">Revoke sandbox access</button>
<p id="access-status" role="status" aria-live="polite"></p></section>` : ''}
<details class="workspace-info"><summary>Your sandbox: files, privacy &amp; retention</summary>
<p>Files and agent histories persist between sessions; running tasks can stop when the sandbox is idle. Chat and OpenChamber keep separate conversation histories.</p>
<p>Sandboxes inactive for <strong>90 days are deleted</strong>, including their files and histories. Export anything you need to keep.</p>
<p>AI inference uses zero-data-retention providers. Workspace files and history are stored, and operators can access that storage.</p>
<p><a href="https://api.bayleaf.dev/dashboard#sandbox">Sandbox &amp; API controls</a>, including sandbox deletion.</p>
</details>
<footer><span>Part of <a href="https://bayleaf.dev">BayLeaf</a> at UC Santa Cruz.</span><a href="https://github.com/bayleaf-ucsc/bayleaf/blob/main/PRIVACY.md">Privacy notice</a></footer>
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
