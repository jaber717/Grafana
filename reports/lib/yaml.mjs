// Minimal YAML reader for the report configuration (the repository ships no npm dependencies).
// Supported subset: comments (#), nested mappings by indentation, block sequences ("- item", "- key: value" with following keys),
// inline sequences [a, b], scalars: "double" / 'single' quoted strings, numbers, true/false, null/~, plain strings.
// NOT supported (rejected with an error, never guessed): anchors/aliases, multi-line scalars, tabs for indentation, flow mappings {…}.

export function parseYaml(text) {
  const lines = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (/^\t/.test(raw.match(/^\s*/)[0])) throw new Error(`yaml line ${i + 1}: tabs are not allowed for indentation`);
    const body = stripComment(raw);
    if (!body.trim()) return;
    lines.push({ n: i + 1, indent: body.match(/^ */)[0].length, text: body.trim() });
  });
  if (!lines.length) return null;
  const [value, next] = block(lines, 0, lines[0].indent);
  if (next < lines.length) throw new Error(`yaml line ${lines[next].n}: unexpected indentation`);
  return value;
}

function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function block(lines, at, indent) {
  return lines[at].text.startsWith('- ') || lines[at].text === '-' ? sequence(lines, at, indent) : mapping(lines, at, indent);
}

function sequence(lines, at, indent) {
  const out = [];
  let i = at;
  while (i < lines.length && lines[i].indent === indent && (lines[i].text.startsWith('- ') || lines[i].text === '-')) {
    const rest = lines[i].text.slice(1).trim();
    if (!rest) {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) { const [v, n] = block(lines, i + 1, lines[i + 1].indent); out.push(v); i = n; } else { out.push(null); i++; }
    } else if (/^[^"'\[{]*?:(\s|$)/.test(rest) || /^["'][^"']*["']\s*:(\s|$)/.test(rest)) {
      // "- key: value": re-read as a mapping whose first line sits two columns right of the dash
      const inner = { n: lines[i].n, indent: indent + 2, text: rest };
      const sub = [inner];
      let j = i + 1;
      while (j < lines.length && lines[j].indent > indent) { sub.push(lines[j]); j++; }
      const [v] = mapping(sub, 0, indent + 2);
      out.push(v);
      i = j;
    } else { out.push(scalar(rest, lines[i].n)); i++; }
  }
  return [out, i];
}

function mapping(lines, at, indent) {
  const out = {};
  let i = at;
  while (i < lines.length && lines[i].indent === indent) {
    const m = lines[i].text.match(/^("[^"]*"|'[^']*'|[^:]+?)\s*:(?:\s+(.*))?$/);
    if (!m) throw new Error(`yaml line ${lines[i].n}: expected "key: value"`);
    const key = unquote(m[1]);
    const rest = m[2];
    if (key in out) throw new Error(`yaml line ${lines[i].n}: duplicate key "${key}"`);
    if (rest === undefined || rest === '') {
      if (i + 1 < lines.length && (lines[i + 1].indent > indent || (lines[i + 1].indent === indent && lines[i + 1].text.startsWith('- ')))) {
        const [v, n] = block(lines, i + 1, lines[i + 1].indent);
        out[key] = v; i = n;
      } else { out[key] = null; i++; }
    } else { out[key] = scalar(rest, lines[i].n); i++; }
  }
  if (i < lines.length && lines[i].indent > indent) throw new Error(`yaml line ${lines[i].n}: unexpected indentation`);
  return [out, i];
}

function unquote(s) {
  return /^(".*"|'.*')$/.test(s) ? s.slice(1, -1) : s;
}

function scalar(s, n) {
  if (s.startsWith('&') || s.startsWith('*') || s.startsWith('|') || s.startsWith('>') || s.startsWith('{')) throw new Error(`yaml line ${n}: unsupported syntax "${s[0]}"`);
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new Error(`yaml line ${n}: unterminated inline list`);
    const inner = s.slice(1, -1).trim();
    return inner ? inner.split(',').map((x) => scalar(x.trim(), n)) : [];
  }
  if (/^".*"$/.test(s)) return s.slice(1, -1);
  if (/^'.*'$/.test(s)) return s.slice(1, -1);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}
