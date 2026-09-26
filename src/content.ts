import type { DocComponent, DocPage, DocsSearchResult } from './types.js';

const SUMMARY_LENGTH = 160;
const EXCERPT_LENGTH = 180;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const LIST_ITEM = /^( {0,3}(?:[-+*]|\d{1,9}[.)]))([ \t]+)/;
const NORMALIZATION_CHUNK = 512;
// NFKC never joins these characters to what precedes them, so chunks split before them.
const NORMALIZATION_BOUNDARY = /[ -~\u4e00-\u9fff]/g;

interface ParsedSource {
  body: string;
  frontmatter: string;
}

interface MarkdownFence {
  length: number;
  listIndent: number;
  marker: '`' | '~';
  quoteDepth: number;
}

interface FenceTransition {
  delimiter: boolean;
  fence: MarkdownFence | undefined;
}

const COMPONENT_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  Band: ['alt', 'source'],
  Figure: ['alt', 'caption', 'date', 'source'],
  LinkCard: ['title', 'desc', 'alt'],
  PageHero: ['title', 'lede', 'alt', 'source'],
  Split: ['heading', 'alt'],
  TimelineEntry: ['year', 'title'],
};

function splitFrontmatter(content: string): ParsedSource {
  const source = content.startsWith('\uFEFF') ? content.slice(1) : content;
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match) return { body: source, frontmatter: '' };
  return {
    body: source.slice(match[0].length),
    frontmatter: match[1] ?? '',
  };
}

function decodeScalar(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '|' || trimmed === '>' || trimmed === '~' || trimmed === 'null') {
    return undefined;
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === 'string' ? parsed : undefined;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function frontmatterValue(frontmatter: string, key: string): string | undefined {
  for (const line of frontmatter.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) continue;
    const separator = line.indexOf(':');
    if (separator < 0 || line.slice(0, separator).trim() !== key) continue;
    return decodeScalar(line.slice(separator + 1));
  }
  return undefined;
}

function cleanInline(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function quoteContainer(line: string): { depth: number; rest: string } {
  let depth = 0;
  let rest = line;
  for (;;) {
    const prefix = /^ {0,3}>[ \t]?/.exec(rest)?.[0];
    if (!prefix) return { depth, rest };
    depth += 1;
    rest = rest.slice(prefix.length);
  }
}

function transitionFence(line: string, current: MarkdownFence | undefined): FenceTransition {
  const quote = quoteContainer(line);
  let candidate = quote.rest;
  let listIndent = 0;
  if (current) {
    if (quote.depth < current.quoteDepth) return transitionFence(line, undefined);
    if (quote.depth !== current.quoteDepth) return { delimiter: false, fence: current };
    if (current.listIndent > 0) {
      const indentation = /^ */.exec(candidate)?.[0].length ?? 0;
      if (candidate.trim() !== '' && indentation < current.listIndent) {
        return transitionFence(line, undefined);
      }
      candidate = candidate.slice(Math.min(indentation, current.listIndent));
    }
  } else {
    listIndent = LIST_ITEM.exec(candidate)?.[0].length ?? 0;
    candidate = candidate.slice(listIndent);
  }
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(candidate);
  const sequence = match?.[1];
  if (!sequence) return { delimiter: false, fence: current };
  const marker = sequence.startsWith('`') ? '`' : '~';
  const suffix = match[2] ?? '';

  if (!current) {
    if (marker === '`' && suffix.includes('`')) {
      return { delimiter: false, fence: undefined };
    }
    return {
      delimiter: true,
      fence: { length: sequence.length, listIndent, marker, quoteDepth: quote.depth },
    };
  }

  if (marker === current.marker && sequence.length >= current.length && /^[ \t]*$/.test(suffix)) {
    return { delimiter: true, fence: undefined };
  }
  return { delimiter: false, fence: current };
}

function indentWidth(line: string): number {
  let width = 0;
  for (const character of line) {
    if (character === ' ') width += 1;
    else if (character === '\t') width += 4 - (width % 4);
    else break;
  }
  return width;
}

function proseLines(body: string): (string | undefined)[] {
  let fence: MarkdownFence | undefined;
  let afterBreak = true;
  let inCode = false;
  let listIndent = 0;
  return body.split(/\r?\n/).map((line) => {
    const transition = transitionFence(line, fence);
    fence = transition.fence;
    if (transition.delimiter || fence) {
      afterBreak = true;
      inCode = false;
      return undefined;
    }
    const candidate = quoteContainer(line).rest;
    if (candidate.trim() === '') {
      afterBreak = true;
      return line;
    }
    const width = indentWidth(candidate);
    if (afterBreak && width < listIndent) listIndent = 0;
    inCode = width - listIndent >= 4 && (afterBreak || inCode);
    afterBreak = false;
    if (inCode) return undefined;
    const item = LIST_ITEM.exec(candidate);
    if (!item) return line;
    const marker = item[1]?.length ?? 0;
    const padding = item[2] ?? '';
    const rest = candidate.slice(item[0].length);
    if (padding.includes('\t') || padding.length >= 5 || /^(?: {4}|\t)/.test(rest)) {
      listIndent = marker + 1;
      inCode = true;
      return undefined;
    }
    listIndent = marker + padding.length;
    return line;
  });
}

function extractTitle(body: string): string | undefined {
  for (const line of proseLines(body)) {
    if (line === undefined) continue;
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match?.[1]) return cleanInline(match[1].replace(/\s+#+\s*$/, ''));
  }
  return undefined;
}

function truncate(value: string, length: number): string {
  const characters: string[] = [];
  for (const character of value) characters.push(character);
  if (characters.length <= length) return value;
  return `${characters.slice(0, length).join('').trimEnd()}…`;
}

function extractSummary(body: string): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  let inContainer = false;
  let inTag = false;
  let hiddenTag: 'script' | 'style' | undefined;

  const finishParagraph = () => {
    if (current.length > 0) paragraphs.push(current.join(' '));
    current = [];
  };

  for (const rawLine of proseLines(body)) {
    if (rawLine === undefined) {
      finishParagraph();
      continue;
    }
    const line = rawLine.trim();
    if (hiddenTag) {
      if (line.toLowerCase().includes(`</${hiddenTag}>`)) hiddenTag = undefined;
      continue;
    }
    const hiddenStart = /^<(script|style)(?:\s|>)/i.exec(line)?.[1]?.toLowerCase();
    if (hiddenStart === 'script' || hiddenStart === 'style') {
      hiddenTag = line.toLowerCase().includes(`</${hiddenStart}>`) ? undefined : hiddenStart;
      finishParagraph();
      continue;
    }
    if (line.startsWith(':::')) {
      inContainer = !inContainer;
      finishParagraph();
      continue;
    }
    if (inContainer) continue;
    if (inTag) {
      if (line.endsWith('>')) inTag = false;
      continue;
    }
    if (line.startsWith('<')) {
      if (!line.endsWith('>')) inTag = true;
      finishParagraph();
      continue;
    }
    if (line === '') {
      finishParagraph();
      if (paragraphs.length > 0) break;
      continue;
    }
    if (/^(?:#{1,6}\s|>|\||[-*+]\s|\d+[.)]\s|(?:-{3,}|\*{3,}|_{3,})$)/.test(line)) {
      finishParagraph();
      continue;
    }
    current.push(line);
  }
  finishParagraph();
  return truncate(cleanInline(paragraphs[0] ?? ''), SUMMARY_LENGTH);
}

function markdownText(body: string): string {
  return cleanInline(
    body
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(?:script|style)(?:\s[^>]*)?>[\s\S]*?<\/(?:script|style)>/gi, ' ')
      .replace(/<[A-Z][A-Za-z\d]*(?:\s[^>]*)?\s*\/\s*>/g, ' ')
      .replace(/<\/?[A-Z][A-Za-z\d]*(?:\s[^>]*)?>/g, ' ')
      .replace(/^---\s*$/gm, ' ')
      .replace(/^:::[^\n]*$/gm, ' ')
      .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, ''),
  );
}

function parseAttributes(source: string): Readonly<Record<string, string | true>> {
  const attributes: Record<string, string | true> = {};
  const pattern = /([:@A-Za-z_][:@\w.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    if (!name) continue;
    attributes[name] = match[2] ?? match[3] ?? match[4] ?? true;
  }
  return attributes;
}

function componentSource(body: string): string {
  return proseLines(body)
    .filter((line) => line !== undefined)
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

function extractComponents(body: string): DocComponent[] {
  const components: DocComponent[] = [];
  const pattern = /<([A-Z][A-Za-z\d]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)\/?\s*>/g;
  for (const match of componentSource(body).matchAll(pattern)) {
    const name = match[1];
    if (!name) continue;
    components.push({ attributes: parseAttributes(match[2] ?? ''), name });
  }
  return components;
}

function componentText(components: readonly DocComponent[]): string {
  const values: string[] = [];
  for (const component of components) {
    if (component.name === 'FactStrip') {
      const facts = component.attributes[':facts'];
      if (typeof facts === 'string') {
        for (const match of facts.matchAll(/\b(?:label|value)\s*:\s*(['"])(.*?)\1/gs)) {
          if (match[2]) values.push(match[2].replace(/\\(['"\\])/g, '$1'));
        }
      }
    }
    for (const name of COMPONENT_ATTRIBUTES[component.name] ?? []) {
      const value = component.attributes[name];
      if (typeof value === 'string') values.push(value);
    }
  }
  return values.join(' ');
}

function routeFromPath(path: string): string {
  const withoutExtension = path.replace(/\.md$/i, '');
  if (withoutExtension === 'index') return '/';
  if (withoutExtension.endsWith('/index')) return `/${withoutExtension.slice(0, -5)}`;
  return `/${withoutExtension}`;
}

function fallbackTitle(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.replace(/\.md$/i, '');
}

export function parseDoc(path: string, content: string): DocPage {
  const { body, frontmatter } = splitFrontmatter(content);
  const components = extractComponents(body);
  const hero = components.find((component) => component.name === 'PageHero');
  const heroTitle = hero?.attributes.title;
  const heroSummary = hero?.attributes.lede;
  const name = path.slice(path.lastIndexOf('/') + 1);
  const title = cleanInline(
    extractTitle(body) ??
      frontmatterValue(frontmatter, 'title') ??
      (typeof heroTitle === 'string' ? heroTitle : ''),
  );
  const summary = cleanInline(
    frontmatterValue(frontmatter, 'summary') ??
      (typeof heroSummary === 'string' ? heroSummary : extractSummary(body)),
  );
  return {
    components,
    content,
    name,
    path,
    route: routeFromPath(path),
    section: path.includes('/') ? (path.split('/')[0] ?? null) : null,
    summary: truncate(summary, SUMMARY_LENGTH),
    title: title || fallbackTitle(path),
  };
}

function normalize(value: string): string {
  // Lowercasing keeps final sigma (ς) where a search for Σ yields σ.
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\u03c2/g, '\u03c3');
}

interface NormalizedText {
  offsets: number[];
  sources: number[];
  value: string;
}

interface Grapheme {
  codePoints: number;
  end: number;
  start: number;
}

function normalizeChunks(text: string): NormalizedText {
  const offsets: number[] = [];
  const sources: number[] = [];
  const parts: string[] = [];
  let length = 0;
  for (let start = 0; start < text.length;) {
    NORMALIZATION_BOUNDARY.lastIndex = start + NORMALIZATION_CHUNK;
    const end = NORMALIZATION_BOUNDARY.exec(text)?.index ?? text.length;
    const part = normalize(text.slice(start, end));
    offsets.push(length);
    sources.push(start);
    parts.push(part);
    length += part.length;
    start = end;
  }
  return { offsets, sources, value: parts.join('') };
}

function lastIndexAtMost(count: number, target: number, valueAt: (index: number) => number) {
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (valueAt(middle) <= target) low = middle;
    else high = middle - 1;
  }
  return low;
}

function graphemeAt(graphemes: Intl.Segments, position: number): Grapheme {
  const part = graphemes.containing(position);
  if (!part) return { codePoints: 0, end: position, start: position };
  return {
    codePoints: Array.from(part.segment).length,
    end: part.index + part.segment.length,
    start: part.index,
  };
}

function normalizedLength(text: string, normalized: NormalizedText, position: number): number {
  const { offsets, sources } = normalized;
  const chunk = lastIndexAtMost(sources.length, position, (index) => sources[index] ?? 0);
  const start = sources[chunk] ?? 0;
  return (offsets[chunk] ?? 0) + normalize(text.slice(start, position)).length;
}

function sourceBoundary(
  text: string,
  normalized: NormalizedText,
  graphemes: Intl.Segments,
  offset: number,
): { length: number; position: number } {
  const { offsets, sources } = normalized;
  const chunk = lastIndexAtMost(offsets.length, offset, (index) => offsets[index] ?? 0);
  const chunkEnd = sources[chunk + 1] ?? text.length;
  const boundaries = [graphemeAt(graphemes, sources[chunk] ?? 0).start];
  for (let position = boundaries[0] ?? 0; position < chunkEnd;) {
    position = graphemeAt(graphemes, position).end;
    boundaries.push(position);
  }
  const lengths = new Map<number, number>();
  const lengthAt = (index: number): number => {
    const position = boundaries[index] ?? 0;
    const length = lengths.get(position) ?? normalizedLength(text, normalized, position);
    lengths.set(position, length);
    return length;
  };
  const index = lastIndexAtMost(boundaries.length, offset, lengthAt);
  return { length: lengthAt(index), position: boundaries[index] ?? 0 };
}

function countMatches(value: string, term: string): number {
  let count = 0;
  let offset = 0;
  while (offset < value.length) {
    const index = value.indexOf(term, offset);
    if (index < 0) break;
    count += 1;
    offset = index + Math.max(term.length, 1);
  }
  return count;
}

function excerpt(text: string, query: string, terms: string[]): string {
  if (!text) return '';
  const normalized = normalizeChunks(text);
  const exactIndex = normalized.value.indexOf(query);
  let matchIndex = exactIndex;
  let matchLength = query.length;
  if (matchIndex < 0) {
    matchIndex = Number.POSITIVE_INFINITY;
    for (const term of terms) {
      const index = normalized.value.indexOf(term);
      if (index >= 0 && index < matchIndex) {
        matchIndex = index;
        matchLength = term.length;
      }
    }
  }
  if (!Number.isFinite(matchIndex)) return truncate(text, EXCERPT_LENGTH);

  const graphemes = GRAPHEME_SEGMENTER.segment(text);
  const matchStart = sourceBoundary(text, normalized, graphemes, matchIndex).position;
  const endOffset = Math.min(normalized.value.length, matchIndex + matchLength);
  const floor = sourceBoundary(text, normalized, graphemes, endOffset);
  const matchEnd =
    floor.length < endOffset ? graphemeAt(graphemes, floor.position).end : floor.position;
  const matchCodePoints = Array.from(text.slice(matchStart, matchEnd)).length;

  const contextLimit = Math.min(
    Math.floor(EXCERPT_LENGTH / 3),
    Math.max(0, EXCERPT_LENGTH - matchCodePoints),
  );
  let start = matchStart;
  let contextCodePoints = 0;
  while (start > 0) {
    const previous = graphemeAt(graphemes, start - 1);
    if (contextCodePoints + previous.codePoints > contextLimit) break;
    contextCodePoints += previous.codePoints;
    start = previous.start;
  }
  let end = start;
  let selectedCodePoints = 0;
  while (end < text.length) {
    const next = graphemeAt(graphemes, end);
    if (end > start && selectedCodePoints + next.codePoints > EXCERPT_LENGTH) break;
    selectedCodePoints += next.codePoints;
    end = next.end;
  }
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

export function searchDoc(page: DocPage, query: string): DocsSearchResult | null {
  const normalizedQuery = normalize(query.trim());
  if (!normalizedQuery) throw new TypeError('query must not be empty');
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);
  const componentValue = componentText(page.components);
  const bodyValue = markdownText(splitFrontmatter(page.content).body);
  const textValue = `${componentValue} ${bodyValue}`.trim();
  const title = normalize(page.title);
  const summary = normalize(page.summary);
  const path = normalize(page.path.replace(/[-_/]+/g, ' '));
  const components = normalize(componentValue);
  const text = normalize(bodyValue);
  const combined = `${title}\n${summary}\n${path}\n${components}\n${text}`;
  if (!terms.every((term) => combined.includes(term))) return null;

  let score = title === normalizedQuery ? 240 : 0;
  score += countMatches(title, normalizedQuery) * 80;
  score += countMatches(summary, normalizedQuery) * 40;
  score += countMatches(components, normalizedQuery) * 60;
  score += countMatches(path, normalizedQuery) * 24;
  score += Math.min(countMatches(text, normalizedQuery), 5) * 10;
  for (const term of terms) {
    score += countMatches(title, term) * 24;
    score += countMatches(summary, term) * 12;
    score += countMatches(components, term) * 18;
    score += countMatches(path, term) * 8;
    score += Math.min(countMatches(text, term), 5) * 3;
  }

  return {
    excerpt: excerpt(textValue, normalizedQuery, terms),
    name: page.name,
    path: page.path,
    route: page.route,
    score,
    section: page.section,
    summary: page.summary,
    title: page.title,
  };
}
