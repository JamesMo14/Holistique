/**
 * Linktree -> Holistique UK Wellness Tools Sync
 *
 * Fetches the "Wellness Tools Discount Codes" group from linktr.ee/holistiqueuk,
 * updates linktree-manifest.json, and injects product cards + ItemList structured
 * data into wellness-tools.html.
 *
 * Run: node scripts/sync-linktree.js
 *
 * One-off seeding of the enrichment map from the existing hand-written cards:
 *      node scripts/sync-linktree.js --seed
 *
 * No env vars, no secrets required.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'linktree-manifest.json');
const PAGE_PATH = path.join(ROOT, 'wellness-tools.html');

const LINKTREE_URL = 'https://linktr.ee/holistiqueuk';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Fail loudly rather than publish a near-empty page.
const MIN_ITEMS = 3;

// The Linktree group holding the affiliate products.
const GROUP_TITLE_RE = /wellness tools/i;

// Events are handled by sync-events.js; socials and newsletter links are not products.
const SKIP_HOSTS = [
    'eventbrite.co.uk', 'eventbrite.com',
    'substack.com',
    'instagram.com', 'facebook.com', 'tiktok.com', 'youtube.com', 'youtu.be',
    'x.com', 'twitter.com', 'linkedin.com',
    'wa.me', 'whatsapp.com',
    'medium.com',
];

// Suffixes that need three labels to reach the registrable domain.
const TWO_PART_SUFFIXES = ['co.uk', 'org.uk', 'ac.uk', 'me.uk', 'com.au', 'co.nz', 'co.za', 'com.br', 'co.jp'];

const CARD_START = '<!-- WELLNESS-TOOLS-START -->';
const CARD_END = '<!-- WELLNESS-TOOLS-END -->';
const SCHEMA_START = '<!-- WELLNESS-TOOLS-SCHEMA-START -->';
const SCHEMA_END = '<!-- WELLNESS-TOOLS-SCHEMA-END -->';

// ── Helpers ─────────────────────────────────────────────────────────────────

function fetchHtml(url) {
    return new Promise((resolve, reject) => {
        const doRequest = (requestUrl) => {
            const options = {
                headers: {
                    'User-Agent': USER_AGENT,
                    'Accept': 'text/html,application/xhtml+xml',
                    'Accept-Language': 'en-GB,en;q=0.9',
                },
            };
            https.get(requestUrl, options, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    doRequest(new URL(res.headers.location, requestUrl).toString());
                    return;
                }
                let data = '';
                res.setEncoding('utf8');
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
                        return;
                    }
                    resolve(data);
                });
            }).on('error', reject);
        };
        doRequest(url);
    });
}

function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function decodeEntities(str) {
    if (!str) return '';
    return str
        .replace(/<[^>]+>/g, '')
        .replace(/&mdash;/g, '—')
        .replace(/&ndash;/g, '–')
        .replace(/&rsquo;/g, '’')
        .replace(/&lsquo;/g, '‘')
        .replace(/&rdquo;/g, '”')
        .replace(/&ldquo;/g, '“')
        .replace(/&hellip;/g, '…')
        .replace(/&rarr;/g, '→')
        .replace(/&nbsp;/g, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

function stripHtml(str) {
    if (!str) return '';
    return str.replace(/<[^>]+>/g, '').trim();
}

function truncateText(text, maxLen) {
    if (!text) return '';
    const clean = stripHtml(text).replace(/\s+/g, ' ').trim();
    if (clean.length <= maxLen) return clean;
    const truncated = clean.substring(0, maxLen);
    const lastSpace = truncated.lastIndexOf(' ');
    return (lastSpace > 0 ? truncated.substring(0, lastSpace) : truncated) + '...';
}

function replaceSection(html, startMarker, endMarker, newContent) {
    const startIdx = html.indexOf(startMarker);
    const endIdx = html.indexOf(endMarker);
    if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
        return null; // markers not found
    }
    const before = html.substring(0, startIdx + startMarker.length);
    const after = html.substring(endIdx);
    return before + '\n' + newContent + '\n' + after;
}

/**
 * Registrable domain of a URL, used as the stable enrichment key.
 * "https://www.curoskin.co.uk/VONNYLANG" -> "curoskin.co.uk"
 */
function domainKey(url) {
    let host;
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch (e) {
        return '';
    }
    host = host.replace(/^www\./, '');
    const labels = host.split('.');
    if (labels.length <= 2) return host;
    const lastTwo = labels.slice(-2).join('.');
    const take = TWO_PART_SUFFIXES.includes(lastTwo) ? 3 : 2;
    return labels.slice(-take).join('.');
}

function isSkippedHost(url) {
    const key = domainKey(url);
    return !key || SKIP_HOSTS.includes(key);
}

/**
 * "Organised: Grass Fed Beef Protein Powder: VONNY10"
 *   -> { title: "Organised: Grass Fed Beef Protein Powder", code: "VONNY10" }
 * Code is the trailing token after the LAST colon, when it looks like a code.
 */
function parseTitle(rawTitle) {
    const full = (rawTitle || '').replace(/\s+/g, ' ').trim();
    const idx = full.lastIndexOf(':');
    if (idx === -1) return { title: full, code: null };
    const candidate = full.substring(idx + 1).trim();
    const head = full.substring(0, idx).trim();
    if (head && /^[A-Z0-9][A-Z0-9._-]{1,23}$/.test(candidate)) {
        return { title: head, code: candidate };
    }
    return { title: full, code: null };
}

// ── Linktree Parsing ────────────────────────────────────────────────────────

function extractNextData(html) {
    // The live tag carries extra attributes (type, crossorigin) — match loosely.
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) throw new Error('Could not find __NEXT_DATA__ script tag in Linktree response.');
    try {
        return JSON.parse(match[1]);
    } catch (e) {
        throw new Error(`__NEXT_DATA__ was not valid JSON: ${e.message}`);
    }
}

/**
 * props.pageProps.links is the richer array (carries thumbnail + metaData).
 * props.pageProps.account.links is a thinner, differently-shaped fallback.
 */
function getLinkArray(data) {
    const pageProps = (data && data.props && data.props.pageProps) || {};
    if (Array.isArray(pageProps.links) && pageProps.links.length) return pageProps.links;
    if (pageProps.account && Array.isArray(pageProps.account.links)) return pageProps.account.links;
    throw new Error('Could not find a links array at props.pageProps.links or props.pageProps.account.links.');
}

/**
 * Linktree groups are flat: the GROUP and its members are siblings, members carry
 * parent.id. Note parent.id is a Number while link.id is a String.
 */
function selectProductLinks(links) {
    const group = links.find(l => l.type === 'GROUP' && GROUP_TITLE_RE.test(l.title || ''));

    let candidates;
    if (group) {
        candidates = links.filter(l =>
            l.type === 'CLASSIC' &&
            l.parent &&
            String(l.parent.id) === String(group.id)
        );
        console.log(`  Found group "${group.title}" with ${candidates.length} CLASSIC link(s).`);
    } else {
        candidates = links.filter(l => l.type === 'CLASSIC');
        console.log(`  No wellness tools group found; falling back to all ${candidates.length} CLASSIC link(s).`);
    }

    return candidates
        .filter(l => l.url && !isSkippedHost(l.url))
        .sort((a, b) => (a.position || 0) - (b.position || 0));
}

function toItem(link) {
    const meta = link.metaData || link.metadata || {};
    const parsed = parseTitle(link.title);
    return {
        key: domainKey(link.url),
        title: parsed.title,
        code: parsed.code,
        url: link.url,
        description: truncateText(meta.ogDescription || meta.description || '', 280),
        thumbnail: link.thumbnail || meta.image || '',
    };
}

// ── Enrichment Seeding ──────────────────────────────────────────────────────

/**
 * One-off: harvest the hand-written cards currently in wellness-tools.html so their
 * copy, imagery and review links survive the switch to generated markup.
 */
function seedEnrichmentFromPage(html) {
    const enrichment = {};
    const chunks = html.split('<div class="product-card reveal">').slice(1);

    for (const chunk of chunks) {
        const grab = (re) => {
            const m = chunk.match(re);
            return m ? m[1].trim() : '';
        };
        const ctaHref = grab(/<a href="([^"]+)" class="btn btn--teal"/);
        if (!ctaHref) continue;

        const key = domainKey(ctaHref);
        if (!key) continue;

        const entry = {
            brand: grab(/<p class="product-card__brand">([\s\S]*?)<\/p>/),
            display_title: grab(/<h3 class="product-card__title">([\s\S]*?)<\/h3>/),
            description: grab(/<p class="product-card__desc">([\s\S]*?)<\/p>/),
            image: grab(/<img class="product-card__img" src="([^"]+)"/),
            review_href: grab(/<a href="([^"]+)" class="product-card__review"/) || null,
        };

        // Only keep a url override when the hand-written link carries tracking
        // parameters. A bare href must never win over Linktree's tracked URL.
        if (ctaHref.includes('?')) {
            entry.url = ctaHref;
        }

        enrichment[key] = entry;
    }

    return enrichment;
}

// ── HTML Generators ─────────────────────────────────────────────────────────

/**
 * Enrichment values are authored HTML (they carry &mdash; etc.) and must not be
 * escaped again. Linktree values are plain text and must be escaped.
 */
function generateCard(item, enrichment, index) {
    const e = enrichment[item.key] || {};

    const href = e.url || item.url;
    const image = e.image || item.thumbnail || '';
    const brandHtml = e.brand || '';
    const titleHtml = e.display_title || escapeHtml(item.title);
    const descHtml = e.description || escapeHtml(item.description || '');

    const labelText = decodeEntities([brandHtml, titleHtml].filter(Boolean).join(' '));
    const alt = escapeHtml(labelText);
    const comment = labelText.replace(/--+/g, '-');

    const lines = [];
    lines.push(`            <!-- ${index + 1}. ${comment} -->`);
    lines.push('            <div class="product-card reveal">');
    if (image) {
        lines.push('                <div class="product-card__img-wrap">');
        lines.push(`                    <img class="product-card__img" src="${escapeHtml(image)}" alt="${alt}" loading="lazy">`);
        lines.push('                </div>');
    }
    lines.push('                <div class="product-card__body">');
    if (brandHtml) {
        lines.push(`                    <p class="product-card__brand">${brandHtml}</p>`);
    }
    lines.push(`                    <h3 class="product-card__title">${titleHtml}</h3>`);
    if (descHtml) {
        lines.push(`                    <p class="product-card__desc">${descHtml}</p>`);
    }
    if (item.code) {
        lines.push('                    <div class="product-card__discount">');
        lines.push(`                        <span class="product-card__code">Use code: ${escapeHtml(item.code)}</span>`);
        lines.push('                    </div>');
    }
    lines.push('                    <div class="product-card__actions">');
    lines.push(`                        <a href="${escapeHtml(href)}" class="btn btn--teal" target="_blank" rel="sponsored noopener">Shop now &rarr;</a>`);
    if (e.review_href) {
        lines.push(`                        <a href="${escapeHtml(e.review_href)}" class="product-card__review">Read the review &rarr;</a>`);
    }
    lines.push('                    </div>');
    lines.push('                </div>');
    lines.push('            </div>');

    return lines.join('\n');
}

/**
 * Structured data is JSON, not HTML — entities must be decoded back to real characters.
 */
function generateSchema(items, enrichment) {
    const list = {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        'name': 'Wellness Tools & Products — Curated by Yvonne',
        'description': 'Thoughtfully curated wellness products I personally use — water filters, superfoods, grounding mats, and more. Exclusive discount codes included.',
        'url': 'https://holistiqueuk.com/wellness-tools.html',
        'numberOfItems': items.length,
        'itemListElement': items.map((item, i) => {
            const e = enrichment[item.key] || {};
            const url = e.url || item.url;
            const name = decodeEntities(e.display_title || item.title);
            const product = {
                '@type': 'Product',
                'name': name,
                'brand': { '@type': 'Brand', 'name': decodeEntities(e.brand) || name },
                'description': decodeEntities(e.description) || item.description || name,
                'image': e.image || item.thumbnail || '',
                'url': url,
                'offers': {
                    '@type': 'Offer',
                    'availability': 'https://schema.org/InStock',
                    'url': url,
                },
            };
            return { '@type': 'ListItem', 'position': i + 1, 'item': product };
        }),
    };

    const json = JSON.stringify(list, null, 4)
        .split('\n')
        .map(line => '    ' + line)
        .join('\n');

    return '    <script type="application/ld+json">\n' + json + '\n    </script>';
}

// ── Main Sync Logic ─────────────────────────────────────────────────────────

async function main() {
    const seedMode = process.argv.includes('--seed');

    if (!fs.existsSync(PAGE_PATH)) {
        console.error(`wellness-tools.html not found at ${PAGE_PATH}`);
        process.exit(1);
    }

    // Load or create manifest (enrichment is never pruned).
    let manifest = { synced_at: null, items: [], enrichment: {} };
    const manifestExisted = fs.existsSync(MANIFEST_PATH);
    if (manifestExisted) {
        manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
        manifest.enrichment = manifest.enrichment || {};
        manifest.items = manifest.items || [];
    }

    const pageHtml = fs.readFileSync(PAGE_PATH, 'utf8');

    // ── Seed mode: harvest existing hand-written cards, write manifest, stop ────

    if (seedMode) {
        const seeded = seedEnrichmentFromPage(pageHtml);
        const keys = Object.keys(seeded);
        if (keys.length === 0) {
            console.error('Seed failed: no product cards found in wellness-tools.html.');
            process.exit(1);
        }
        manifest.enrichment = Object.assign({}, manifest.enrichment, seeded);
        manifest.synced_at = manifest.synced_at || null;
        fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
        console.log(`Seeded ${keys.length} enrichment entrie(s): ${keys.join(', ')}`);
        console.log(`  ${keys.filter(k => seeded[k].url).length} carried a tracked url; ${keys.filter(k => seeded[k].review_href).length} carried a review link.`);
        return;
    }

    // ── Fetch and parse ─────────────────────────────────────────────────────

    console.log(`Fetching ${LINKTREE_URL} ...`);
    let html;
    try {
        html = await fetchHtml(LINKTREE_URL);
    } catch (err) {
        console.error('Failed to fetch Linktree page:', err.message);
        process.exit(1);
    }

    let links;
    try {
        links = getLinkArray(extractNextData(html));
    } catch (err) {
        console.error('Failed to parse Linktree page:', err.message);
        process.exit(1);
    }

    const items = selectProductLinks(links).map(toItem).filter(item => item.key);

    if (items.length < MIN_ITEMS) {
        console.error(`Refusing to write: parsed only ${items.length} item(s), expected at least ${MIN_ITEMS}.`);
        console.error('Linktree markup may have changed. No files written.');
        process.exit(1);
    }
    console.log(`  Parsed ${items.length} product link(s).`);

    // ── Render, verifying both marker pairs before writing anything ──────────

    const enrichment = manifest.enrichment;
    const cardsHtml = items.map((item, i) => generateCard(item, enrichment, i)).join('\n\n');
    const schemaHtml = generateSchema(items, enrichment);

    const withCards = replaceSection(pageHtml, CARD_START, CARD_END, cardsHtml);
    if (!withCards) {
        console.error(`Could not find ${CARD_START} / ${CARD_END} markers in wellness-tools.html. No files written.`);
        process.exit(1);
    }

    const withSchema = replaceSection(withCards, SCHEMA_START, SCHEMA_END, schemaHtml);
    if (!withSchema) {
        console.error(`Could not find ${SCHEMA_START} / ${SCHEMA_END} markers in wellness-tools.html. No files written.`);
        process.exit(1);
    }

    // ── Write ───────────────────────────────────────────────────────────────

    const itemsChanged = JSON.stringify(items) !== JSON.stringify(manifest.items);
    const htmlChanged = withSchema !== pageHtml;

    if (htmlChanged) {
        fs.writeFileSync(PAGE_PATH, withSchema, 'utf8');
        console.log('  Updated wellness-tools.html.');
    } else {
        console.log('  wellness-tools.html already up to date.');
    }

    // Only rewrite the manifest when the item data itself differs. synced_at is
    // deliberately left untouched otherwise, so an unchanged run produces no file
    // writes at all and the workflow has nothing to commit.
    if (itemsChanged || !manifestExisted) {
        manifest.synced_at = new Date().toISOString();
        manifest.items = items;
        manifest.enrichment = enrichment;
        fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
        console.log('Manifest updated.');
    } else {
        console.log('No changes — linktree-manifest.json is already up to date (synced_at left as-is).');
    }

    console.log(`WELLNESS_TOOLS_CHANGED=${itemsChanged}`);

    const missing = items.filter(i => !enrichment[i.key]).map(i => i.key);
    if (missing.length) {
        console.log(`  Note: no enrichment yet for ${missing.join(', ')} (rendering Linktree fallbacks).`);
    }

    console.log(`Sync complete! ${items.length} wellness tool(s).`);
}

main().catch(err => {
    console.error('Sync failed:', err);
    process.exit(1);
});
