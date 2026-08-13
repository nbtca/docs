import type { DocComponent, DocPage, DocsSearchResult } from './types.js';

const SUMMARY_LENGTH = 160;
const EXCERPT_LENGTH = 180;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

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
    const listPrefix = /^ {0,3}(?:(?:[-+*]|\d{1,9}[.)]))[ \t]+/.exec(candidate)?.[0] ?? '';
    listIndent = listPrefix.length;
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

function isIndentedCodeLine(line: string): boolean {
  const candidate = quoteContainer(line).rest;
  if (/^(?: {4}|\t)/.test(candidate)) return true;
  const list = /^ {0,3}(?:[-+*]|\d{1,9}[.)])([ \t]+)(.*)$/.exec(candidate);
  if (!list) return false;
  const padding = list[1] ?? '';
  return padding.includes('\t') || padding.length >= 5 || /^(?: {4}|\t)/.test(list[2] ?? '');
}

function extractTitle(body: string): string | undefined {
  let fence: MarkdownFence | undefined;
  for (const line of body.split(/\r?\n/)) {
    const transition = transitionFence(line, fence);
    fence = transition.fence;
    if (transition.delimiter || fence) continue;
    if (isIndentedCodeLine(line)) continue;
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
  let fence: MarkdownFence | undefined;
  let inContainer = false;
  let inTag = false;
  let hiddenTag: 'script' | 'style' | undefined;

  const finishParagraph = () => {
    if (current.length > 0) paragraphs.push(current.join(' '));
    current = [];
  };

  for (const rawLine of body.split(/\r?\n/)) {
    const transition = transitionFence(rawLine, fence);
    fence = transition.fence;
    if (transition.delimiter || fence) {
      finishParagraph();
      continue;
    }
    if (isIndentedCodeLine(rawLine)) {
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
  const lines: string[] = [];
  let fence: MarkdownFence | undefined;
  for (const line of body.split(/\r?\n/)) {
    const transition = transitionFence(line, fence);
    fence = transition.fence;
    if (!transition.delimiter && !fence && !isIndentedCodeLine(line)) lines.push(line);
  }
  return lines.join('\n').replace(/<!--[\s\S]*?-->/g, ' ');
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
  // JavaScript lowercasing preserves Greek final sigma (ς), while a
  // case-insensitive search for Σ produces σ. Fold the positional variants to
  // one form after NFKC/lowercase so substring matching is position agnostic.
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\u03c2/g, '\u03c3');
}

interface NormalizedIndex {
  boundaries: number[];
  codePoints: number[];
  value: string;
}

function indexNormalizedText(value: string): NormalizedIndex {
  const boundaries: number[] = [];
  const codePoints: number[] = [];
  for (const part of GRAPHEME_SEGMENTER.segment(value)) {
    boundaries.push(part.index);
    codePoints.push(Array.from(part.segment).length);
  }
  boundaries.push(value.length);
  return { boundaries, codePoints, value: normalize(value) };
}

function sourceBoundaryForNormalizedOffset(
  text: string,
  indexed: NormalizedIndex,
  normalizedOffset: number,
): number {
  // NFKC may compose across grapheme boundaries (for example compatibility
  // Jamo ㄱ + ㅏ -> 가), so independently normalizing each grapheme cannot
  // produce a correct offset map. Normalized prefix lengths are monotonic:
  // composition may create a plateau but cannot remove prior output. Binary
  // search those true whole-prefix lengths instead.
  let low = 0;
  let high = indexed.boundaries.length - 1;
  const lengths = new Map<number, number>([
    [0, 0],
    [high, indexed.value.length],
  ]);
  const prefixLength = (boundary: number): number => {
    const cached = lengths.get(boundary);
    if (cached !== undefined) return cached;
    const length = normalize(text.slice(0, indexed.boundaries[boundary])).length;
    lengths.set(boundary, length);
    return length;
  };
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (prefixLength(middle) <= normalizedOffset) low = middle;
    else high = middle - 1;
  }
  return low;
}

function sourceBoundaryForNormalizedEnd(
  text: string,
  indexed: NormalizedIndex,
  normalizedOffset: number,
): number {
  const floor = sourceBoundaryForNormalizedOffset(text, indexed, normalizedOffset);
  const floorLength = normalize(text.slice(0, indexed.boundaries[floor])).length;
  // An offset inside an expanded source grapheme (İ -> i + dot, ﬁ -> fi)
  // needs the following boundary. Exact offsets use the end of their plateau,
  // which also captures composition across boundaries (ㄱ + ㅏ -> 가).
  return floorLength < normalizedOffset
    ? Math.min(floor + 1, indexed.boundaries.length - 1)
    : floor;
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
  const indexed = indexNormalizedText(text);
  const normalized = indexed.value;
  const exactIndex = normalized.indexOf(query);
  let matchIndex = exactIndex;
  let matchLength = query.length;
  if (matchIndex < 0) {
    matchIndex = Number.POSITIVE_INFINITY;
    for (const term of terms) {
      const index = normalized.indexOf(term);
      if (index >= 0 && index < matchIndex) {
        matchIndex = index;
        matchLength = term.length;
      }
    }
  }
  if (!Number.isFinite(matchIndex)) return truncate(text, EXCERPT_LENGTH);

  const matchStartGrapheme = sourceBoundaryForNormalizedOffset(text, indexed, matchIndex);
  const matchEndGrapheme = sourceBoundaryForNormalizedEnd(
    text,
    indexed,
    Math.min(normalized.length, matchIndex + matchLength),
  );
  let matchCodePoints = 0;
  for (let index = matchStartGrapheme; index < matchEndGrapheme; index += 1) {
    matchCodePoints += indexed.codePoints[index] ?? 0;
  }

  // Anchor the window to the source match rather than subtracting from its
  // normalized offset: NFKC can contract one source grapheme (for example a
  // three-code-point Hangul Jamo sequence) to one indexed character. Reserve
  // room for the complete source match when it fits; overlong matches are
  // sensibly shown from their beginning and truncated to the normal window.
  const contextLimit = Math.min(
    Math.floor(EXCERPT_LENGTH / 3),
    Math.max(0, EXCERPT_LENGTH - matchCodePoints),
  );
  let startGrapheme = matchStartGrapheme;
  let contextCodePoints = 0;
  while (startGrapheme > 0) {
    const previousLength = indexed.codePoints[startGrapheme - 1] ?? 0;
    if (contextCodePoints + previousLength > contextLimit) break;
    contextCodePoints += previousLength;
    startGrapheme -= 1;
  }
  const start = indexed.boundaries[startGrapheme] ?? 0;
  const prefix = start > 0 ? '…' : '';
  const characters: string[] = [];
  for (const character of text.slice(start)) {
    if (characters.length >= EXCERPT_LENGTH) break;
    characters.push(character);
  }
  const selected = characters.join('');
  const value = selected.trim();
  const suffix = start + selected.length < text.length ? '…' : '';
  return `${prefix}${value}${suffix}`;
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
