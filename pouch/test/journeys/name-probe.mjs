const { TinfoilAI } = await import('tinfoil');
const client = new TinfoilAI({ bearerToken: process.env.BAYLEAF_API_KEY, baseURL: 'https://api.bayleaf.dev/sealed/v1/', attestationBundleURL: 'https://api.bayleaf.dev/sealed' });
await client.ready();
const r = await client.chat.completions.create({ model: 'glm-5-3', max_tokens: 40, stream: false, chat_template_kwargs: { enable_thinking: false }, messages: [
 { role: 'system', content: 'You name conversations. Reply with only a 2-5 word title in the language of the conversation. No quotes, no trailing period.' },
 { role: 'user', content: 'User: Please write a python script that counts words in /work/essay.txt\nTools used: write, bash\nAssistant: I wrote /work/count.py and ran it: 512 words.' }] });
console.log(JSON.stringify(r.choices[0], null, 1), r.usage);
