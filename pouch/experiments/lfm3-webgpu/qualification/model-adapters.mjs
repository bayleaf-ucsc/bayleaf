// Pure, testable family adapters. No generated argument text is executed.
export function executionOptions(value = {}) {
  const options = { loader: 'text-generation', toolFormat: 'xml', ...value };
  if (!['text-generation', 'gemma4'].includes(options.loader)) throw Error(`Unknown loader ${options.loader}`);
  if (!['xml', 'gemma4'].includes(options.toolFormat)) throw Error(`Unknown tool format ${options.toolFormat}`);
  return options;
}

// Gemma's native grammar uses literal <|"|> delimiters, not JSON string escapes.
// Recursive descent keeps commas, braces, quotes and newlines inside strings intact.
export function gemmaArguments(source) {
  let i = 0;
  const whitespace = () => { while (/\s/.test(source[i] ?? '') && i < source.length) i++; };
  const take = (s) => { whitespace(); if (!source.startsWith(s, i)) throw Error(`Expected ${s} at ${i}`); i += s.length; };
  function string() {
    take('<|"|>'); const end = source.indexOf('<|"|>', i);
    if (end < 0) throw Error('Unterminated Gemma string');
    const text = source.slice(i, end); i = end + 5; return text;
  }
  function jsonString() {
    whitespace(); const start = i++;
    for (; i < source.length; i++) {
      if (source[i] === '\\') { i++; continue; }
      if (source[i] === '"') return JSON.parse(source.slice(start, ++i));
    }
    throw Error('Unterminated JSON string in Gemma arguments');
  }
  function value(depth = 0) {
    if (depth > 64) throw Error('Gemma arguments nested too deeply');
    whitespace();
    if (source.startsWith('<|"|>', i)) return string();
    if (source[i] === '"') return jsonString();
    const c = source[i];
    if (c === '{' || c === '[') {
      i++; const object = c === '{', out = object ? {} : [], end = object ? '}' : ']';
      whitespace();
      if (source[i] !== end) for (;;) {
        let key;
        if (object) {
          whitespace();
          if (source.startsWith('<|"|>', i)) key = string();
          else if (source[i] === '"') key = jsonString();
          else { const m = /^[A-Za-z_][\w.-]*/.exec(source.slice(i)); if (!m) throw Error(`Invalid key at ${i}`); key = m[0]; i += key.length; }
          if (['__proto__', 'prototype', 'constructor'].includes(key) || Object.hasOwn(out, key)) throw Error(`Unsafe or duplicate key ${key}`);
          take(':');
        }
        const v = value(depth + 1);
        if (object) out[key] = v; else out.push(v);
        whitespace(); if (source[i] === end) break; take(',');
      }
      take(end); return out;
    }
    // Google's reference extractor also accepts unquoted string values, e.g.
    // path:src/convert.js. Preserve them as literal data, never execute them.
    const m = /^[^,}\]\[{]+/.exec(source.slice(i));
    if (!m || !m[0].trim()) throw Error(`Invalid value at ${i}`);
    i += m[0].length; const literal = m[0].trim();
    if (/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(literal)) {
      const parsed = JSON.parse(literal);
      if (typeof parsed === 'number' && !Number.isFinite(parsed)) throw Error('Non-finite Gemma number');
      return parsed;
    }
    if (literal.includes('<|')) throw Error('Malformed Gemma string delimiter');
    return literal;
  }
  const result = value(); whitespace();
  if (i !== source.length || !result || Array.isArray(result) || typeof result !== 'object') throw Error('Expected one Gemma argument object');
  return result;
}

export function parseToolCalls(text, format, tools = []) {
  const calls = [];
  if (format === 'gemma4') {
    // Scan outside argument strings: a literal closing tag inside a string is data.
    let at = 0;
    while ((at = text.indexOf('<|tool_call>', at)) >= 0) {
      const start = at + 12; let end = start, quoted = null;
      for (; end < text.length; end++) {
        if (quoted === 'json' && text[end] === '\\') { end++; continue; }
        if (text[end] === '"' && quoted !== 'native') quoted = quoted === 'json' ? null : 'json';
        else if (text.startsWith('<|"|>', end) && quoted !== 'json') { quoted = quoted === 'native' ? null : 'native'; end += 4; }
        else if (!quoted && text.startsWith('<tool_call|>', end)) break;
      }
      if (end === text.length) throw Error('Incomplete Gemma tool call');
      const m = /^\s*call:([\w.-]+)\s*(\{[\s\S]*\})\s*$/.exec(text.slice(start, end));
      if (!m) throw Error('Malformed Gemma tool call');
      calls.push({ type: 'function', function: { name: m[1], arguments: gemmaArguments(m[2]) } });
      at = end + 12;
    }
  } else if (format === 'xml') {
    for (const m of text.matchAll(/<tool_call>\s*<function=([^>\n]+)>([\s\S]*?)<\/function>\s*<\/tool_call>/g)) {
      const args = {};
      for (const p of m[2].matchAll(/<parameter=([^>\n]+)>\n?([\s\S]*?)\n?<\/parameter>/g)) {
        const key = p[1]; if (['__proto__', 'prototype', 'constructor'].includes(key)) throw Error('Unsafe XML argument key');
        const type = tools.find((t) => t.function.name === m[1].trim())?.function.parameters.properties?.[key]?.type;
        let value = p[2]; if (type && type !== 'string') { try { value = JSON.parse(value); } catch {} }
        args[key] = value;
      }
      calls.push({ type: 'function', function: { name: m[1].trim(), arguments: args } });
    }
    if ((text.match(/<tool_call>/g) ?? []).length !== calls.length) throw Error('Malformed/incomplete native XML tool call');
  } else throw Error(`Unknown tool format ${format}`);
  return calls;
}

// Gemma resolves tool results through call ids. Older XML recipes omit them.
export function withToolIds(messages) {
  let pending = [], seq = 0;
  return messages.map((message) => {
    if (message.role === 'assistant') {
      pending = (message.tool_calls ?? []).map((call) => ({ ...call, id: call.id ?? `qualify-${++seq}` }));
      return pending.length ? { ...message, tool_calls: pending } : message;
    }
    if (message.role === 'tool') {
      const call = message.tool_call_id ? pending.find((c) => c.id === message.tool_call_id) : pending[0];
      if (!call) throw Error('Tool result has no matching assistant call');
      pending = pending.filter((c) => c !== call);
      return { ...message, tool_call_id: call.id, name: call.function.name };
    }
    return message;
  });
}
