// Unlisted skills: `listed: false` frontmatter keeps a skill out of the system
// prompt's list but not out of reach. Only a YAML boolean false unlists; junk,
// quoted "false" and malformed frontmatter stay listed and never break discovery.
// Run: node test/skills-node.mjs
import assert from 'node:assert/strict';
import { loadContext, systemPrompt } from '../src/tools.js';

const files = {
  '/pouch/skills/plain/SKILL.md': '---\nname: plain\ndescription: Listed by default.\n---\nbody',
  '/pouch/skills/yes/SKILL.md': '---\nname: yes\ndescription: Says listed true.\nlisted: true\n---\n',
  '/pouch/skills/hidden/SKILL.md': '---\nname: hidden\ndescription: A helper.\nlisted: false\n---\nhidden body',
  '/pouch/skills/caps/SKILL.md': '---\nname: caps\ndescription: YAML False.\nlisted: False  # helper\n---\n',
  '/pouch/skills/crlf/SKILL.md': '---\r\nname: crlf\r\ndescription: Windows line endings.\r\nlisted: false\r\n---\r\n',
  '/pouch/skills/quoted/SKILL.md': '---\nname: quoted\ndescription: A string, not a boolean.\nlisted: "false"\n---\n',
  '/pouch/skills/junk/SKILL.md': '---\nname: junk\ndescription: Junk value.\nlisted: nope\n---\n',
  '/pouch/skills/broken/SKILL.md': '---\nlisted: false\nno closing fence',
  '/pouch/skills/nofile/README.md': 'no SKILL.md here',
  '/work/.agents/skills/proj-hidden/SKILL.md': '---\nname: proj-hidden\ndescription: Project helper.\nlisted: false\n---\n',
  '/work/.agents/skills/proj/SKILL.md': '---\nname: proj\ndescription: Project skill.\n---\n',
};
const fs = {
  async readFile(p) { if (p in files) return files[p]; throw new Error('ENOENT ' + p); },
  async readdir(d) {
    const names = new Set(Object.keys(files).filter((p) => p.startsWith(d + '/')).map((p) => p.slice(d.length + 1).split('/')[0]));
    if (!names.size) throw new Error('ENOENT ' + d);
    return [...names];
  },
};
const vfs = { fs, mounts: new Map(), seedLayer: null };

const { skills } = await loadContext(vfs);
const by = Object.fromEntries(skills.map((s) => [s.name, s]));
for (const n of ['plain', 'yes', 'quoted', 'junk', 'broken', 'proj']) assert.ok(by[n] && !by[n].unlisted, `${n} is listed`);
for (const n of ['hidden', 'caps', 'crlf', 'proj-hidden']) assert.equal(by[n]?.unlisted, true, `${n} is unlisted`);
assert.equal(by.crlf.description, 'Windows line endings.', 'CRLF leaves no stray \\r');
assert.equal(by.broken.path, '/pouch/skills/broken/SKILL.md', 'malformed frontmatter still discovered under its folder name');
assert.ok(!('nofile' in by), 'folder without SKILL.md skipped');
assert.equal(by['proj-hidden'].path, '/work/.agents/skills/proj-hidden/SKILL.md');

const prompt = await systemPrompt(vfs);
for (const n of ['plain', 'yes', 'quoted', 'junk', 'proj']) assert.ok(prompt.includes(`- ${n}: `), `prompt lists ${n}`);
for (const n of ['hidden', 'caps', 'crlf', 'proj-hidden']) assert.ok(!prompt.includes(`- ${n}: `) && !prompt.includes(`/${n}/SKILL.md`), `prompt omits ${n}`);
// Still loadable by name: the prompt says where named skills live, and the file reads.
assert.match(prompt, /Skills not listed here can still be named: read \/pouch\/skills\/<name>\/SKILL\.md or \/work\/\.agents\/skills\/<name>\/SKILL\.md/);
for (const n of ['hidden', 'proj-hidden']) {
  const hits = await Promise.all(['/pouch/skills', '/work/.agents/skills'].map((r) => fs.readFile(`${r}/${n}/SKILL.md`).catch(() => null)));
  assert.ok(hits.some((t) => t?.includes('listed: false')), `${n} resolves by name from the hinted roots`);
}

// The bundled skill-authoring skill documents the key.
const defaults = (await import('../src/defaults.js')).default;
assert.match(defaults['/skills/skill-authoring/SKILL.md'], /`listed: false`/);
console.log(`ok skills: ${skills.length} discovered across both roots, 4 unlisted (one CRLF) kept out of the prompt, junk/quoted/malformed stay listed`);
