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
});
