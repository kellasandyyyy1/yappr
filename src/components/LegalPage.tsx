import React, { useState, useEffect, useMemo } from 'react';
import { ArrowLeft, FileText, ListTree, AlertTriangle } from 'lucide-react';
import { parseMarkdown, type ParsedMarkdown } from '../lib/markdown';
import { fetchLegalDocument, fetchLegalManifest, formatLegalDate } from '../lib/legal';
import { navigate, goBack } from '../lib/router';
import { Skeleton } from './Skeleton';
import { cn } from '../lib/utils';

/**
 * Renders a legal document from Markdown.
 *
 * Typography here deliberately departs from the rest of the app: a ~72ch
 * measure, 1.75 line-height, and body text at the primary foreground colour
 * rather than muted. These are documents people need to actually read and
 * that need to hold up to an accessibility audit, so legibility wins over
 * the denser styling used elsewhere.
 */

interface LegalPageProps {
  slug: string;
  /** Shown when there's nowhere to go back to. */
  onExit?: () => void;
}

export function LegalPage({ slug, onExit }: LegalPageProps) {
  const [source, setSource] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [version, setVersion] = useState<string>('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [activeId, setActiveId] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setSource(null);

    (async () => {
      const [text, manifest] = await Promise.all([
        fetchLegalDocument(slug),
        fetchLegalManifest(),
      ]);
      if (cancelled) return;

      if (!text) {
        setStatus('error');
        return;
      }
      setSource(text);
      setLastUpdated(manifest?.lastUpdated ?? '');
      setVersion(manifest?.version ?? '');
      setStatus('ready');
    })();

    return () => {
      cancelled = true;
    };
  }, [slug]);

  const parsed: ParsedMarkdown | null = useMemo(
    () => (source ? parseMarkdown(source) : null),
    [source]
  );

  // Front matter overrides the manifest, so a single document can carry its
  // own date if the two ever drift.
  const displayDate = parsed?.frontMatter.lastUpdated || lastUpdated;
  const displayVersion = parsed?.frontMatter.version || version;
  const title = parsed?.frontMatter.title || 'Legal';

  // Highlight the section currently in view in the table of contents.
  useEffect(() => {
    if (!parsed || parsed.headings.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: '-80px 0px -70% 0px', threshold: 0 }
    );

    for (const heading of parsed.headings) {
      const el = document.getElementById(heading.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [parsed]);

  const jumpTo = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Keep the URL shareable down to the section.
    window.history.replaceState({}, '', `${window.location.pathname}#${id}`);
    setActiveId(id);
  };

  // Honour a #hash on first load once the content exists.
  useEffect(() => {
    if (status !== 'ready') return;
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    const el = document.getElementById(hash);
    if (el) {
      requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
      setActiveId(hash);
    }
  }, [status]);

  const otherSlug = slug === 'privacy-policy' ? 'terms-of-conditions' : 'privacy-policy';
  const otherLabel = slug === 'privacy-policy' ? 'Terms of Conditions' : 'Privacy Policy';

  return (
    <div className="min-h-[100dvh] bg-bg">
      <header className="sticky top-0 z-10 border-b border-line bg-bg/95 backdrop-blur-none">
        <div className="mx-auto flex max-w-[1100px] items-center gap-3 px-5 py-3 sm:px-8">
          <button
            onClick={() => (onExit ? onExit() : goBack('/'))}
            className="tap -ml-2 shrink-0 rounded-full text-muted transition-colors duration-100 hover:text-fg"
            aria-label="Go back"
          >
            <ArrowLeft size={20} />
          </button>
          <span className="flex min-w-0 items-center gap-2 text-[15px] font-semibold text-fg">
            <FileText size={17} className="shrink-0 text-accent" />
            <span className="truncate">Yappr</span>
          </span>
          <nav className="ml-auto flex items-center gap-1 text-sm">
            <button
              onClick={() => navigate(`/${otherSlug}`)}
              className="rounded-full px-3 py-1.5 font-medium text-muted transition-colors duration-100 hover:bg-surface-2 hover:text-fg"
            >
              {otherLabel}
            </button>
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-[1100px] px-5 pb-24 pt-8 sm:px-8">
        {status === 'loading' && (
          <div className="mx-auto max-w-[760px] space-y-4">
            <Skeleton className="h-9 w-2/3" />
            <Skeleton className="h-4 w-40" />
            <div className="space-y-3 pt-6">
              {Array.from({ length: 10 }).map((_, i) => (
                <div
                  key={i}
                  className={cn('h-4 animate-pulse rounded-md bg-surface-2', i % 3 === 2 ? 'w-[70%]' : 'w-full')}
                />
              ))}
            </div>
          </div>
        )}

        {status === 'error' && (
          <div className="mx-auto flex max-w-[560px] flex-col items-center gap-4 py-24 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-surface-2 text-muted">
              <AlertTriangle size={26} />
            </div>
            <h1 className="text-xl font-bold text-fg">We couldn't load this document</h1>
            <p className="text-[15px] leading-relaxed text-muted">
              Check your connection and try again. If it keeps happening, email{' '}
              <a
                href="mailto:privacy@privy.app"
                className="text-accent underline underline-offset-2"
              >
                privacy@privy.app
              </a>{' '}
              and we'll send you a copy.
            </p>
            <button onClick={() => window.location.reload()} className="btn-secondary px-5 py-2.5 text-sm">
              Try again
            </button>
          </div>
        )}

        {status === 'ready' && parsed && (
          <div className="lg:flex lg:items-start lg:gap-12">
            {/* Table of contents — a sidebar on desktop, a collapsed list on
                mobile so it never buries the document itself. */}
            {parsed.headings.length > 0 && (
              <nav
                aria-label="On this page"
                className="mb-8 lg:sticky lg:top-20 lg:order-2 lg:mb-0 lg:w-64 lg:shrink-0"
              >
                <details open className="group rounded-xl border border-line bg-surface p-4 lg:border-0 lg:bg-transparent lg:p-0">
                  <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-fg lg:cursor-default lg:mb-3">
                    <ListTree size={15} className="text-accent" />
                    On this page
                  </summary>
                  <ul className="mt-3 space-y-1 lg:mt-0 lg:max-h-[calc(100dvh-8rem)] lg:overflow-y-auto lg:border-l lg:border-line">
                    {parsed.headings.map((heading) => (
                      <li key={heading.id}>
                        <button
                          onClick={() => jumpTo(heading.id)}
                          className={cn(
                            'block w-full rounded-md py-1.5 text-left text-sm leading-snug transition-colors duration-100',
                            'lg:-ml-px lg:rounded-none lg:border-l-2 lg:pl-3',
                            heading.level === 3 ? 'pl-4 lg:pl-6' : 'pl-2',
                            activeId === heading.id
                              ? 'font-medium text-accent lg:border-accent'
                              : 'text-muted hover:text-fg lg:border-transparent'
                          )}
                        >
                          {heading.text}
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              </nav>
            )}

            {/* ~72ch measure keeps lines in the comfortable reading range. */}
            <article className="min-w-0 lg:order-1 lg:flex-1">
              <div className="max-w-[72ch]">
                <h1 className="text-3xl font-bold tracking-tight text-fg sm:text-4xl">{title}</h1>

                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
                  <span>
                    <span className="font-medium text-fg">Last updated:</span>{' '}
                    <time dateTime={displayDate}>{formatLegalDate(displayDate)}</time>
                  </span>
                  {displayVersion && (
                    <span>
                      <span className="font-medium text-fg">Version:</span> {displayVersion}
                    </span>
                  )}
                </div>

                <div className="mt-8">{parsed.body}</div>

                <footer className="mt-16 border-t border-line pt-6">
                  <p className="text-sm text-muted">
                    See also{' '}
                    <button
                      onClick={() => navigate(`/${otherSlug}`)}
                      className="font-medium text-accent underline underline-offset-2 hover:text-accent-soft"
                    >
                      {otherLabel}
                    </button>
                    .
                  </p>
                </footer>
              </div>
            </article>
          </div>
        )}
      </div>
    </div>
  );
}
