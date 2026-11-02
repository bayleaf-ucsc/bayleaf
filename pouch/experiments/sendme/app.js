import init, { TransferNode } from './pkg/pouch_sendme_experiment.js';
import QRCode from './qr.js';

const $ = id => document.getElementById(id);
let node, busy = false, urls = [];
const log = message => { $('log').textContent += `${new Date().toISOString()} ${message}\n`; };
const status = message => { $('status').textContent = message; log(message); };
const controls = () => {
  $('start').disabled = !!node || busy;
  $('stop').disabled = !node || busy;
  $('send').disabled = !node || busy || !!$('out').value;
  $('receive').disabled = !node || busy;
  $('pause').disabled = !node || !busy;
};
const clearDownloads = () => { urls.forEach(URL.revokeObjectURL); urls = []; $('downloads').replaceChildren(); };
try { await init(); status('Not connected.'); }
catch (e) { status(`Runtime failed to load: ${e.message}`); throw e; }

// Read a QR link locally. No automatic network operation or receive on navigation.
if (location.hash.startsWith('#receive=')) {
  $('ticket').value = decodeURIComponent(location.hash.slice(9));
  history.replaceState(null, '', location.pathname + location.search);
}

$('start').onclick = async () => {
  busy = true; controls(); status('Connecting to public relay…');
  try { node = await TransferNode.spawn(); status(`Connected. Endpoint ${node.endpoint_id().slice(0, 12)}…`); }
  catch (e) { status(`Connection failed: ${e.message}`); }
  finally { busy = false; controls(); }
};
$('stop').onclick = async () => {
  busy = true; controls();
  try { await node.close(); }
  catch (e) { log(e.message); }
  finally {
    node?.free(); node = undefined; clearDownloads(); $('out').value = '';
    $('qr').hidden = true; $('qr-note').textContent = ''; busy = false; controls(); status('Stopped. In-memory data cleared.');
  }
};
$('send').onclick = async () => {
  const files = [...$('files').files, ...$('folder').files];
  if (!files.length) return status('Choose files first.');
  if (files.length > 256 || files.reduce((n, f) => n + f.size, 0) > 64 * 1024 ** 2 - 65536)
    return status('Experiment limit: 256 files, slightly under 64 MiB including metadata.');
  busy = true; controls(); status('Hashing selected files…');
  try {
    for (const file of files) await node.add_file(file.webkitRelativePath || file.name, new Uint8Array(await file.arrayBuffer()));
    const ticket = await node.ticket(); $('out').value = ticket;
    const link = new URL(location.href); link.hash = `receive=${encodeURIComponent(ticket)}`;
    await QRCode.toCanvas($('qr'), link.href, { width: 320, margin: 2 }); $('qr').hidden = false;
    const local = ['127.0.0.1', 'localhost'].includes(location.hostname);
    $('qr-note').textContent = local
      ? 'This localhost QR is only usable on this computer. For a phone, serve this experiment at a reachable HTTPS origin; do not expose the repository or developer server.'
      : 'The link contains the ticket. Share it only with the intended recipient.';
    status(`Sharing ${files.length} file(s). Keep this page open.`);
  } catch (e) { status(`Send failed: ${e.message}. Stop and reconnect before retrying.`); }
  finally { busy = false; controls(); }
};
$('receive').onclick = async () => {
  let ticket = $('ticket').value.trim();
  if (/^https?:/.test(ticket)) {
    try { ticket = decodeURIComponent(new URL(ticket).hash.slice(9)); }
    catch { return status('Invalid receive link.'); }
  }
  if (!ticket) return status('Paste a ticket first.');
  busy = true; controls(); clearDownloads(); status('Connecting to sender…');
  try {
    const files = await node.receive(ticket, (downloaded, total, cached) => {
      $('progress').max = total || 1; $('progress').value = Math.min(total, downloaded + cached);
      $('counts').textContent = `${downloaded.toLocaleString()} transfer bytes this attempt (including proofs); ${cached.toLocaleString()} content bytes already cached; ${total.toLocaleString()} content bytes total.`;
    });
    for (let i = 0; i < files.length; i++) {
      const bytes = await node.file_bytes(i);
      const url = URL.createObjectURL(new Blob([bytes])); urls.push(url);
      const a = document.createElement('a'); a.href = url; a.download = files[i].name.split('/').at(-1);
      a.textContent = `${files[i].name} (${bytes.length.toLocaleString()} bytes, verified)`;
      $('downloads').append(a);
    }
    $('progress').value = $('progress').max; status(`Received ${files.length} verified file(s). Choose a file to save.`);
  } catch (e) { status(`Transfer stopped: ${e.message}. Retry retains validated bytes while this page stays open.`); }
  finally { busy = false; controls(); }
};
$('pause').onclick = () => { node.pause(); status('Pausing transfer…'); };
controls();
