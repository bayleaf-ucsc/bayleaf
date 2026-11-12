import type { FC } from 'hono/jsx';
import { cardStyle } from './layout';

/** Rooms. Lists recognition metadata only: creation and capability links stay agent/API
 * actions, so no rk_ secret ever reaches this page. Session endpoints: routes/rooms.ts. */
export const RoomsCard: FC = () => (
  <section id="rooms" class={cardStyle}>
    <style>{`
      #rooms { overflow-wrap: anywhere; }
      #room-list { list-style: none; padding: 0; }
      #room-list li { border-top: 1px solid #767676; padding: .5rem 0; display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
      #room-list .room-identity { display: inline-flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; flex: 1; }
      #room-list time, #room-list .room-meta { color: #555; font-size: .85rem; }
      #room-list .room-actions { display: inline-flex; gap: .35rem; }
      #room-list button { font: inherit; font-size: .85rem; padding: .35rem .5rem; cursor: pointer; border: 1px solid #003c6c; border-radius: 4px; background: #003c6c; color: white; }
      #room-list button:disabled { opacity: .6; cursor: default; }
    `}</style>
    <h2>Rooms</h2>
    <p>Shared state for apps you build: participants hold capability links, and each room
      ends at a fixed time that use never extends. Rooms store what participants send
      (not zero data retention). Ask your agent to create rooms and links through
      the <a href="/docs#tag/rooms">Rooms API</a>; here you can extend or delete them.</p>
    <p id="room-status" role="status"></p>
    <ul id="room-list" aria-label="Your rooms"></ul>
    <script dangerouslySetInnerHTML={{ __html: `
(() => {
  const status = document.getElementById('room-status');
  async function request(path, init) {
    const response = await fetch(path, init); const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || 'Request failed'); return body;
  }
  const when = iso => new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  async function refresh() {
    const { rooms } = await request('/dashboard/rooms');
    const list = document.getElementById('room-list'); list.replaceChildren();
    if (!rooms.length) { const item = document.createElement('li'); item.textContent = 'No live rooms.'; list.append(item); }
    for (const room of rooms) {
      const name = room.label || room.room_id;
      const item = document.createElement('li');
      const identity = document.createElement('span'); identity.className = 'room-identity';
      const title = document.createElement('strong'); title.textContent = name;
      const meta = document.createElement('span'); meta.className = 'room-meta';
      meta.textContent = room.codec + (room.mode === 'read_only' ? ', frozen' : '') + (typeof room.head === 'number' ? ', ' + room.head + ' entries' : '');
      const expiry = document.createElement('time'); expiry.dateTime = room.expires_at;
      expiry.textContent = 'ends ' + when(room.expires_at); expiry.title = new Date(room.expires_at).toLocaleString();
      identity.append(title, meta, expiry); item.append(identity);
      const actions = document.createElement('span'); actions.className = 'room-actions';
      const extend = document.createElement('button'); extend.type = 'button'; extend.textContent = 'End in 90 days';
      extend.setAttribute('aria-label', 'Set room ' + name + ' to end 90 days from now');
      extend.onclick = async () => {
        extend.disabled = true;
        try { await request('/dashboard/rooms/' + encodeURIComponent(room.room_id), { method: 'PATCH',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: 90 }) });
          await refresh(); status.textContent = name + ': now ends in 90 days.'; }
        catch (e) { status.textContent = e.message; extend.disabled = false; }
      };
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete room';
      remove.setAttribute('aria-label', 'Delete room ' + name);
      remove.onclick = async () => {
        if (!confirm('Delete ' + name + '? It ends for every participant at once. Export first if anyone needs the content.')) return;
        remove.disabled = true;
        try { await request('/dashboard/rooms/' + encodeURIComponent(room.room_id), { method: 'DELETE' });
          await refresh(); status.textContent = name + ': deleted.'; }
        catch (e) { status.textContent = e.message; remove.disabled = false; }
      };
      actions.append(extend, remove); item.append(actions); list.append(item);
    }
  }
  refresh().catch(e => { status.textContent = e.message; });
})();
` }}/>
  </section>
);
