import type { DocComponent, DocPage, DocsSearchResult } from './types.js';

const SUMMARY_LENGTH = 160;
const EXCERPT_LENGTH = 180;

interface ParsedSource {
  body: string;
  frontmatter: string;
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
  const match = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) return { body: content, frontmatter: '' };
  return {
    body: content.slice(match[0].length),
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

function extractTitle(body: string): string | undefined {
  let fence: string | undefined;
  for (const line of body.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]?.slice(0, 1);
    if (marker) {
      if (!fence) fence = marker;
      else if (marker === fence) fence = undefined;
      continue;
    }
    if (fence) continue;
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
  let fence: string | undefined;
  let inContainer = false;
  let inTag = false;
  let hiddenTag: 'script' | 'style' | undefined;

  const finishParagraph = () => {
    if (current.length > 0) paragraphs.push(current.join(' '));
    current = [];
  };

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    const marker = /^(`{3,}|~{3,})/.exec(line)?.[1]?.slice(0, 1);
    if (marker) {
      if (!fence) fence = marker;
      else if (marker === fence) fence = undefined;
      finishParagraph();
      continue;
    }
    if (fence) continue;
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
  let fence: string | undefined;
  for (const line of body.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]?.slice(0, 1);
    if (marker) {
      if (!fence) fence = marker;
      else if (marker === fence) fence = undefined;
      continue;
    }
    if (!fence) lines.push(line);
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
  return value.normalize('NFKC').toLowerCase();
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
  const normalized = normalize(text);
  const exactIndex = normalized.indexOf(query);
  const matchIndex =
    exactIndex >= 0
      ? exactIndex
      : Math.min(...terms.map((term) => normalized.indexOf(term)).filter((index) => index >= 0));
  if (!Number.isFinite(matchIndex)) return truncate(text, EXCERPT_LENGTH);

  const start = Math.max(0, matchIndex - Math.floor(EXCERPT_LENGTH / 3));
  const prefix = start > 0 ? '…' : '';
  const value = text.slice(start, start + EXCERPT_LENGTH).trim();
  const suffix = start + EXCERPT_LENGTH < text.length ? '…' : '';
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
