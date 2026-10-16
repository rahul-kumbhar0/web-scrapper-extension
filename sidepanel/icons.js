// Inline SVG icons (24×24, stroke-based), built with DOM APIs — no innerHTML.
const P = {
  list: ['M8 6h12', 'M8 12h12', 'M8 18h12', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
  pages: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5', 'M9 13h6', 'M9 17h4'],
  mail: ['M4 6h16v12H4z', 'm4 7 8 6 8-6'],
  share: ['M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'm8.6 13.5 6.8 4', 'm15.4 6.5-6.8 4'],
  image: ['M4 5h16v14H4z', 'm4 16 5-5 4 4 3-3 4 4', 'M15.5 9.5h.01'],
  bag: ['M6 7h12l-1 13H7z', 'M9 7a3 3 0 0 1 6 0'],
  sitemap: ['M10 3h4v4h-4z', 'M3 17h4v4H3z', 'M10 17h4v4h-4z', 'M17 17h4v4h-4z', 'M12 7v5', 'M5 17v-3h14v3', 'M12 12v5'],
  text: ['M4 6h16', 'M4 12h16', 'M4 18h10'],
  bolt: ['M13 2 4 14h7l-1 8 9-12h-7z'],
  sparkle: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z', 'M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z'],
  table: ['M3 5h18v14H3z', 'M3 10h18', 'M3 15h18', 'M9 5v14'],
  book: ['M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z', 'M5 17a3 3 0 0 1 3-3h11'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  gear: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
  back: ['m15 18-6-6 6-6'],
  chevron: ['m9 18 6-6-6-6'],
  plug: ['M9 2v6', 'M15 2v6', 'M6 8h12v3a6 6 0 0 1-12 0z', 'M12 17v5'],
  crown: ['m3 7 4 4 5-7 5 7 4-4-2 12H5z'],
  scan: ['M3 7V5a2 2 0 0 1 2-2h2', 'M17 3h2a2 2 0 0 1 2 2v2', 'M21 17v2a2 2 0 0 1-2 2h-2', 'M7 21H5a2 2 0 0 1-2-2v-2', 'M7 12h10'],
  check: ['m5 12 5 5 9-10'],
  lock: ['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  shield: ['M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z'],
  external: ['M14 4h6v6', 'M20 4 10 14', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
};

export const TOOL_ICONS = {
  list: 'list', page: 'pages', email: 'mail', social: 'share', images: 'image', shopify: 'bag',
  sitemap: 'sitemap', text: 'text', quick: 'bolt', ai: 'sparkle',
  table: 'table', recipes: 'book', history: 'clock', settings: 'gear', upgrade: 'crown',
};

const NS = 'http://www.w3.org/2000/svg';

export function icon(name, { size = 18, cls = '' } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `ico ${cls}`.trim());
  for (const d of P[name] || P.list) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
