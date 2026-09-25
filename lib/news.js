// Google News search: free, no key, no account. Returns the top few recent
// results for a search phrase; the drafter decides whether any of them fits.

const decode = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .trim();
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : '';
};
const stripHtml = s => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function parseRss(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => {
    const source = tag(item, 'source');
    let headline = tag(item, 'title');
    // Google News titles end in " - Publication"; the publication is in <source>.
    if (source && headline.endsWith(` - ${source}`)) headline = headline.slice(0, -(source.length + 3));
    const pub = tag(item, 'pubDate');
    // The RSS description is usually just the headline again as a link; keep
    // it as a summary only when it says something more.
    const description = stripHtml(tag(item, 'description')).replace(source, '').trim();
    return {
      headline,
      source,
      date: pub ? new Date(pub).toISOString().slice(0, 10) : '',
      link: tag(item, 'link'),
      summary: description && !description.startsWith(headline) ? description : ''
    };
  }).filter(i => i.headline && i.link);
}

// Recent (last 60 days), Indian edition first.
async function searchNews(phrase, { limit = 5, days = 60 } = {}) {
  if (!phrase) return [];
  const q = encodeURIComponent(`${phrase} when:${days}d`);
  const res = await fetch(`https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`, {
    headers: { 'user-agent': 'Mozilla/5.0 (note-to-post)' }
  });
  if (!res.ok) throw new Error(`Google News returned ${res.status}`);
  return parseRss(await res.text()).slice(0, limit);
}

module.exports = { searchNews, parseRss };
