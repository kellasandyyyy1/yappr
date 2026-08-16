/**
 * Lightweight client-side profanity / slur filter.
 *
 * Used to mask message previews in the inbox list, where text appears
 * without the recipient having opted into reading it. Inside an open
 * conversation the original text is always shown untouched — this is a
 * preview-surface filter, not censorship of the message itself.
 *
 * Matching is token-based (not substring) so ordinary words that merely
 * contain a flagged sequence are never hit — "classic", "Scunthorpe",
 * "assess" and friends all pass through clean.
 */

/** Terms masked in previews. Lowercase, already leet-normalized. */
const BLOCKED = new Set<string>([
  // English profanity
  'fuck', 'fucker', 'fucking', 'fucked', 'fuk', 'fck', 'motherfucker',
  'shit', 'shitty', 'bullshit', 'shite',
  'bitch', 'bitches', 'bitching',
  'cunt', 'twat',
  'asshole', 'arsehole', 'dickhead', 'jackass', 'dumbass',
  'bastard', 'wanker', 'prick', 'douchebag',
  'cock', 'dick', 'pussy', 'whore', 'slut',
  'piss', 'pissed', 'crap',
  // Slurs — masked unconditionally
  'nigger', 'nigga', 'niggers', 'niggas',
  'faggot', 'fag', 'faggots', 'dyke',
  'retard', 'retarded', 'tranny',
  'chink', 'gook', 'spic', 'kike', 'wetback', 'coon',
  // Tagalog / Filipino profanity
  'putangina', 'putang', 'tangina', 'tanginamo', 'putanginamo',
  'gago', 'gaga', 'gagong', 'ulol', 'tanga', 'bobo',
  'tarantado', 'punyeta', 'leche', 'lintik',
  'kingina', 'pakyu', 'bwisit', 'hayop',
  'burat', 'tite', 'puke', 'kantot', 'iyot',
]);

/** Homoglyph / leet substitutions folded before lookup. */
const LEET: Record<string, string> = {
  '0': 'o', '1': 'i', '!': 'i', '3': 'e', '4': 'a', '@': 'a',
  '5': 's', '$': 's', '7': 't', '8': 'b', '9': 'g', '*': '',
};

function normalize(token: string): string {
  const folded = token
    .toLowerCase()
    .split('')
    .map((ch) => (ch in LEET ? LEET[ch] : ch))
    .join('')
    .replace(/[^a-z]/g, '');

  // Collapse runs of 3+ identical letters ("fuuuuck" -> "fuck") while
  // leaving genuine doubles ("ass") alone.
  return folded.replace(/(.)\1{2,}/g, '$1');
}

/** Strips a trailing plural/participle so "gagos" matches "gago". */
function stem(word: string): string {
  return word.replace(/(ing|ed|ers|er|es|s)$/, '');
}

function isBlocked(token: string): boolean {
  const norm = normalize(token);
  if (norm.length < 3) return false;
  return BLOCKED.has(norm) || BLOCKED.has(stem(norm));
}

/** Splits into word / non-word runs, preserving every original character. */
function tokenize(text: string): string[] {
  return text.split(/([^\p{L}\p{N}@$!*]+)/u).filter((p) => p !== '');
}

export function containsProfanity(text: string | undefined | null): boolean {
  if (!text) return false;
  return tokenize(text).some(isBlocked);
}

/**
 * Replaces flagged words with bullets, keeping length and surrounding
 * punctuation so the preview still reads as a sentence.
 */
export function maskProfanity(text: string | undefined | null): string {
  if (!text) return '';
  return tokenize(text)
    .map((token) => (isBlocked(token) ? '•'.repeat(Math.min(token.length, 8)) : token))
    .join('');
}

export interface ModeratedPreview {
  /** Safe to render immediately. */
  text: string;
  /** Original text, shown only after an explicit reveal. */
  original: string;
  /** True when `text` differs from `original`. */
  flagged: boolean;
}

export function moderatePreview(text: string | undefined | null): ModeratedPreview {
  const original = text || '';
  const flagged = containsProfanity(original);
  return {
    text: flagged ? maskProfanity(original) : original,
    original,
    flagged,
  };
}
