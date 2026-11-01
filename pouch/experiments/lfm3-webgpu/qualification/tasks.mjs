// The qualification benchmark: synthetic workspace tasks, each with its starting
// files, a prompt and a grader. Pure data plus graders; qualify.mjs runs them.
//
// CORE is the seven tasks of agent-v2 (first five) and quant (jsonlist, yaml),
// copied verbatim from run2.mjs/run-quant.mjs so their numbers stay comparable.
// HELD_OUT tasks exist to catch recipe overfitting: none of them resembles the
// recipe's few-shot turn (an append plus a create). Add new held-out tasks here,
// never to CORE, and never tune a recipe while looking at their traces.
//
// A grader gets (files, result, finalAnswer) and returns true only for a correct
// end state. Graders are byte-exact unless the task says otherwise.

const base = {
  '/work/README.md': '# Lantern\nA small temperature converter. src/convert.js is logic, src/ui.js is display.\n',
  '/work/src/convert.js': 'export function celsiusToFahrenheit(c) {\n  return c * 9 / 5 + 30;\n}\n',
  '/work/src/ui.js': 'export const label = "Temperature";\n',
  '/work/docs/notes.txt': 'Keep output concise.\n',
};
const fixed = (f) => ({ ...f, '/work/src/convert.js': f['/work/src/convert.js'].replace('+ 30', '+ 32') });
const uiR = 'import { celsiusToFahrenheit } from "./convert.js";\nexport const label = "Temperature";\nexport function show(c) {\n  return label + ": " + celsiusToFahrenheit(c);\n}\n';
const renameFiles = { ...fixed(base), '/work/src/convert.js': 'export function celsiusToFahrenheit(c) {\n  return c * 9 / 5 + 32;\n}\n', '/work/src/ui.js': uiR };
const cfgFiles = { '/work/README.md': base['/work/README.md'], '/work/config.json': '{\n  "precision": 1\n}\n', '/work/src/convert.js': fixed(base)['/work/src/convert.js'], '/work/src/ui.js': 'import config from "../config.json" with { type: "json" };\nimport { celsiusToFahrenheit } from "./convert.js";\nexport function show(c) {\n  return celsiusToFahrenheit(c).toFixed(config.precision);\n}\n' };
const listFiles = { '/work/README.md': base['/work/README.md'], '/work/config.json': '{\n  "precision": 1,\n  "unit": "C",\n  "labels": ["Cold", "Warm"],\n  "debug": false\n}\n' };
const yml = 'name: build\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: npm test\n';
const ymlFiles = { '/work/README.md': base['/work/README.md'], '/work/.github/workflows/ci.yml': yml };
export const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

export const CORE = [
  { name: 'tree', files: base, prompt: 'Inspect this unfamiliar workspace using tools. List its tree, read the README and source files, then summarize what the project does. Do not change files.',
    check: (f, r, ans) => same(f, base) && r.trace.some((x) => x.call?.function.name === 'bash') && r.trace.filter((x) => x.call?.function.name === 'read').length >= 3 && /convert|temperature|celsius/i.test(ans) },
  { name: 'edit', files: base, prompt: 'Read src/convert.js and correct the Celsius-to-Fahrenheit offset from 30 to 32. Change nothing else.', check: (f) => same(f, fixed(base)) },
  // Resembles the recipe's few-shot turn: read its recipe-on score as partly taught.
  { name: 'feature', files: base, prompt: 'Add the exact line export const unit = "F"; followed by a newline to the end of src/ui.js. Create docs/unit.txt with exactly Fahrenheit followed by a newline. Also fix the offset in src/convert.js from 30 to 32. Read files first; change nothing else.',
    check: (f) => same(f, { ...fixed(base), '/work/src/ui.js': base['/work/src/ui.js'] + 'export const unit = "F";\n', '/work/docs/unit.txt': 'Fahrenheit\n' }) },
  { name: 'rename', files: renameFiles, prompt: 'Rename the function celsiusToFahrenheit to toFahrenheit everywhere in the workspace: its definition, imports and calls. Find all uses first. Change nothing else.',
    check: (f) => same(f, Object.fromEntries(Object.entries(renameFiles).map(([k, v]) => [k, v.replaceAll('celsiusToFahrenheit', 'toFahrenheit')]))) },
  // Graded on parsed JSON and by executing show(10); other files byte-exact.
  { name: 'config', files: cfgFiles, prompt: 'Add a "unit" field with the value "F" to config.json, keeping "precision". Then change show() in src/ui.js so it returns the formatted number followed by a space and config.unit, for example "50.0 F". Read files first. Change nothing else.',
    check: (f) => { try {
      const c = JSON.parse(f['/work/config.json']); if (JSON.stringify(c) !== '{"precision":1,"unit":"F"}') return false;
      if (!same({ ...f, '/work/config.json': 0, '/work/src/ui.js': 0 }, { ...cfgFiles, '/work/config.json': 0, '/work/src/ui.js': 0 })) return false;
      const ui = f['/work/src/ui.js']; if (!/^import config from "\.\.\/config\.json" with \{ type: "json" \};\nimport \{ celsiusToFahrenheit \} from "\.\/convert\.js";\n/.test(ui)) return false;
      const body = ui.split('\n').slice(2).join('\n').replace(/export /g, '');
      return new Function('config', 'celsiusToFahrenheit', body + '\nreturn show(10);')(c, (x) => x * 9 / 5 + 32) === '50.0 F';
    } catch { return false; } } },
  // json-list: three keys in one file, one a list append. Graded on parsed JSON (key order kept).
  { name: 'jsonlist', files: listFiles, prompt: 'In config.json: set "precision" to 2, set "unit" to "F", and append "Hot" as a third item at the end of the "labels" list. Keep "debug" unchanged. Read the file first. Change nothing else.',
    check: (f) => { try { return JSON.stringify(JSON.parse(f['/work/config.json'])) === '{"precision":2,"unit":"F","labels":["Cold","Warm","Hot"],"debug":false}' && same({ ...f, '/work/config.json': 0 }, { ...listFiles, '/work/config.json': 0 }); } catch { return false; } } },
  // yaml-whitespace: an insert at exact indentation, byte-exact.
  { name: 'yaml', files: ymlFiles, prompt: 'In .github/workflows/ci.yml, add a step that runs npm run lint between the npm ci step and the npm test step, written exactly like the other run steps (same indentation). Read the file first. Change nothing else.',
    check: (f) => same(f, { ...ymlFiles, '/work/.github/workflows/ci.yml': yml.replace('      - run: npm test\n', '      - run: npm run lint\n      - run: npm test\n') }) },
];

// Held-out tasks (added 2026-10-31, not yet run against any recipe-tuning loop).
const ini = '[display]\nunit = C\ndebug = true\nprecision = 1\n';
const iniFiles = { '/work/README.md': base['/work/README.md'], '/work/settings.ini': ini };
const many = '# Lantern\n\nConverts Celsius to Fahrenheit.\n\n## Usage\n\nPass a Celsius value; Celsius input may be negative.\n';
const manyFiles = { ...base, '/work/README.md': many };
export const HELD_OUT = [
  // A deletion in the middle of a file: newText is empty, the opposite of an append.
  { name: 'delete-line', files: iniFiles, prompt: 'Remove the debug setting from settings.ini entirely, including its line. Read the file first. Change nothing else.',
    check: (f) => same(f, { ...iniFiles, '/work/settings.ini': '[display]\nunit = C\nprecision = 1\n' }) },
  // A word that occurs three times: a single-match edit is refused, so the model must widen
  // oldText, edit three times, or rewrite the file.
  { name: 'replace-all', files: manyFiles, prompt: 'In README.md, replace every occurrence of the word Celsius with Centigrade. Read the file first. Change nothing else.',
    check: (f) => same(f, { ...manyFiles, '/work/README.md': many.replaceAll('Celsius', 'Centigrade') }) },
];

export const TASKS = Object.fromEntries([...CORE, ...HELD_OUT].map((t) => [t.name, t]));
export const CORE_NAMES = CORE.map((t) => t.name), HELD_OUT_NAMES = HELD_OUT.map((t) => t.name);
// The five agent-v2 tasks, for comparing against that table.
export const FIVE = ['tree', 'edit', 'feature', 'rename', 'config'];
