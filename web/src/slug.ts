/** Slugify a node label the same way the compiler does (for matching metric service keys). */
export function slugify(label: string): string {
  return label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
