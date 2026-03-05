import axios        from 'axios';
import * as cheerio from 'cheerio';
import robotsParser  from 'robots-parser';

const USER_AGENT    = 'OwlBankKnowledgeBot/1.0';
const MAX_PAGES     = 50;
const CONCURRENCY   = 2;
const REQUEST_DELAY = 500; // ms between batches

/**
 * Crawl a public website and return an array of { url, text } objects.
 * Respects robots.txt and noindex meta tags.
 *
 * @param {string} startUrl
 * @returns {Promise<Array<{ url: string, text: string }>>}
 */
export async function crawlWebsite(startUrl) {
  const base   = new URL(startUrl);
  const origin = base.origin;

  // Fetch robots.txt — allow all if absent
  let robots;
  try {
    const { data } = await axios.get(`${origin}/robots.txt`, {
      timeout: 5000,
      headers: { 'User-Agent': USER_AGENT },
    });
    robots = robotsParser(`${origin}/robots.txt`, data);
  } catch {
    robots = robotsParser(`${origin}/robots.txt`, '');
  }

  const visited = new Set();
  const queue   = [startUrl];
  const results = [];

  while (queue.length > 0 && results.length < MAX_PAGES) {
    const batch = queue.splice(0, CONCURRENCY);
    const pages = await Promise.allSettled(
      batch.map(url => fetchPage(url, origin, robots, visited))
    );

    for (const result of pages) {
      if (result.status === 'fulfilled' && result.value) {
        const { url, text, links } = result.value;
        results.push({ url, text });
        for (const link of links) {
          if (!visited.has(link) && !queue.includes(link)) {
            queue.push(link);
          }
        }
      }
    }

    if (queue.length > 0) {
      await new Promise(r => setTimeout(r, REQUEST_DELAY));
    }
  }

  console.log(`  Crawled ${results.length} pages from ${origin}`);
  return results;
}

async function fetchPage(url, origin, robots, visited) {
  if (visited.has(url)) return null;
  visited.add(url);

  if (!robots.isAllowed(url, USER_AGENT)) {
    console.log(`  [robots] blocked: ${url}`);
    return null;
  }

  let html;
  try {
    const { data } = await axios.get(url, {
      timeout:      10000,
      headers:      { 'User-Agent': USER_AGENT },
      maxRedirects: 3,
    });
    html = data;
  } catch (err) {
    console.warn(`  [fetch] failed ${url}: ${err.message}`);
    return null;
  }

  const $ = cheerio.load(html);

  // Respect noindex
  const metaRobots = $('meta[name="robots"]').attr('content') ?? '';
  if (metaRobots.includes('noindex')) return null;

  // Remove boilerplate
  $('script, style, nav, footer, header, aside, [role="banner"], [role="navigation"]').remove();

  // Extract main content
  const contentEl = $('main, article, [role="main"]');
  const root      = contentEl.length ? contentEl.first() : $('body');
  const text      = root.text()
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Extract same-origin links (no query strings, no fragments)
  const links = [];
  $('a[href]').each((_, el) => {
    try {
      const href  = new URL($(el).attr('href'), url);
      const clean = href.origin + href.pathname;
      if (href.origin === origin && clean !== url && !visited.has(clean)) {
        links.push(clean);
      }
    } catch { /* malformed href */ }
  });

  return { url, text, links };
}
