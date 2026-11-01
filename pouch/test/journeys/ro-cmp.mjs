import { launch } from './lib.mjs';
const ctx = await launch({ userDataDir: '/tmp/pouch-qa/ro-t14' });
const page = await ctx.newPage(); await page.goto(process.env.POUCH_URL); await new Promise(r => setTimeout(r, 2000));
const t = await page.evaluate(async () => { const d = await navigator.storage.getDirectory(); return [await (await (await d.getFileHandle('report.csv')).getFile()).text(), (await (await (await d.getFileHandle('build_report.js')).getFile()).text()).slice(0, 1500)]; });
const live = 'department,count,median_salary\nComputational Media,23,93200\nComputer Science,33,90800\nElectrical and Computer Engineering,14,91550\nHistory,32,98050\nLinguistics,29,85600\nMathematics,31,89100\nPsychology,29,90400\n';
console.log('rerun == live report:', t[0] === live, JSON.stringify(t[0].slice(-20)));
console.log(t[1]); await ctx.close();
