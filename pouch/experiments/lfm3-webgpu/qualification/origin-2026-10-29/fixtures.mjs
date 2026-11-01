export const files={'/work/README.md':'# Lantern\nA small temperature converter. src/convert.js is logic, src/ui.js is display.\n','/work/src/convert.js':'export function celsiusToFahrenheit(c) {\n  return c * 9 / 5 + 30;\n}\n','/work/src/ui.js':'export const label = "Temperature";\n','/work/docs/notes.txt':'Keep output concise.\n'};
export const tasks=[
 {name:'tree',prompt:'Inspect this unfamiliar workspace using tools. List its tree, read the README and source files, then summarize what the project does. Do not change files.'},
 {name:'edit',prompt:'Read src/convert.js and correct the Celsius-to-Fahrenheit offset from 30 to 32. Change nothing else.'},
 {name:'feature',prompt:'Add the exact line export const unit = "F"; followed by a newline to the end of src/ui.js. Create docs/unit.txt with exactly Fahrenheit followed by a newline. Also fix the offset in src/convert.js from 30 to 32. Read files first; change nothing else.'},
 {name:'missing',prompt:'The previous read failed. Find the actual converter file, read it, and fix its offset from 30 to 32. Change nothing else.',inject:{type:'function',function:{name:'read',arguments:{path:'src/converter.js'}}}},
 {name:'ambiguous',prompt:'The previous edit was ambiguous. Read settings.txt and change only the second section value from false to true. Keep the first section false and all other bytes unchanged.',files:{'/work/settings.txt':'[first]\nenabled=false\n[second]\nenabled=false\n'},inject:{type:'function',function:{name:'edit',arguments:{path:'settings.txt',oldText:'enabled=false',newText:'enabled=true'}}}},
];
export function check(task,r){
 const expected={...(task.files??files)};
 if(['edit','feature','missing'].includes(task.name))expected['/work/src/convert.js']=files['/work/src/convert.js'].replace('+ 30','+ 32');
 if(task.name==='feature'){expected['/work/src/ui.js']+='export const unit = "F";\n';expected['/work/docs/unit.txt']='Fahrenheit\n'}
 if(task.name==='ambiguous')expected['/work/settings.txt']='[first]\nenabled=false\n[second]\nenabled=true\n';
 const exact=JSON.stringify(Object.entries(r.files).sort())===JSON.stringify(Object.entries(expected).sort());
 const answer=r.trace.filter(x=>x.text).at(-1)?.text??'';
 const tree=task.name!=='tree'||(r.trace.some(x=>x.call?.function.name==='bash')&&r.trace.filter(x=>x.call?.function.name==='read').length>=3&&/convert|temperature|celsius/i.test(answer));
 return{expected,pass:exact&&tree&&r.status==='final'};
}
export const turns=[
 'Read facts.txt. Remember the project name and color for this conversation. Reply briefly.',
 'Change count=0 to count=1 in facts.txt. Preserve every other byte.',
 'Without reading a file, what project name and color did I ask you to remember?',
 'Create marker.txt containing exactly READY followed by a newline.',
 'Read facts.txt and change count=1 to count=2. Preserve everything else.',
 'Without tools, recall what marker.txt contains and the original color.',
 'Read marker.txt and append exactly DONE followed by a newline, preserving READY.',
 'Read facts.txt and change color=violet to color=amber. Preserve everything else.',
 'Without tools, state the original color, current color, project name and count.',
 'Read marker.txt and facts.txt. Summarize both in one sentence. Make no changes.',
];
