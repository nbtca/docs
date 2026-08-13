import { describe, expect, it } from 'vitest';
import { parseDoc, searchDoc } from '../content.js';

describe('parseDoc', () => {
  it('reads top-level frontmatter used by component-led pages', () => {
    const page = parseDoc(
      'repair/index.md',
      [
        '---',
        'title: "Repair"',
        "summary: 'Free support for the campus.'",
        '---',
        '',
        '<PageHero',
        '  title="Repair"',
        '  lede="Bring us a computer."',
        '  src="./hero.jpg"',
        '/>',
        '',
        'The team runs regular repair days.',
      ].join('\n'),
    );

    expect(page).toMatchObject({
      name: 'index.md',
      path: 'repair/index.md',
      route: '/repair/',
      section: 'repair',
      summary: 'Free support for the campus.',
      title: 'Repair',
    });
    expect(page.components).toContainEqual({
      name: 'PageHero',
      attributes: {
        lede: 'Bring us a computer.',
        src: './hero.jpg',
        title: 'Repair',
      },
    });
  });

  it('falls back to the first H1 and prose paragraph', () => {
    const page = parseDoc(
      'about/community.md',
      [
        '```md',
        '# Not the title',
        '```',
        '',
        '# Community **guide**',
        '',
        '<Figure src="team.jpg" caption="A gathering" />',
        '',
        'Meet the [community](/about/) and its projects.',
      ].join('\n'),
    );

    expect(page.title).toBe('Community guide');
    expect(page.summary).toBe('Meet the community and its projects.');
    expect(page.route).toBe('/about/community');
  });

  it('ignores a UTF-8 BOM when a document starts directly with Markdown', () => {
    const page = parseDoc('about/fallback.md', '\uFEFF# Actual title\n\nThe first real paragraph.');

    expect(page.title).toBe('Actual title');
    expect(page.summary).toBe('The first real paragraph.');
  });

  it('prefers the document H1 when legacy frontmatter is stale', () => {
    const page = parseDoc(
      'archived/meeting.md',
      ['---', 'title: Docs with VitePress', '---', '', '# Development meeting'].join('\n'),
    );

    expect(page.title).toBe('Development meeting');
  });

  it('preserves semantic attributes from document components', () => {
    const page = parseDoc(
      'about/history.md',
      [
        '# History',
        '<LinkCard href="/join" title="Join" desc="Ways to participate" />',
        '<Split heading="One community" alt="Members together">',
        '<TimelineEntry year="2001" title="Founded" pivot>',
        '<Figure caption="First gathering" date="2001" source="Archive" wide />',
      ].join('\n'),
    );

    expect(page.components).toEqual([
      {
        name: 'LinkCard',
        attributes: { desc: 'Ways to participate', href: '/join', title: 'Join' },
      },
      { name: 'Split', attributes: { alt: 'Members together', heading: 'One community' } },
      {
        name: 'TimelineEntry',
        attributes: { pivot: true, title: 'Founded', year: '2001' },
      },
      {
        name: 'Figure',
        attributes: { caption: 'First gathering', date: '2001', source: 'Archive', wide: true },
      },
    ]);
  });

  it('uses PageHero metadata when a component-led page has no frontmatter or H1', () => {
    const page = parseDoc(
      'about/index.md',
      [
        '<PageHero',
        '  title="About the community"',
        '  lede="People, projects, and history."',
        '/>',
      ].join('\n'),
    );

    expect(page.title).toBe('About the community');
    expect(page.summary).toBe('People, projects, and history.');
  });

  it('indexes FactStrip labels and values without evaluating bindings', () => {
    const page = parseDoc(
      'about/facts.md',
      [
        '# Facts',
        '<FactStrip :facts="[',
        "  { label: 'Founded', value: '2001' },",
        "  { label: 'Focus', value: 'Open source community' },",
        ']" />',
      ].join('\n'),
    );

    expect(searchDoc(page, 'open source')).toMatchObject({ path: 'about/facts.md' });
    expect(searchDoc(page, 'founded 2001')).toMatchObject({ path: 'about/facts.md' });
  });

  it('keeps Unicode code points intact at the end of a search excerpt', () => {
    const page = parseDoc('search/unicode.md', `# X\n\nneedle ${'a'.repeat(170)}😀tail`);

    expect(searchDoc(page, 'needle')?.excerpt).toContain('😀…');
  });

  it('maps a match after NFKC-expanded ligatures back to the source excerpt', () => {
    const page = parseDoc('search/ligature.md', `# X\n\n${'ﬁ'.repeat(100)} needle tail`);

    expect(searchDoc(page, 'needle')?.excerpt).toContain('needle');
  });

  it('maps a match after NFKC-composed characters back to the source excerpt', () => {
    const page = parseDoc('search/combining.md', `# X\n\n${'e\u0301'.repeat(200)} needle tail`);

    expect(searchDoc(page, 'needle')?.excerpt).toContain('needle');
  });

  it('keeps a complete match after NFKC contracts Hangul Jamo graphemes', () => {
    const page = parseDoc('search/hangul-jamo.md', `# X\n\n${'각'.repeat(200)} needle tail`);

    expect(searchDoc(page, 'needle')?.excerpt).toContain('needle');
  });

  it('maps a match after NFKC composes across compatibility Jamo graphemes', () => {
    const page = parseDoc(
      'search/compatibility-jamo.md',
      `# X\n\n${'ㄱㅏ'.repeat(120)} needle tail`,
    );

    expect(searchDoc(page, 'needle')?.excerpt).toContain('needle');
  });

  it('truncates a query longer than the excerpt window from the match start', () => {
    const query = 'q'.repeat(240);
    const page = parseDoc('search/long-query.md', `# X\n\n${query} tail`);

    expect(searchDoc(page, query)?.excerpt).toBe(`…${'q'.repeat(180)}…`);
  });

  it('uses whole-string lowercase context when locating a search excerpt', () => {
    const page = parseDoc('search/final-sigma.md', `# X\n\n${'a'.repeat(240)} ΟΣ tail`);

    expect(searchDoc(page, 'ΟΣ')?.excerpt).toContain('ΟΣ');
  });

  it('maps a match after default Unicode lowercase expansion', () => {
    const page = parseDoc('search/lowercase-expansion.md', `# X\n\n${'İ'.repeat(100)} needle tail`);

    expect(searchDoc(page, 'needle')?.excerpt).toContain('needle');
  });

  it.each([
    ['default lowercase', 'İ', 'i'],
    ['compatibility ligature', 'ﬁ', 'f'],
  ])(
    'keeps the source tail when a match ends inside a %s expansion',
    (_kind, source, queryTail) => {
      const query = `${'a'.repeat(120)}${queryTail}`;
      const page = parseDoc(
        'search/expanded-match-end.md',
        `# X\n\n${'z'.repeat(100)}${'a'.repeat(120)}${source} TAIL`,
      );
      const excerpt = searchDoc(page, query)?.excerpt ?? '';

      expect(excerpt).toContain(source);
      expect(excerpt.normalize('NFKC').toLowerCase()).toContain(query);
    },
  );

  it('folds Greek final sigma for position-independent substring search', () => {
    const page = parseDoc('search/sigma.md', '# X\n\nΟΣ');

    expect(searchDoc(page, 'Σ')?.excerpt).toContain('ΟΣ');
  });

  it('does not treat nested home-page frontmatter as page metadata', () => {
    const page = parseDoc(
      'index.md',
      [
        '---',
        'layout: home',
        'hero:',
        '  title: Nested title',
        '---',
        '<style>',
        'x {}',
        '</style>',
      ].join('\n'),
    );

    expect(page.title).toBe('index');
    expect(page.summary).toBe('');
    expect(page.route).toBe('/');
  });

  it('ignores component examples in comments and fenced code', () => {
    const page = parseDoc(
      'tutorial/components.md',
      [
        '# Components',
        '<!-- <PageHero title="Comment" lede="Comment" /> -->',
        '```vue',
        '<PageHero title="Example" lede="Example" />',
        '```',
      ].join('\n'),
    );

    expect(page.components).toEqual([]);
    expect(page.title).toBe('Components');
  });

  it('ignores component examples in four-space indented code', () => {
    const page = parseDoc(
      'tutorial/indented-code.md',
      '    <PageHero title="Example" lede="Example only" />',
    );

    expect(page.components).toEqual([]);
    expect(page.title).toBe('indented-code');
  });

  it('keeps shorter nested fences inside a longer fenced example', () => {
    const page = parseDoc(
      'tutorial/nested-fence.md',
      [
        '````markdown',
        '```vue',
        '# Example title',
        '<PageHero title="Example" lede="Example only" />',
        '```',
        '````',
      ].join('\n'),
    );

    expect(page.components).toEqual([]);
    expect(page.title).toBe('nested-fence');
  });

  it.each([
    ['indented code', '    ```vue\n    <PageHero title="Example" lede="Example only" />\n    ```'],
    ['a blockquote fence', '> ```vue\n> <PageHero title="Example" lede="Example only" />\n> ```'],
    ['a list fence', '- ```vue\n  <PageHero title="Example" lede="Example only" />\n  ```'],
  ])('ignores component examples inside %s', (_kind, content) => {
    const page = parseDoc('tutorial/container-code.md', content);

    expect(page.components).toEqual([]);
    expect(page.title).toBe('container-code');
    expect(page.summary).toBe('');
  });

  it.each([
    ['blockquote', '> ```vue\n> example\n<PageHero title="Real" lede="Visible" />'],
    ['list', '- ```vue\n  example\n<PageHero title="Real" lede="Visible" />'],
  ])('ends a %s fence when its container ends', (_kind, content) => {
    const page = parseDoc('tutorial/after-container.md', content);

    expect(page.components).toHaveLength(1);
    expect(page.title).toBe('Real');
    expect(page.summary).toBe('Visible');
  });

  it('does not let a nested blockquote delimiter close an outer fence', () => {
    const page = parseDoc(
      'tutorial/nested-quote.md',
      ['> ````', '>> ````', '> <PageHero title="Example" lede="Example only" />', '> ````'].join(
        '\n',
      ),
    );

    expect(page.components).toEqual([]);
    expect(page.title).toBe('nested-quote');
  });

  it.each([
    ['blockquote', '>     <PageHero title="Example" lede="Example only" />'],
    ['list', '-     <PageHero title="Example" lede="Example only" />'],
  ])('ignores indented code inside a %s', (_kind, content) => {
    const page = parseDoc('tutorial/container-indented.md', content);

    expect(page.components).toEqual([]);
    expect(page.title).toBe('container-indented');
  });

  it.each([
    ['a list-shaped line', '- ````'],
    ['a quote-shaped line', '> ````'],
  ])('does not close a top-level fence on %s', (_kind, innerDelimiter) => {
    const page = parseDoc(
      'tutorial/fence-container-example.md',
      [
        '````markdown',
        innerDelimiter,
        '<PageHero title="Example" lede="Example only" />',
        '````',
      ].join('\n'),
    );

    expect(page.components).toEqual([]);
    expect(page.title).toBe('fence-container-example');
  });
});
