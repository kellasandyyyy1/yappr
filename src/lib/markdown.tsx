import React from 'react';

/**
 * Minimal Markdown renderer for the legal documents.
 *
 * Produces React elements directly rather than an HTML string, so there is no
 * `dangerouslySetInnerHTML` and no injection surface — even if a document
 * were edited to contain raw HTML, it renders as literal text. Link targets
 * are additionally checked against an allowlist of schemes so a `javascript:`
 * URL can never make it into an href.
 *
 * Supports the subset the legal docs actually use: front matter, h1–h3,
 * paragraphs, ordered/unordered lists, blockquotes, tables, horizontal rules,
 * bold, italic, inline code, and links.
 */

export interface Heading {
  id: string;
  text: string;
  level: number;
}

export interface ParsedMarkdown {
  frontMatter: Record<string, string>;
  headings: Heading[];
  body: React.ReactNode;
}

/** Stable, URL-safe anchor id derived from heading text. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
}

/** Only these schemes may appear in an href. Everything else is dropped. */
function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^mailto:/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return trimmed;
  return null;
}

/** Splits `---` front matter off the top of the document. */
function extractFrontMatter(source: string): {
  frontMatter: Record<string, string>;
  content: string;
} {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontMatter: {}, content: source };

  const frontMatter: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    frontMatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { frontMatter, content: source.slice(match[0].length) };
}

/** Inline formatting: bold, italic, code, links. */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // One pass over all inline constructs, longest-delimiter first so `**` wins
  // over `*`.
  const pattern = /(\*\*[^*]+\*\*)|(\*[^*]+\*)|(`[^`]+`)|(\[[^\]]+\]\([^)]+\))/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    const key = `${keyPrefix}-i${i++}`;

    if (token.startsWith('**')) {
      nodes.push(
        <strong key={key} className="font-semibold text-fg">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith('`')) {
      nodes.push(
        <code
          key={key}
          className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[0.9em] text-fg"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith('[')) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        const href = safeHref(linkMatch[2]);
        if (href) {
          const external = /^https?:\/\//i.test(href);
          nodes.push(
            <a
              key={key}
              href={href}
              {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              className="text-accent underline underline-offset-2 hover:text-accent-soft"
            >
              {linkMatch[1]}
            </a>
          );
        } else {
          // Unsafe scheme — keep the label, drop the link.
          nodes.push(linkMatch[1]);
        }
      }
    } else {
      nodes.push(
        <em key={key} className="italic">
          {token.slice(1, -1)}
        </em>
      );
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function splitTableRow(line: string): string[] {
  return line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

export function parseMarkdown(source: string): ParsedMarkdown {
  const { frontMatter, content } = extractFrontMatter(source);
  const lines = content.split(/\r?\n/);

  const headings: Heading[] = [];
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  const nextKey = () => `b${key++}`;

  while (i < lines.length) {
    const line = lines[i];

    // Blank
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Horizontal rule
    if (/^---+\s*$/.test(line)) {
      blocks.push(<hr key={nextKey()} className="my-8 border-line" />);
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      const id = slugify(text);
      if (level === 2 || level === 3) headings.push({ id, text, level });

      const k = nextKey();
      if (level === 1) {
        blocks.push(
          <h1 key={k} id={id} className="mt-10 mb-4 text-3xl font-bold tracking-tight text-fg first:mt-0">
            {renderInline(text, k)}
          </h1>
        );
      } else if (level === 2) {
        blocks.push(
          <h2
            key={k}
            id={id}
            className="mt-12 mb-4 scroll-mt-24 border-b border-line pb-2 text-2xl font-bold tracking-tight text-fg first:mt-0"
          >
            {renderInline(text, k)}
          </h2>
        );
      } else {
        blocks.push(
          <h3 key={k} id={id} className="mt-8 mb-3 scroll-mt-24 text-lg font-semibold text-fg">
            {renderInline(text, k)}
          </h3>
        );
      }
      i++;
      continue;
    }

    // Blockquote — used for the [PLACEHOLDER] callouts, so it is styled to
    // stand out rather than recede.
    if (line.startsWith('>')) {
      const quoted: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quoted.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      const k = nextKey();
      const text = quoted.join(' ').trim();
      const isPlaceholder = /\[PLACEHOLDER/i.test(text);
      blocks.push(
        <blockquote
          key={k}
          className={
            isPlaceholder
              ? 'my-6 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-[15px] leading-relaxed text-amber-200'
              : 'my-6 rounded-xl border-l-2 border-accent bg-surface-2 p-4 text-[15px] leading-relaxed text-muted'
          }
        >
          {renderInline(text, k)}
        </blockquote>
      );
      continue;
    }

    // Table
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]*-[-\s|:]*\|?\s*$/.test(lines[i + 1])) {
      const header = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      const k = nextKey();
      blocks.push(
        <div key={k} className="my-6 overflow-x-auto rounded-xl border border-line">
          <table className="w-full border-collapse text-left text-[15px]">
            <thead>
              <tr className="bg-surface-2">
                {header.map((cell, c) => (
                  <th key={c} className="border-b border-line px-4 py-3 font-semibold text-fg">
                    {renderInline(cell, `${k}-h${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r} className="border-b border-line last:border-0">
                  {row.map((cell, c) => (
                    <td key={c} className="px-4 py-3 align-top leading-relaxed text-muted">
                      {renderInline(cell, `${k}-r${r}c${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // Lists
    const isUnordered = /^[-*]\s+/.test(line);
    const isOrdered = /^\d+\.\s+/.test(line);
    if (isUnordered || isOrdered) {
      const items: string[] = [];
      const matcher = isUnordered ? /^[-*]\s+/ : /^\d+\.\s+/;
      while (i < lines.length && matcher.test(lines[i])) {
        let item = lines[i].replace(matcher, '');
        i++;
        // Continuation lines are indented.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i])) {
          item += ' ' + lines[i].trim();
          i++;
        }
        items.push(item);
      }
      const k = nextKey();
      const ListTag = isOrdered ? 'ol' : 'ul';
      blocks.push(
        <ListTag
          key={k}
          className={`my-4 space-y-2 pl-6 text-[16px] leading-[1.75] text-muted ${
            isOrdered ? 'list-decimal' : 'list-disc'
          }`}
        >
          {items.map((item, idx) => (
            <li key={idx} className="pl-1 marker:text-subtle">
              {renderInline(item, `${k}-l${idx}`)}
            </li>
          ))}
        </ListTag>
      );
      continue;
    }

    // Paragraph — consumes until a blank line or a new block starts.
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,4}\s|>|[-*]\s|\d+\.\s|---+\s*$)/.test(lines[i])
    ) {
      paragraph.push(lines[i].trim());
      i++;
    }
    if (paragraph.length > 0) {
      const k = nextKey();
      blocks.push(
        <p key={k} className="my-4 text-[16px] leading-[1.75] text-muted">
          {renderInline(paragraph.join(' '), k)}
        </p>
      );
    }
  }

  return { frontMatter, headings, body: blocks };
}
