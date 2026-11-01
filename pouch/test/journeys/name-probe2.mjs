const { TinfoilAI } = await import('tinfoil');
const client = new TinfoilAI({ bearerToken: process.env.BAYLEAF_API_KEY, baseURL: 'https://api.bayleaf.dev/sealed/v1/', attestationBundleURL: 'https://api.bayleaf.dev/sealed' });
await client.ready();
const r = await client.chat.completions.create({ model: 'glm-5-3', max_tokens: 400, stream: false, messages: [
 { role: 'user', content: 'Write a 2-5 word title for the conversation below, in its language. Output the title alone: no quotes, no explanation, no trailing period.\n\n<conversation>\nUser: Please write a python script that counts words in /work/essay.txt\nTools used: write, bash\nAssistant: I wrote /work/count.py and ran it: 512 words.\n</conversation>' }] });
console.log(JSON.stringify(r.choices[0].message.content), r.choices[0].finish_reason, r.usage.completion_tokens);
