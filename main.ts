// main.ts is mend, the CLI SPEC.md specifies: the command line, output and exit codes, safe paths, format detection,
// matching lines at three tiers (section 5), all four patch formats, and the all-or-nothing write. Node 22, the
// standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Move = { old: string; new: string };
type Edit = (tree: Tree, moves: Move[]) => void;

function trimTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimLeadTrail(s: string): string {
  return s.replace(/^[ \t]+|[ \t]+$/g, '');
}
function leadingWs(s: string): string {
  const m = s.match(/^[ \t]*/);
  return m ? m[0] : '';
}
function fileBreak(text: string): string {
  const nl = text.indexOf('\n');
  return nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
}
function fileLines(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const br = fileBreak(text);
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}
function writeFileLines(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

type MatchTier = 0 | 1 | 2;
function eqAt(a: string, b: string, tier: MatchTier): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimLeadTrail(a) === trimLeadTrail(b);
}
function findOccurrences(file: string[], o: string[], tier: MatchTier): number[] {
  if (o.length === 0) return [];
  const out: number[] = [];
  for (let i = 0; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!eqAt(file[i + j]!, o[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}
function tiersFor(strict: boolean): MatchTier[] {
  return strict ? [0] : [0, 1, 2];
}
function matchO(file: string[], o: string[], strict: boolean): { tier: MatchTier; occs: number[] } | null {
  for (const tier of tiersFor(strict)) {
    const occs = findOccurrences(file, o, tier);
    if (occs.length > 0) return { tier, occs };
  }
  return null;
}

interface NLine { text: string; ctx: boolean; }

function buildReplacement(file: string[], pos: number, o: string[], n: NLine[], tier: MatchTier, ctxOMap?: number[]): string[] {
  const out: string[] = [];
  const fLead = o.length > 0 ? leadingWs(file[pos]!) : '';
  const pLead = o.length > 0 ? leadingWs(o[0]!) : '';
  let ctxIdx = 0;
  for (const nl of n) {
    if (nl.ctx) {
      const oi = ctxOMap ? (ctxOMap[ctxIdx] ?? -1) : -1;
      if (oi >= 0 && pos + oi < file.length) out.push(file[pos + oi]!);
      else {
        // fallback: find by matching in order
        out.push(nl.text);
      }
      ctxIdx++;
    } else if (tier === 2) {
      const line = nl.text;
      if (line !== '' && !/^[ \t]*$/.test(line) && line.startsWith(pLead)) out.push(fLead + line.slice(pLead.length));
      else out.push(line);
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree, _moves) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree, _moves) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree, _moves) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseUnifiedPath(raw: string): string {
  // text after four chars up to first tab, surrounding spaces removed
  let s = raw.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s === '/dev/null') return '/dev/null';
  return stripAB(s);
}

interface UHunk {
  a: number; // A
  lines: string[]; // raw body lines including prefix char or empty; excludes header
  noNlAfter: Set<number>; // indices in lines that have \ No newline marker after them? We'll track by body line index
  // better: store parsed body entries
}

interface UBodyLine {
  kind: 'ctx' | 'del' | 'add' | 'empty-ctx';
  text: string; // content without prefix; for empty-ctx ''
  noNl: boolean; // \ after this line
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDel: boolean;
  gitOld: string | null;
  gitNew: string | null;
  hunks: { a: number; body: UBodyLine[] }[];
  headerStart: number; // 0-based line index
}

function parseDiffGit(line: string): { oldP: string; newP: string } | null {
  // diff --git a/<X> b/<Y>
  if (!line.startsWith('diff --git ')) return null;
  const rest = line.slice('diff --git '.length);
  // Find " b/" split; paths may be quoted? spec says form above; be pragmatic: split on ' b/' last? or first?
  // Common: diff --git a/foo b/foo. Also could have spaces. Try to parse by finding ' b/'.
  const idx = rest.indexOf(' b/');
  if (idx < 0) return null;
  const left = rest.slice(0, idx);
  const right = rest.slice(idx + 1); // includes b/
  if (!left.startsWith('a/')) return null;
  return { oldP: left.slice(2), newP: right.startsWith('b/') ? right.slice(2) : right };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  const n = lines.length;

  function isSectionStart(idx: number): boolean {
    const l = lines[idx]!;
    if (l.startsWith('diff --git ')) return true;
    if (l.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')) return true;
    return false;
  }

  while (i < n) {
    if (!isSectionStart(i)) {
      // A hunk (or any other @@ line) before a section is a parse error at its own line (section 6).
      if (lines[i]!.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    const sec: USection = {
      oldPath: null, newPath: null, renameFrom: null, renameTo: null,
      isNew: false, isDel: false, gitOld: null, gitNew: null, hunks: [], headerStart: i,
    };
    // consume section header
    if (lines[i]!.startsWith('diff --git ')) {
      const dg = parseDiffGit(lines[i]!);
      if (!dg) throw new Exit2(`error: parse ${i + 1}`);
      sec.gitOld = dg.oldP;
      sec.gitNew = dg.newP;
      i++;
    }
    // read header lines until hunk or next section or EOF
    while (i < n) {
      const l = lines[i]!;
      if (l.startsWith('@@')) break;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        // Could be start of next section if we already have a ---/+++ in this section? 
        // But section header may include ---/+++; if we already saw one, this is next section.
        if (sec.oldPath !== null || sec.newPath !== null) break;
      }
      // header processing
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        sec.oldPath = parseUnifiedPath(l);
        sec.newPath = parseUnifiedPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (l.startsWith('--- ') && !(lines[i + 1] ?? '').startsWith('+++ ')) {
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('rename from ')) { sec.renameFrom = l.slice('rename from '.length).trim(); i++; continue; }
      if (l.startsWith('rename to ')) { sec.renameTo = l.slice('rename to '.length).trim(); i++; continue; }
      if (l.startsWith('new file mode')) { sec.isNew = true; i++; continue; }
      if (l.startsWith('deleted file mode')) { sec.isDel = true; i++; continue; }
      // ignored: index, old mode, new mode, similarity, dissimilarity, Index:, any other line
      i++;
    }

    // resolve paths
    let oldP = sec.oldPath;
    let newP = sec.newPath;
    if (oldP === null && newP === null) {
      // Rename paths are named as the patch wrote them: only ---/+++ paths lose an a/ or b/ prefix (section 6).
      if (sec.renameFrom !== null) oldP = sec.renameFrom.trim();
      if (sec.renameTo !== null) newP = sec.renameTo.trim();
    }
    if (oldP === null && sec.gitOld !== null) oldP = sec.gitOld;
    if (newP === null && sec.gitNew !== null) newP = sec.gitNew;
    // if only one side known from git in weird case, mirror
    if (oldP === null && newP !== null) oldP = newP;
    if (newP === null && oldP !== null) newP = oldP;

    // A deletion deletes the file without reading its hunks (section 6).
    if (sec.isDel || newP === '/dev/null') {
      while (i < n && !isSectionStart(i)) i++;
      edits.push(buildUnifiedEdit(sec, oldP, newP, strict));
      continue;
    }

    // parse hunks
    while (i < n) {
      const l = lines[i]!;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (l.startsWith('@@')) {
        const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (!m) throw new Exit2(`error: parse ${i + 1}`);
        const a = parseInt(m[1]!, 10);
        i++;
        const body: UBodyLine[] = [];
        while (i < n) {
          const bl = lines[i]!;
          if (bl.startsWith('diff --git ')) break;
          if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
          if (bl.startsWith('@@')) break;
          if (bl.startsWith(' ')) { body.push({ kind: 'ctx', text: bl.slice(1), noNl: false }); i++; continue; }
          if (bl.startsWith('-')) { body.push({ kind: 'del', text: bl.slice(1), noNl: false }); i++; continue; }
          if (bl.startsWith('+')) { body.push({ kind: 'add', text: bl.slice(1), noNl: false }); i++; continue; }
          if (bl.startsWith('\\')) {
            // \ No newline at end of file - attach to previous body line
            if (body.length > 0) body[body.length - 1]!.noNl = true;
            i++;
            continue;
          }
          if (bl === '') { body.push({ kind: 'empty-ctx', text: '', noNl: false }); i++; continue; }
          // any other line ends body (prose/fences outside body)
          break;
        }
        // Trim empty context lines at the end of a body, but not one that a \ line belongs to: that line is still
        // followed by a body line, so the pair is part of the body (section 6).
        while (body.length > 0 && body[body.length - 1]!.kind === 'empty-ctx' && !body[body.length - 1]!.noNl) body.pop();
        sec.hunks.push({ a, body });
        continue;
      }
      // outside bodies: lines not part of section header ignored (prose, code fences)
      i++;
    }

    edits.push(buildUnifiedEdit(sec, oldP, newP, strict));
  }

  return edits;
}

function buildUnifiedEdit(sec: USection, oldP: string | null, newP: string | null, strict: boolean): Edit {
  const isCreate = sec.isNew || oldP === '/dev/null';
  const isDelete = sec.isDel || newP === '/dev/null';
  const realOld = oldP === '/dev/null' ? null : oldP;
  const realNew = newP === '/dev/null' ? null : newP;
  const targetOld = realOld ?? realNew;
  const targetNew = realNew ?? realOld;
  // Both sides /dev/null names no file: the reader found no edit (section 2). Report this while parsing, before
  // any file is looked at, not while the edit is applied.
  if (targetOld === null || targetNew === null) throw new Exit2('error: parse 1');

  return (tree: Tree, moves: Move[]) => {
    // Name the path that was checked, as the patch wrote it (after --- / +++ prefix removal), never /dev/null.
    if (!safe(targetOld)) throw new Fail('unsafe', realOld ?? targetOld);
    if (!safe(targetNew)) throw new Fail('unsafe', realNew ?? targetNew);

    if (isCreate) {
      if (tree.get(targetNew) !== null) throw new Fail('exists', targetNew);
      const outLines: string[] = [];
      let lastPlus: UBodyLine | null = null;
      for (const h of sec.hunks) {
        for (const b of h.body) {
          if (b.kind === 'add') { outLines.push(b.text); lastPlus = b; }
        }
      }
      let final = true;
      if (lastPlus && lastPlus.noNl) final = false;
      if (outLines.length === 0) { tree.now.set(targetNew, ''); return; }
      tree.now.set(targetNew, outLines.join('\n') + (final ? '\n' : ''));
      return;
    }

    if (isDelete) {
      if (tree.get(targetOld) === null) throw new Fail('missing', targetOld);
      tree.now.set(targetOld, null);
      return;
    }

    // change or move
    const isMove = targetOld !== targetNew;
    const src = isMove ? targetOld : targetOld;
    const before = tree.get(src);
    if (before === null) throw new Fail('missing', src);
    if (isMove) {
      if (tree.get(targetNew) !== null) throw new Fail('exists', targetNew);
    }

    const fl = fileLines(before);
    let linesArr = fl.lines.slice();
    let final = fl.final;
    const br = fl.br;
    let d = 0;

    for (const h of sec.hunks) {
      const o: string[] = [];
      const n: NLine[] = [];
      for (const b of h.body) {
        if (b.kind === 'ctx' || b.kind === 'empty-ctx') {
          o.push(b.text);
          n.push({ text: b.text, ctx: true });
        } else if (b.kind === 'del') {
          o.push(b.text);
        } else if (b.kind === 'add') {
          n.push({ text: b.text, ctx: false });
        }
      }

      if (o.length === 0) {
        // insertion: after first A+d lines
        const pos = Math.max(0, Math.min(linesArr.length, h.a + d));
        // determine final break behavior for insertion at EOF
        const atEnd = pos === linesArr.length;
        const repl = n.map(x => x.text); // no ctx in empty-O insertion
        // tier 2 re-indent not applicable when O empty? spec says "at tier 2..." but O empty means no matched lines; P/F undefined.
        // Apply as-is.
        linesArr.splice(pos, 0, ...repl);
        // end-of-file newline rule
        if (atEnd) {
          // insertion at end: result ends with line break unless \ follows hunk's last context or + line
          let lastCtxOrAdd: UBodyLine | null = null;
          for (const b of h.body) if (b.kind === 'ctx' || b.kind === 'empty-ctx' || b.kind === 'add') lastCtxOrAdd = b;
          if (lastCtxOrAdd && lastCtxOrAdd.noNl) final = false;
          else final = true; // inserting at end creates content; default final break
          if (linesArr.length === 0) final = false;
        }
        d += n.length;
        continue;
      }

      const m = matchO(linesArr, o, strict);
      if (!m) throw new Fail('no-match', src);
      const target = h.a - 1 + d;
      // Context mapping is structural: walk body in order, ctx lines correspond to same-position ctx in O and N.
      const ctxOMap: number[] = [];
      {
        let oi = 0;
        for (const b of h.body) {
          if (b.kind === 'ctx' || b.kind === 'empty-ctx') { ctxOMap.push(oi); oi++; }
          else if (b.kind === 'del') { oi++; }
        }
      }
      let best = m.occs[0]!;
      let bestDist = Math.abs(best - target);
      for (const occ of m.occs) {
        const dist = Math.abs(occ - target);
        if (dist < bestDist || (dist === bestDist && occ < best)) { best = occ; bestDist = dist; }
      }
      const repl = buildReplacement(linesArr, best, o, n, m.tier, ctxOMap);
      const atEnd = best + o.length === linesArr.length;
      // apply replacement
      linesArr.splice(best, o.length, ...repl);

      if (atEnd) {
        // matched lines run to end of file
        let lastCtxOrAdd: UBodyLine | null = null;
        for (const b of h.body) if (b.kind === 'ctx' || b.kind === 'empty-ctx' || b.kind === 'add') lastCtxOrAdd = b;
        if (lastCtxOrAdd && lastCtxOrAdd.noNl) final = false;
        else {
          // "result ends with a line break unless..." so if no \, ends with line break
          final = true;
        }
        if (linesArr.length === 0) final = false;
      }
      // if not at end, file's final break stays as it was

      d += n.length - o.length;
    }

    const outText = writeFileLines(linesArr, br, final);
    if (isMove) {
      tree.now.set(targetOld, null);
      tree.now.set(targetNew, outText);
      moves.push({ old: targetOld, new: targetNew });
    } else {
      tree.now.set(targetOld, outText);
    }
  };
}

// ---------- section 7: SEARCH/REPLACE ----------

const SEARCH_MARK = '<<<<<<< SEARCH';
const SEP_MARK = '=======';
const REPLACE_MARK = '>>>>>>> REPLACE';

/** One SEARCH/REPLACE block (SPEC.md section 7): a create, or a one-occurrence replace. */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree, _moves) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, writeFileLines(newLines, '\n', true));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const fl = fileLines(before);
    const m = matchO(fl.lines, oldLines, strict);
    if (!m) throw new Fail('no-match', path);
    if (m.occs.length !== 1) throw new Fail('ambiguous', path);
    const pos = m.occs[0]!;
    const repl = buildReplacement(fl.lines, pos, oldLines, newLines.map((t) => ({ text: t, ctx: false })), m.tier);
    const out = fl.lines.slice();
    out.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, writeFileLines(out, fl.br, fl.final));
  };
}

/** Read all SEARCH/REPLACE blocks in patch order, or throw the parse error their section names. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let prevPath: string | null = null;
  let afterReplace = 0; // first line after the previous block's REPLACE marker
  while (i < n) {
    let s = i;
    while (s < n && lines[s]!.trimEnd() !== SEARCH_MARK) s++;
    if (s >= n) break;

    // The path is the nearest preceding non-blank, non-fence line of this block's preamble.
    let path: string | null = null;
    for (let j = s - 1; j >= afterReplace; j--) {
      const l = lines[j]!;
      if (!blank(l) && !l.trim().startsWith('```')) { path = l.trim(); break; }
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);

    let sep = s + 1;
    while (sep < n && lines[sep]!.trimEnd() !== SEP_MARK) sep++;
    if (sep >= n) throw new Exit2(`error: parse ${s + 1}`);
    let rep = sep + 1;
    while (rep < n && lines[rep]!.trimEnd() !== REPLACE_MARK) rep++;
    if (rep >= n) throw new Exit2(`error: parse ${s + 1}`);

    edits.push(searchReplaceEdit(path, lines.slice(s + 1, sep), lines.slice(sep + 1, rep), strict));
    prevPath = path;
    afterReplace = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---------- section 8: V4A patches ----------

type VKind = 'ctx' | 'del' | 'add' | 'empty-ctx';
interface VBodyLine { kind: VKind; text: string; line: number; }
interface VChunk { anchor: string | null; body: VBodyLine[]; eof: boolean; }

interface RawLine { text: string; line: number; }

const ADD_HEAD = '*** Add File: ';
const DEL_HEAD = '*** Delete File: ';
const UPD_HEAD = '*** Update File: ';
const MOVE_HEAD = '*** Move to:';
const EOF_MARK = '*** End of File';
const END_MARK = '*** End Patch';

function isSectionHead(s: string): boolean {
  return s.startsWith(ADD_HEAD) || s.startsWith(DEL_HEAD) || s.startsWith(UPD_HEAD);
}

/** Collect a section's raw lines, stopping at the next section or the final End Patch. */
function v4aBody(lines: string[], start: number, last: number): { body: RawLine[]; end: number } {
  const body: RawLine[] = [];
  let i = start;
  for (; i < last && !isSectionHead(lines[i]!); i++) body.push({ text: lines[i]!, line: i });
  while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();
  return { body, end: i };
}

function v4aAddEdit(path: string, fileLinesOut: string[]): Edit {
  return (tree, _moves) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, writeFileLines(fileLinesOut, '\n', true));
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree, _moves) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree, moves) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);

    const fl = fileLines(before);
    const cur = fl.lines.slice();
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        let at = -1;
        for (const tier of tiersFor(strict)) {
          for (let i = cursor; i < cur.length; i++) {
            if (eqAt(cur[i]!, chunk.anchor, tier)) { at = i; break; }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }

      const o: string[] = [];
      const n: NLine[] = [];
      const ctxOMap: number[] = [];
      {
        let oi = 0;
        for (const b of chunk.body) {
          if (b.kind === 'ctx' || b.kind === 'empty-ctx') {
            o.push(b.text);
            n.push({ text: b.text, ctx: true });
            ctxOMap.push(oi);
            oi++;
          } else if (b.kind === 'del') {
            o.push(b.text);
            oi++;
          } else {
            n.push({ text: b.text, ctx: false });
          }
        }
      }

      if (o.length === 0) {
        const pos = chunk.eof ? cur.length : Math.min(cursor, cur.length);
        const repl = n.map((x) => x.text);
        cur.splice(pos, 0, ...repl);
        cursor = pos + repl.length;
        continue;
      }

      let pos = -1;
      let tierFound: MatchTier = 0;
      for (const tier of tiersFor(strict)) {
        for (let i = Math.min(cursor, cur.length); i + o.length <= cur.length; i++) {
          if (chunk.eof && i + o.length !== cur.length) continue;
          let ok = true;
          for (let j = 0; j < o.length; j++) {
            if (!eqAt(cur[i + j]!, o[j]!, tier)) { ok = false; break; }
          }
          if (ok) { pos = i; tierFound = tier; break; }
        }
        if (pos >= 0) break;
      }
      if (pos < 0) throw new Fail('no-match', path);

      const repl = buildReplacement(cur, pos, o, n, tierFound, ctxOMap);
      cur.splice(pos, o.length, ...repl);
      cursor = pos + repl.length;
    }

    const out = writeFileLines(cur, fl.br, fl.final);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

/** Read a V4A patch, or throw the parse error its section names. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') {
    throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  }
  let last = n - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== END_MARK) throw new Exit2(`error: parse ${n + 1}`);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) { i++; continue; }
    const head = lines[i]!;
    const headLine = i + 1;
    const path = head.slice(head.indexOf(':') + 1).trim();
    const sect = v4aBody(lines, i + 1, last);
    const raw = sect.body;
    i = sect.end;

    if (head.startsWith(ADD_HEAD)) {
      const fileLinesOut = raw.map((r) => (r.text.startsWith('+') ? r.text.slice(1) : r.text));
      for (const r of raw) {
        if (!r.text.startsWith('+') && !blank(r.text)) throw new Exit2(`error: parse ${r.line + 1}`);
      }
      edits.push(v4aAddEdit(path, fileLinesOut));
      continue;
    }
    if (head.startsWith(DEL_HEAD)) {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.line + 1}`);
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (head.startsWith(UPD_HEAD)) {
      let k = 0;
      let moveTo: string | null = null;
      if (raw.length > 0 && raw[0]!.text.startsWith(MOVE_HEAD)) {
        moveTo = raw[0]!.text.slice(MOVE_HEAD.length).trim();
        k = 1;
      }
      const chunks: VChunk[] = [];
      let current: VChunk | null = null;
      for (; k < raw.length; k++) {
        const { text, line } = raw[k]!;
        if (text.startsWith('@@')) {
          current = { anchor: text.slice(2).trim() || null, body: [], eof: false };
          chunks.push(current);
          continue;
        }
        if (text === EOF_MARK) {
          if (current === null) throw new Exit2(`error: parse ${line + 1}`);
          current.eof = true;
          current = null;
          continue;
        }
        if (blank(text)) {
          if (current === null) {
            if (chunks.length === 0) { current = { anchor: null, body: [], eof: false }; chunks.push(current); }
            continue; // blank after an End of File chunk is not part of a chunk
          }
          current.body.push({ kind: 'empty-ctx', text: '', line });
          continue;
        }
        const c = text[0]!;
        if (c === ' ' || c === '-' || c === '+') {
          if (current === null) {
            if (chunks.length !== 0) throw new Exit2(`error: parse ${line + 1}`);
            current = { anchor: null, body: [], eof: false };
            chunks.push(current);
          }
          current.body.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'del' : 'add', text: text.slice(1), line });
          continue;
        }
        throw new Exit2(`error: parse ${line + 1}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${headLine}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else if (kind === 'v4a') edits = v4aEdits(lines, strict);
    else edits = [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: Move[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };

  const movedOld = new Set<string>();
  const movedNew = new Map<string, string>();
  for (const m of moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.now.has(m.old) ? tree.now.get(m.old)! : wasOld;
    const wasNew = tree.original(m.new);
    const nowNew = tree.now.has(m.new) ? tree.now.get(m.new)! : wasNew;
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      movedOld.add(m.old);
      movedNew.set(m.new, m.old);
    }
  }

  type Row = { sortKey: string; line: string; action: 'A'|'D'|'M'|'R'; path: string; oldPath?: string };
  const rowItems: Row[] = [];
  const changedPaths = new Set<string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changedPaths.add(p);
  }
  for (const p of changedPaths) {
    if (movedOld.has(p)) continue;
    if (movedNew.has(p)) {
      const oldP = movedNew.get(p)!;
      rowItems.push({ sortKey: p, line: `R ${oldP} -> ${p}`, action: 'R', path: p, oldPath: oldP });
      continue;
    }
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rowItems.push({ sortKey: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, action: was === null ? 'A' : now === null ? 'D' : 'M', path: p });
  }
  rowItems.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey), Buffer.from(b.sortKey)));
  if (!check) {
    for (const r of rowItems) {
      if (r.action === 'R') {
        rmSync(r.oldPath!, { force: true });
        const now = tree.now.get(r.path)!;
        mkdirSync(dirname(r.path), { recursive: true });
        writeFileSync(r.path, now);
      } else if (r.action === 'D') {
        rmSync(r.path, { force: true });
      } else {
        const now = tree.now.get(r.path)!;
        mkdirSync(dirname(r.path), { recursive: true });
        writeFileSync(r.path, now);
      }
    }
  }
  return { code: 0, out: [...rowItems.map(r => r.line), `ok: ${rowItems.length} ${rowItems.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
