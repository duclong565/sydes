export function slugify(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, '-');
}
