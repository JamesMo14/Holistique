/**
 * Medium → Holistique UK Blog Sync
 *
 * Fetches the RSS feed from Medium, detects new posts not yet in posts-manifest.json,
 * generates individual HTML post pages, and inserts article cards into blog-post.html.
 *
 * Run: node scripts/sync-medium.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'posts-manifest.json');
const BLOG_LIST_PATH = path.join(ROOT, 'blog-post.html');
const RSS_URL = 'https://medium.com/feed/@yvonne.holistique';

// ─── Helpers ────────────────────────────────────────────────────────────────

function fetch(url) {
    return new Promise((resolve, reject) => {
        const doRequest = (requestUrl) => {
            https.get(requestUrl, { headers: { 'User-Agent': 'HolistiqueSync/1.0' } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    doRequest(res.headers.location);
                    return;
                }
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
            }).on('error', reject);
        };
        doRequest(url);
    });
}

function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function decodeHtmlEntities(str) {
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&mdash;/g, '\u2014')
        .replace(/&hellip;/g, '\u2026')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

// ─── RSS Parsing (basic XML extraction, no dependencies) ────────────────────

function extractItems(xml) {
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
        const block = match[1];
        const get = (tag) => {
            const m = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
            return m ? decodeHtmlEntities((m[1] || m[2] || '').trim()) : '';
        };

        const title = get('title');
        const link = get('link');
        const pubDate = get('pubDate');
        const contentEncoded = (() => {
            const m = block.match(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/);
            return m ? m[1] : '';
        })();
        const categories = [];
        const catRegex = /<category><!\[CDATA\[([\s\S]*?)\]\]><\/category>|<category>([^<]*)<\/category>/g;
        let cm;
        while ((cm = catRegex.exec(block)) !== null) {
            categories.push((cm[1] || cm[2] || '').trim());
        }

        items.push({ title, link, pubDate, contentEncoded, categories });
    }
    return items;
}

// ─── Content Processing ─────────────────────────────────────────────────────

function extractHeroImage(html) {
    // Look for first <img> or <figure> image in the content
    const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/);
    if (imgMatch) {
        let src = imgMatch[1];
        // Upgrade to full-width Medium image
        src = src.replace(/\/resize:fit:\d+\//, '/resize:fit:1400/');
        return src;
    }
    return '';
}

function extractCardImage(html) {
    const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/);
    if (imgMatch) {
        let src = imgMatch[1];
        src = src.replace(/\/resize:fit:\d+\//, '/resize:fit:700/');
        return src;
    }
    return '';
}

function extractExcerpt(html) {
    // Get first <p> text content
    const pMatch = html.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    if (pMatch) {
        let text = pMatch[1].replace(/<[^>]+>/g, '');
        text = decodeHtmlEntities(text).trim();
        if (text.length > 160) text = text.substring(0, 157) + '...';
        return text;
    }
    return '';
}

function extractSubtitle(html) {
    // Medium often uses <h4> as subtitle or <blockquote> at the start
    const h4Match = html.match(/<h4[^>]*>([\s\S]*?)<\/h4>/);
    if (h4Match) {
        return h4Match[1].replace(/<[^>]+>/g, '').trim();
    }
    // Fallback: use first paragraph as excerpt-style subtitle
    const excerpt = extractExcerpt(html);
    return excerpt;
}

function cleanBodyHtml(html) {
    // Remove the first image (it becomes the hero)
    let body = html.replace(/<figure[\s\S]*?<\/figure>/, '');
    // If no figure, remove first standalone img
    if (body === html) {
        body = html.replace(/<img[^>]*>/, '');
    }

    // Clean up Medium-specific markup
    body = body
        // Remove empty paragraphs
        .replace(/<p[^>]*>\s*<\/p>/g, '')
        // Remove Medium's data attributes
        .replace(/ data-[a-z-]+="[^"]*"/g, '')
        // Remove class attributes (we use our own styles)
        .replace(/ class="[^"]*"/g, '')
        // Remove id attributes
        .replace(/ id="[^"]*"/g, '')
        // Clean up figure/figcaption into simple images
        .replace(/<figure[^>]*>([\s\S]*?)<\/figure>/g, (_, inner) => {
            const imgM = inner.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/);
            const capM = inner.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/);
            if (imgM) {
                let result = `<img src="${imgM[1]}" alt="">`;
                if (capM) result += `\n<p><em>${capM[1].replace(/<[^>]+>/g, '')}</em></p>`;
                return result;
            }
            return inner;
        })
        // Convert h3 to h2 (Medium uses h3 for sections)
        .replace(/<h3/g, '<h2').replace(/<\/h3>/g, '</h2>')
        // Add separator divs between major sections
        .trim();

    return body;
}

function estimateReadTime(html) {
    const text = html.replace(/<[^>]+>/g, '');
    const words = text.split(/\s+/).filter(w => w.length > 0).length;
    return Math.max(2, Math.ceil(words / 200));
}

function formatDate(dateStr) {
    const d = new Date(dateStr);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function pickCategory(categories) {
    // Filter out generic Medium tags
    const skip = ['medium', 'blog', 'writing', 'life', 'self', 'culture'];
    const filtered = categories.filter(c => !skip.includes(c.toLowerCase()));
    if (filtered.length > 0) {
        // Capitalize nicely
        return filtered[0].split(/[\s-]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    }
    return 'Journal';
}

// ─── HTML Generators ────────────────────────────────────────────────────────

function generatePostHtml({ title, subtitle, category, date, readTime, heroImage, bodyHtml }) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)} — Holistique UK</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Marcellus&family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
    <style>
        *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
        html { font-size: 16px; -webkit-font-smoothing: antialiased; }
        body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-weight: 300; font-size: 18px; background: #FFFFFF; color: #111827; line-height: 1.8; overflow-x: hidden; opacity: 0; transition: opacity 0.6s ease; }
        body.loaded { opacity: 1; }
        a { text-decoration: none; color: inherit; } img { display: block; max-width: 100%; }
        .site-header { position: sticky; top: 0; z-index: 100; height: 80px; background: #FFFFFF; border-bottom: 1px solid #E5E7EB; display: flex; align-items: center; }
        .header-inner { display: flex; align-items: center; justify-content: space-between; width: 100%; max-width: 1280px; margin: 0 auto; padding: 0 32px; }
        .header-logo a { font-family: 'Inter', sans-serif; font-weight: 500; font-size: 14px; text-transform: uppercase; letter-spacing: 0.2em; color: #111827; transition: opacity 200ms; }
        .header-logo a:hover { opacity: 0.7; }
        .header-nav { display: flex; align-items: center; gap: 32px; }
        .header-nav a { font-family: 'Inter', sans-serif; font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em; color: #9CA3AF; transition: color 200ms; }
        .header-nav a:hover { color: #111827; }
        .article-hero { width: 100%; max-height: 560px; overflow: hidden; }
        .article-hero img { width: 100%; height: 560px; object-fit: cover; }
        .article-container { max-width: 720px; margin: 0 auto; padding: 48px 32px 80px; }
        .article-category { display: inline-block; background: #F3F4F6; padding: 4px 12px; font-family: 'Inter', sans-serif; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: #111827; }
        .article-title { font-family: 'Marcellus', Georgia, serif; font-size: clamp(2rem, 5vw, 3rem); line-height: 1.15; margin-top: 16px; color: #111827; }
        .article-subtitle { font-weight: 300; font-size: 1.25rem; color: #6B7280; margin-top: 16px; line-height: 1.5; padding-left: 16px; border-left: 2px solid #E5E7EB; }
        .article-meta { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #9CA3AF; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 24px; padding-bottom: 32px; border-bottom: 1px solid #E5E7EB; }
        .article-body { margin-top: 40px; }
        .article-body p { margin-bottom: 24px; font-size: 18px; line-height: 1.8; color: #374151; }
        .article-body p strong { font-weight: 600; color: #111827; }
        .article-body p em { font-style: italic; color: #6B7280; }
        .article-body h2 { font-family: 'Marcellus', Georgia, serif; font-size: 1.75rem; margin: 48px 0 24px; color: #111827; line-height: 1.2; }
        .article-body ul { margin: 0 0 24px 0; padding-left: 0; list-style: none; }
        .article-body ul li { padding: 8px 0 8px 24px; position: relative; font-size: 18px; line-height: 1.8; color: #374151; }
        .article-body ul li::before { content: ''; position: absolute; left: 0; top: 18px; width: 6px; height: 6px; background: #111827; border-radius: 50%; }
        .article-body blockquote { margin: 32px 0; padding: 24px 32px; border-left: 3px solid #111827; background: #F9FAFB; font-style: italic; color: #374151; }
        .article-body .separator { text-align: center; margin: 48px 0; color: #D1D5DB; font-size: 1.5rem; letter-spacing: 0.5em; }
        .article-body a { color: #111827; text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1px; }
        .article-body a:hover { color: #6B7280; }
        .author-bio { margin-top: 64px; padding-top: 32px; border-top: 1px solid #E5E7EB; font-size: 15px; color: #6B7280; line-height: 1.7; }
        .back-link { display: inline-block; margin-top: 48px; font-family: 'Inter', sans-serif; font-weight: 500; font-size: 13px; text-transform: uppercase; letter-spacing: 0.1em; color: #9CA3AF; transition: color 200ms; }
        .back-link:hover { color: #111827; }
        .back-link::before { content: '\\2190\\00a0\\00a0'; }
        .article-newsletter { margin-top: 48px; padding: 32px; border: 2px solid #111827; text-align: center; }
        .article-newsletter__heading { font-family: 'Inter', sans-serif; font-weight: 500; font-size: 15px; color: #111827; margin-bottom: 4px; }
        .article-newsletter__sub { font-size: 14px; color: #6B7280; margin-bottom: 16px; }
        .article-newsletter__row { display: flex; gap: 8px; }
        .article-newsletter__row .newsletter-input { flex: 1; border: 1px solid #E5E7EB; background: #F9FAFB; padding: 12px; font-family: 'Inter', sans-serif; font-size: 14px; font-weight: 300; color: #111827; }
        .article-newsletter__row .newsletter-input::placeholder { color: #9CA3AF; }
        .article-newsletter__row .newsletter-btn { background: #111827; color: #FFFFFF; text-transform: uppercase; letter-spacing: 0.1em; font-family: 'Inter', sans-serif; font-weight: 500; font-size: 12px; padding: 12px 24px; border: none; cursor: pointer; transition: background 200ms; white-space: nowrap; }
        .article-newsletter__row .newsletter-btn:hover { background: #000000; }
        .article-newsletter__row .newsletter-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .newsletter-message { margin-top: 8px; font-size: 13px; text-align: center; }
        .newsletter-message.success { color: #059669; }
        .newsletter-message.error { color: #DC2626; }
        @media (max-width: 480px) { .article-newsletter__row { flex-direction: column; } }
        .site-footer { background: #F9FAFB; border-top: 1px solid #E5E7EB; padding: 32px 0; }
        .footer-inner { display: flex; justify-content: space-between; align-items: center; max-width: 1280px; margin: 0 auto; padding: 0 32px; }
        .footer-copy { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #9CA3AF; text-transform: uppercase; letter-spacing: 0.1em; }
        .footer-social { display: flex; gap: 20px; }
        .footer-social a { display: flex; align-items: center; color: #9CA3AF; transition: color 200ms; }
        .footer-social a:hover { color: #111827; }
        .footer-social svg { width: 20px; height: 20px; }
        @media (max-width: 768px) { .header-inner { padding: 0 20px; } .article-container { padding: 32px 20px 64px; } .article-hero img { height: 320px; } .footer-inner { padding: 0 20px; } }
        @media (max-width: 480px) { .header-inner { padding: 0 16px; } .header-nav { gap: 20px; } .article-container { padding: 24px 16px 48px; } .article-hero img { height: 240px; } .footer-inner { flex-direction: column; gap: 16px; padding: 0 16px; } }
    </style>
</head>
<body>
    <header class="site-header"><div class="header-inner"><div class="header-logo"><a href="index.html">HOLISTIQUE</a></div><nav class="header-nav"><a href="index.html">Home</a><a href="blog.html">Journal</a><a href="#">About</a></nav></div></header>

    <div class="article-hero">
        <img src="${heroImage}" alt="${escapeHtml(title)}">
    </div>

    <article class="article-container">
        <span class="article-category">${escapeHtml(category)}</span>
        <h1 class="article-title">${escapeHtml(title)}</h1>
        <p class="article-subtitle">${escapeHtml(subtitle)}</p>
        <p class="article-meta">By Yvonne &middot; ${date} &middot; ${readTime} Min Read</p>

        <div class="article-body">
            ${bodyHtml}
        </div>

        <div class="author-bio">
            <p>Yvonne is a former model turned acupuncturist and sound healer. Today she organises holistic events and retreats for her community of conscious souls in London. You can find her on Instagram: <a href="https://instagram.com/yvonne.holistique/" target="_blank">@yvonne.holistique</a></p>
        </div>

        <div class="article-newsletter">
            <p class="article-newsletter__heading">Enjoyed this article?</p>
            <p class="article-newsletter__sub">Get new posts from Yvonne delivered to your inbox.</p>
            <form id="newsletter-form" onsubmit="return false;">
                <div class="article-newsletter__row">
                    <input type="email" class="newsletter-input" placeholder="Your email address" required>
                    <button type="submit" class="newsletter-btn">Subscribe</button>
                </div>
            </form>
        </div>

        <a href="blog-post.html" class="back-link">Back to Journal</a>
    </article>

    <footer class="site-footer"><div class="footer-inner"><span class="footer-copy">&copy; 2025 Holistique UK</span><div class="footer-social"><a href="https://instagram.com/yvonne.holistique/" target="_blank" aria-label="Instagram"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5"></rect><circle cx="12" cy="12" r="5"></circle><circle cx="17.5" cy="6.5" r="1.5" fill="currentColor" stroke="none"></circle></svg></a><a href="https://medium.com/@yvonne.holistique" target="_blank" aria-label="Medium"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.54 12a6.8 6.8 0 01-6.77 6.82A6.8 6.8 0 010 12a6.8 6.8 0 016.77-6.82A6.8 6.8 0 0113.54 12zM20.96 12c0 3.54-1.51 6.42-3.38 6.42-1.87 0-3.39-2.88-3.39-6.42s1.52-6.42 3.39-6.42 3.38 2.88 3.38 6.42M24 12c0 3.17-.53 5.75-1.19 5.75-.66 0-1.19-2.58-1.19-5.75s.53-5.75 1.19-5.75C23.47 6.25 24 8.83 24 12z"/></svg></a></div></div></footer>

    <script>
    window.addEventListener('DOMContentLoaded', function() {
        document.body.classList.add('loaded');
        var SUBSCRIBE_URL = 'https://peter17tu.app.n8n.cloud/webhook/subscribe';
        var nlForm = document.getElementById('newsletter-form');
        if (nlForm) {
            nlForm.addEventListener('submit', function(e) {
                e.preventDefault();
                var input = nlForm.querySelector('.newsletter-input');
                var btn = nlForm.querySelector('.newsletter-btn');
                var email = input.value.trim();
                if (!email || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
                    showMsg(nlForm, 'Please enter a valid email address.', 'error'); return;
                }
                if (!SUBSCRIBE_URL) { showMsg(nlForm, 'Subscribe is not configured yet.', 'error'); return; }
                btn.textContent = 'Subscribing...'; btn.disabled = true;
                fetch(SUBSCRIBE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email }) })
                .then(function(r) { return r.json(); })
                .then(function(d) {
                    if (d.success) { showMsg(nlForm, 'Welcome aboard! Check your inbox.', 'success'); input.value = ''; }
                    else { showMsg(nlForm, d.error || 'Something went wrong.', 'error'); }
                })
                .catch(function() { showMsg(nlForm, 'Network error. Please try again.', 'error'); })
                .finally(function() { btn.textContent = 'Subscribe'; btn.disabled = false; });
            });
        }
        function showMsg(form, text, type) {
            var ex = form.querySelector('.newsletter-message'); if (ex) ex.remove();
            var m = document.createElement('p'); m.className = 'newsletter-message ' + type; m.textContent = text;
            form.appendChild(m); setTimeout(function() { if (m.parentNode) m.remove(); }, 5000);
        }
    });
    </script>
</body>
</html>
`;
}

function generateCardHtml({ number, title, category, excerpt, readTime, date, cardImage }) {
    return `
                        <!-- Card ${number} (auto-synced) -->
                        <a href="post-${number}.html" class="article-card">
                            <img class="card-img" src="${cardImage}" alt="${escapeHtml(title)}">
                            <span class="card-category">${escapeHtml(category)}</span>
                            <h3 class="card-title">${escapeHtml(title)}</h3>
                            <p class="card-excerpt">${escapeHtml(excerpt)}</p>
                            <span class="card-meta">${readTime} Min Read &middot; ${date}</span>
                        </a>`;
}

// ─── Main Sync Logic ────────────────────────────────────────────────────────

async function main() {
    console.log('Fetching Medium RSS feed...');
    let xml;
    try {
        xml = await fetch(RSS_URL);
    } catch (err) {
        console.error('Failed to fetch RSS feed:', err.message);
        process.exit(1);
    }

    const items = extractItems(xml);
    console.log(`Found ${items.length} items in RSS feed.`);

    // Load manifest
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const existingTitles = new Set(manifest.posts.map(p => p.title.toLowerCase()));
    const existingUrls = new Set(manifest.posts.map(p => {
        // Normalize URL: strip query params and trailing slashes
        try {
            const u = new URL(p.mediumUrl);
            return u.pathname.replace(/\/$/, '');
        } catch {
            return p.mediumUrl;
        }
    }));

    // Filter to new posts only
    const newItems = items.filter(item => {
        const titleLower = item.title.toLowerCase();
        let pathName = '';
        try {
            pathName = new URL(item.link).pathname.replace(/\/$/, '');
        } catch {
            pathName = item.link;
        }
        return !existingTitles.has(titleLower) && !existingUrls.has(pathName);
    });

    if (newItems.length === 0) {
        console.log('No new posts found. Everything is up to date.');
        return;
    }

    console.log(`Found ${newItems.length} new post(s) to sync.`);

    let nextNumber = manifest.lastPostNumber;
    const newCards = [];

    for (const item of newItems) {
        nextNumber++;
        const category = pickCategory(item.categories);
        const date = formatDate(item.pubDate);
        const heroImage = extractHeroImage(item.contentEncoded);
        const cardImage = extractCardImage(item.contentEncoded);
        const subtitle = extractSubtitle(item.contentEncoded);
        const excerpt = extractExcerpt(item.contentEncoded);
        const bodyHtml = cleanBodyHtml(item.contentEncoded);
        const readTime = estimateReadTime(item.contentEncoded);

        // Generate and write post HTML
        const postHtml = generatePostHtml({
            title: item.title,
            subtitle,
            category,
            date,
            readTime,
            heroImage,
            bodyHtml
        });

        const postFile = `post-${nextNumber}.html`;
        const postPath = path.join(ROOT, postFile);
        fs.writeFileSync(postPath, postHtml, 'utf8');
        console.log(`  Created ${postFile}: "${item.title}"`);

        // Generate card HTML for blog list page
        newCards.push(generateCardHtml({
            number: nextNumber,
            title: item.title,
            category,
            excerpt,
            readTime,
            date,
            cardImage
        }));

        // Update manifest
        manifest.posts.push({
            number: nextNumber,
            title: item.title,
            mediumUrl: item.link,
            file: postFile,
            date,
            category
        });
    }

    manifest.lastPostNumber = nextNumber;

    // Insert new cards into blog-post.html
    // Insert right after the opening of article-grid, before the first existing card
    let blogHtml = fs.readFileSync(BLOG_LIST_PATH, 'utf8');
    const insertMarker = '<div class="article-grid">';
    const insertIdx = blogHtml.indexOf(insertMarker);
    if (insertIdx !== -1) {
        const insertPos = insertIdx + insertMarker.length;
        const cardsHtml = newCards.join('\n');
        blogHtml = blogHtml.slice(0, insertPos) + '\n' + cardsHtml + blogHtml.slice(insertPos);
        fs.writeFileSync(BLOG_LIST_PATH, blogHtml, 'utf8');
        console.log(`  Updated blog-post.html with ${newCards.length} new card(s).`);
    } else {
        console.warn('  Warning: Could not find article-grid in blog-post.html. Cards not inserted.');
    }

    // Save manifest
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log('Manifest updated.');
    console.log(`Sync complete! ${newItems.length} new post(s) added.`);
}

main().catch(err => {
    console.error('Sync failed:', err);
    process.exit(1);
});
