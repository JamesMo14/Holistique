/**
 * Eventbrite + Dandelion -> Holistique UK Events Sync
 *
 * Fetches upcoming events from Eventbrite and Dandelion, merges them into one
 * deduplicated list (Dandelion is the preferred booking link), fetches past events
 * from Eventbrite, updates events-manifest.json, and injects event cards into
 * events.html and index.html.
 *
 * Either source may fail on its own and the sync carries on with the other; it
 * exits 1 only if both are unavailable. Past events always come from Eventbrite and
 * are left as they are when Eventbrite is unavailable.
 *
 * Run: node scripts/sync-events.js
 *
 * Env vars (Eventbrite only — Dandelion needs no auth):
 *   EVENTBRITE_TOKEN   — Eventbrite private API token
 *   EVENTBRITE_ORG_ID  — Eventbrite organization ID
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'events-manifest.json');
const EVENTS_PAGE_PATH = path.join(ROOT, 'events.html');
const INDEX_PATH = path.join(ROOT, 'index.html');

const TOKEN = process.env.EVENTBRITE_TOKEN;
const ORG_ID = process.env.EVENTBRITE_ORG_ID;

const DANDELION_URL = 'https://dandelion.events/o/holistique/events.json';
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LONDON_TZ = 'Europe/London';
const REQUEST_TIMEOUT_MS = 20000;
const SITE_URL = 'https://holistiqueuk.com';

// Upcoming event images are self-hosted here (the sync owns this folder).
const EVENT_PHOTOS_PATH = 'photos/events';
const EVENT_PHOTOS_DIR = path.join(ROOT, EVENT_PHOTOS_PATH);
const IMAGE_TIMEOUT_MS = 15000;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_EXTENSIONS = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

// ── Fallback Images ─────────────────────────────────────────────────────────

const FALLBACK_IMAGES = [
    { keywords: ['sound', 'gong'], url: 'https://images.unsplash.com/photo-1591228127791-8e2eaef098d3?w=600&h=400&fit=crop&q=80' },
    { keywords: ['breath'], url: 'https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?w=600&h=400&fit=crop&q=80' },
    { keywords: ['meditat'], url: 'https://images.unsplash.com/photo-1506126613408-eca07ce68773?w=600&h=400&fit=crop&q=80' },
    { keywords: ['yoga'], url: 'https://images.unsplash.com/photo-1575052814086-f385e2e2ad1b?w=600&h=400&fit=crop&q=80' },
];
const DEFAULT_FALLBACK = 'https://images.unsplash.com/photo-1545389336-cf090694435e?w=600&h=400&fit=crop&q=80';

// ── Helpers ─────────────────────────────────────────────────────────────────

function fetchJson(url, headers) {
    return new Promise((resolve, reject) => {
        const doRequest = (requestUrl) => {
            const req = https.get(requestUrl, { headers }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    doRequest(res.headers.location);
                    return;
                }
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error(`Invalid JSON response: ${e.message}`));
                    }
                });
            });
            req.setTimeout(REQUEST_TIMEOUT_MS, () => {
                req.destroy(new Error(`Timed out after ${REQUEST_TIMEOUT_MS}ms`));
            });
            req.on('error', reject);
        };
        doRequest(url);
    });
}

/**
 * Fetch all pages of events for a given status query.
 */
async function fetchAllEvents(status) {
    const events = [];
    let url = `https://www.eventbriteapi.com/v3/organizations/${ORG_ID}/events/?status=${status}&expand=venue,logo&order_by=start_${status === 'ended' ? 'desc' : 'asc'}`;

    while (url) {
        const data = await fetchJson(url, {
            'Authorization': `Bearer ${TOKEN}`,
            'User-Agent': 'HolistiqueSync/1.0',
        });
        if (data.events) {
            events.push(...data.events);
        }
        if (data.pagination && data.pagination.has_more_items && data.pagination.continuation) {
            // Eventbrite uses continuation tokens
            const sep = url.includes('?') ? '&' : '?';
            // Strip any existing continuation param first
            const baseUrl = url.replace(/[&?]continuation=[^&]*/, '');
            url = baseUrl + (baseUrl.includes('?') ? '&' : '?') + `continuation=${data.pagination.continuation}`;
        } else {
            url = null;
        }
    }

    return events;
}

function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDateTime(isoStr) {
    if (!isoStr) return '';
    // isoStr is like "2026-02-15T19:00:00"
    const parts = isoStr.split('T');
    const dateParts = parts[0].split('-');
    const timeParts = parts[1] ? parts[1].split(':') : ['0', '0'];

    const year = parseInt(dateParts[0], 10);
    const month = parseInt(dateParts[1], 10) - 1;
    const day = parseInt(dateParts[2], 10);
    let hours = parseInt(timeParts[0], 10);
    const minutes = timeParts[1];

    const ampm = hours >= 12 ? 'PM' : 'AM';
    if (hours === 0) hours = 12;
    else if (hours > 12) hours -= 12;

    return `${MONTHS[month]} ${day}, ${year} &middot; ${hours}:${minutes} ${ampm}`;
}

function getEventImage(event) {
    // Try logo.original.url first, then logo.url
    if (event.logo) {
        if (event.logo.original && event.logo.original.url) return event.logo.original.url;
        if (event.logo.url) return event.logo.url;
    }

    return fallbackImage(event.name && event.name.text);
}

// Fallback based on event name keywords
function fallbackImage(name) {
    const nameLower = (name || '').toLowerCase();
    for (const fb of FALLBACK_IMAGES) {
        if (fb.keywords.some(kw => nameLower.includes(kw))) {
            return fb.url;
        }
    }
    return DEFAULT_FALLBACK;
}

function getEventLocation(event) {
    if (event.venue && event.venue.address && event.venue.address.city) {
        return event.venue.address.city;
    }
    if (event.venue && event.venue.name) {
        return event.venue.name;
    }
    return 'Online';
}

// ── Dandelion & merging ─────────────────────────────────────────────────────

async function fetchDandelionEvents() {
    const data = await fetchJson(DANDELION_URL, {
        'User-Agent': BROWSER_USER_AGENT,
        'Accept': 'application/json',
    });
    if (!Array.isArray(data)) {
        throw new Error('Expected a JSON array of events');
    }
    return data;
}

const LONDON_PARTS = new Intl.DateTimeFormat('en-GB', {
    timeZone: LONDON_TZ,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/**
 * Dandelion timestamps can carry a non-UK offset (e.g. "-05:00", with the real zone in
 * time_zone). The offset still pins an exact instant, so parse it and re-express it as
 * London wall-clock time in Eventbrite's start.local shape ("YYYY-MM-DDTHH:MM:SS"), which
 * formatDateTime() already renders.
 */
function toLondonLocal(isoStr) {
    const ms = Date.parse(isoStr);
    if (Number.isNaN(ms)) return '';
    const p = {};
    for (const part of LONDON_PARTS.formatToParts(new Date(ms))) p[part.type] = part.value;
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

const LONDON_OFFSET = new Intl.DateTimeFormat('en-GB', { timeZone: LONDON_TZ, timeZoneName: 'longOffset' });

// ISO 8601 with London's offset at that instant, e.g. "2026-10-10T19:00:00+01:00". Uses the
// exact instant when known, else finds the GMT/BST offset that reproduces the London time.
function londonIso(ms, londonLocal) {
    if (!Number.isNaN(ms)) {
        const zone = LONDON_OFFSET.formatToParts(new Date(ms)).find(p => p.type === 'timeZoneName').value;
        const offset = zone === 'GMT' ? '+00:00' : zone.replace('GMT', '');
        return toLondonLocal(new Date(ms).toISOString()) + offset;
    }
    if (!londonLocal) return '';
    for (const offset of ['+00:00', '+01:00']) {
        if (toLondonLocal(londonLocal + offset) === londonLocal) return londonLocal + offset;
    }
    return londonLocal;
}

function decodeEntities(str) {
    return String(str || '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&amp;/g, '&');
}

// Dandelion descriptions are HTML; turn block boundaries into spaces so paragraphs
// don't run together once the tags are gone.
function htmlToText(html) {
    return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function normaliseTitle(title) {
    return decodeEntities(title).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

const UK_POSTCODE = /\s*\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})$/i;

// "Colet House, Talgarth Road, London, UK" -> venue "Colet House", street "Talgarth Road",
// city "London", country "GB"
function splitDandelionLocation(location) {
    const parts = String(location || '').split(',').map(p => p.trim()).filter(Boolean)
        .filter((p, i, all) => i === 0 || p.toLowerCase() !== all[i - 1].toLowerCase());
    const venueName = parts[0] || null;
    let country = null;
    while (parts.length > 1 && /^(uk|united kingdom|england|great britain|gb)$/i.test(parts[parts.length - 1])) {
        parts.pop();
        country = 'GB';
    }
    let city = null;
    let postalCode = null;
    if (parts.length > 1) {
        const last = parts[parts.length - 1];
        const pc = last.match(UK_POSTCODE);
        postalCode = pc ? pc[1].toUpperCase() : null;
        city = last.replace(UK_POSTCODE, '').trim() || null;
    }
    const street = parts.length > 2 ? parts.slice(1, -1).join(', ') : null;
    return { venueName, city, address: { street, locality: city, postalCode, region: null, country } };
}

// Both sources are normalised to one shape. imageUrl is the event's own image (null if
// none); the keyword fallback is applied at render time so a pair can prefer a real one.
function fromEventbrite(event) {
    return {
        source: 'eventbrite',
        id: event.id,
        name: event.name ? event.name.text : 'Untitled Event',
        descriptionText: event.description ? event.description.text : '',
        url: event.url || '',
        startLocal: event.start ? event.start.local : '',
        endLocal: event.end ? event.end.local : '',
        startMs: event.start && event.start.utc ? Date.parse(event.start.utc) : NaN,
        endMs: event.end && event.end.utc ? Date.parse(event.end.utc) : NaN,
        venueName: event.venue ? event.venue.name : null,
        city: event.venue && event.venue.address ? event.venue.address.city : null,
        address: eventbriteAddress(event.venue && event.venue.address),
        imageUrl: event.logo ? ((event.logo.original && event.logo.original.url) || event.logo.url || null) : null,
        status: event.status,
    };
}

function eventbriteAddress(a) {
    if (!a) return { street: null, locality: null, postalCode: null, region: null, country: null };
    return {
        street: [a.address_1, a.address_2].filter(Boolean).join(', ') || null,
        locality: a.city || null,
        postalCode: a.postal_code || null,
        region: a.region || null,
        country: a.country || null,
    };
}

function fromDandelion(event) {
    const { venueName, city, address } = splitDandelionLocation(event.location);
    return {
        source: 'dandelion',
        id: event.id,
        name: decodeEntities(event.name).trim(),
        descriptionText: htmlToText(event.description),
        url: event.url || '',
        startLocal: toLondonLocal(event.start_time),
        endLocal: toLondonLocal(event.end_time),
        startMs: Date.parse(event.start_time),
        endMs: Date.parse(event.end_time),
        venueName,
        city,
        address,
        imageUrl: event.image || null,
        status: 'live',
    };
}

// One card per event: Dandelion's booking link, and Dandelion's fields wherever it has
// them, with gaps filled from the Eventbrite copy.
function combinePair(d, e) {
    const pick = field => (d[field] ? d[field] : e[field]);
    return {
        source: 'both',
        id: d.id,
        name: pick('name'),
        descriptionText: pick('descriptionText'),
        url: pick('url'),
        startLocal: pick('startLocal'),
        endLocal: pick('endLocal'),
        startMs: Number.isNaN(d.startMs) ? e.startMs : d.startMs,
        endMs: Number.isNaN(d.endMs) ? e.endMs : d.endMs,
        venueName: pick('venueName'),
        city: pick('city'),
        address: Object.fromEntries(Object.keys(d.address).map(k => [k, d.address[k] || e.address[k]])),
        imageUrl: pick('imageUrl'),
        status: e.status || d.status,
        eventbriteUrl: e.url,
        eventbriteName: e.name,
    };
}

/**
 * Union of both sources, deduplicated. A Dandelion and an Eventbrite event match on the
 * same start instant; failing that, on the same London calendar day where one normalised
 * title contains the other. Exact-instant pairs are taken first so a looser title match
 * can't claim an event that has an exact twin.
 */
function mergeUpcoming(dandelion, eventbrite) {
    const unmatchedD = dandelion.slice();
    const unmatchedE = eventbrite.slice();
    const pairs = [];

    const takePairs = (isMatch) => {
        for (let i = 0; i < unmatchedD.length; i++) {
            const j = unmatchedE.findIndex(e => isMatch(unmatchedD[i], e));
            if (j !== -1) {
                pairs.push(combinePair(unmatchedD[i], unmatchedE[j]));
                unmatchedD.splice(i--, 1);
                unmatchedE.splice(j, 1);
            }
        }
    };
    takePairs((d, e) => !Number.isNaN(d.startMs) && d.startMs === e.startMs);
    takePairs((d, e) => {
        if (!d.startLocal || d.startLocal.slice(0, 10) !== (e.startLocal || '').slice(0, 10)) return false;
        const a = normaliseTitle(d.name);
        const b = normaliseTitle(e.name);
        return a !== '' && b !== '' && (a.includes(b) || b.includes(a));
    });

    const upcoming = [...pairs, ...unmatchedD, ...unmatchedE]
        .sort((x, y) => (x.startLocal < y.startLocal ? -1 : x.startLocal > y.startLocal ? 1 : 0));
    for (const m of upcoming) {
        if (!m.name) m.name = 'Untitled Event';
    }
    return { upcoming, summary: { both: pairs, dandelion: unmatchedD, eventbrite: unmatchedE } };
}

function logSourceSummary(summary) {
    console.log(`Source summary: ${summary.both.length} matched pair(s), ${summary.dandelion.length} Dandelion-only, ${summary.eventbrite.length} Eventbrite-only.`);
    const when = m => (m.startLocal || '').replace('T', ' ').substring(0, 16);
    for (const m of summary.both) {
        const ebNote = m.eventbriteName && m.eventbriteName !== m.name ? `  (Eventbrite: ${m.eventbriteName})` : '';
        console.log(`  [matched]         ${when(m)}  ${m.name}${ebNote}`);
    }
    for (const m of summary.dandelion) console.log(`  [dandelion-only]  ${when(m)}  ${m.name}`);
    for (const m of summary.eventbrite) console.log(`  [eventbrite-only] ${when(m)}  ${m.name}`);
}

// ── Self-hosted event images ────────────────────────────────────────────────

/**
 * Download one image. Follows redirects, 15s timeout, 10 MB cap, and only accepts
 * JPEG/PNG/WebP. Resolves { ext, body }.
 */
function downloadImage(url) {
    return new Promise((resolve, reject) => {
        const doRequest = (requestUrl, redirectsLeft) => {
            let req;
            try {
                req = https.get(requestUrl, {
                    headers: { 'User-Agent': BROWSER_USER_AGENT, 'Accept': 'image/webp,image/png,image/jpeg,image/*;q=0.8' },
                }, (res) => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        res.resume();
                        if (redirectsLeft === 0) return reject(new Error('Too many redirects'));
                        doRequest(new URL(res.headers.location, requestUrl).toString(), redirectsLeft - 1);
                        return;
                    }
                    if (res.statusCode !== 200) {
                        res.resume();
                        return reject(new Error(`HTTP ${res.statusCode}`));
                    }
                    const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
                    const ext = IMAGE_EXTENSIONS[type];
                    if (!ext) {
                        res.resume();
                        return reject(new Error(`Unsupported Content-Type "${type}"`));
                    }
                    const chunks = [];
                    let size = 0;
                    res.on('data', chunk => {
                        size += chunk.length;
                        if (size > IMAGE_MAX_BYTES) {
                            req.destroy(new Error(`Larger than ${IMAGE_MAX_BYTES} bytes`));
                            return;
                        }
                        chunks.push(chunk);
                    });
                    res.on('end', () => {
                        if (size > IMAGE_MAX_BYTES) return;
                        if (size === 0) return reject(new Error('Empty response'));
                        resolve({ ext, body: Buffer.concat(chunks) });
                    });
                    res.on('error', reject);
                });
            } catch (err) {
                return reject(err);
            }
            req.setTimeout(IMAGE_TIMEOUT_MS, () => {
                req.destroy(new Error(`Timed out after ${IMAGE_TIMEOUT_MS}ms`));
            });
            req.on('error', reject);
        };
        doRequest(url, 5);
    });
}

function slugify(str) {
    return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Self-host every upcoming card's image as photos/events/<event id><ext>. Dandelion's
 * image CDN loads intermittently for real visitors, so hotlinking isn't reliable.
 *
 * An image is downloaded only when its file is missing or its source URL changed since
 * the last run (image_src in the manifest), so an unchanged run downloads nothing. A
 * failed download falls back to the remote URL for that card and is retried next run.
 * Files for events that are no longer upcoming are deleted.
 */
async function mirrorEventImages(events, previousUpcoming) {
    fs.mkdirSync(EVENT_PHOTOS_DIR, { recursive: true });
    const previous = new Map((previousUpcoming || []).map(e => [e.id, e]));
    const counts = { downloaded: 0, unchanged: 0, failed: 0, removed: 0 };

    for (const m of events) {
        m.imageSrc = m.imageUrl || fallbackImage(m.name);
        m.localImage = null;

        const prev = previous.get(m.id);
        if (prev && prev.image_src === m.imageSrc && typeof prev.imageUrl === 'string'
            && prev.imageUrl.startsWith(EVENT_PHOTOS_PATH + '/') && fs.existsSync(path.join(ROOT, prev.imageUrl))) {
            m.localImage = prev.imageUrl;
            counts.unchanged++;
            continue;
        }

        try {
            const stableId = slugify(m.id);
            if (!stableId) throw new Error('event has no id');
            const { ext, body } = await downloadImage(m.imageSrc);
            const localPath = `${EVENT_PHOTOS_PATH}/${stableId}${ext}`;
            const tmpFile = path.join(ROOT, localPath + '.tmp');
            fs.writeFileSync(tmpFile, body);
            fs.renameSync(tmpFile, path.join(ROOT, localPath));
            m.localImage = localPath;
            counts.downloaded++;
            console.log(`  Downloaded ${localPath} (${Math.round(body.length / 1024)} KB) for ${m.name}`);
        } catch (err) {
            counts.failed++;
            console.warn(`  Warning: image download failed for "${m.name}" (${m.imageSrc}): ${err.message}. Using the remote URL until the next run.`);
        }
    }

    const keep = new Set(events.filter(m => m.localImage).map(m => path.basename(m.localImage)));
    for (const file of fs.readdirSync(EVENT_PHOTOS_DIR)) {
        if (!keep.has(file)) {
            fs.unlinkSync(path.join(EVENT_PHOTOS_DIR, file));
            counts.removed++;
            console.log(`  Removed ${EVENT_PHOTOS_PATH}/${file} (no longer used by an upcoming event)`);
        }
    }

    console.log(`Event images: ${counts.downloaded} downloaded, ${counts.unchanged} unchanged, ${counts.failed} failed (remote fallback), ${counts.removed} removed.`);
}

// The image a card shows: the self-hosted copy, else the remote original.
function cardImage(m) {
    return m.localImage || m.imageUrl || fallbackImage(m.name);
}

// ── Event structured data ───────────────────────────────────────────────────

function absoluteUrl(url) {
    return /^https?:\/\//.test(url) ? url : `${SITE_URL}/${url.replace(/^\//, '')}`;
}

// One schema.org Event per upcoming card, for the JSON-LD block in events.html.
function eventJsonLd(m) {
    const a = m.address || {};
    const isInPerson = Boolean(m.venueName || a.street || a.locality);
    const postal = { '@type': 'PostalAddress' };
    if (a.street) postal.streetAddress = a.street;
    if (a.locality) postal.addressLocality = a.locality;
    if (a.region) postal.addressRegion = a.region;
    if (a.postalCode) postal.postalCode = a.postalCode;
    if (a.country) postal.addressCountry = a.country;

    const ev = {
        '@context': 'https://schema.org',
        '@type': 'Event',
        name: m.name,
    };
    const description = truncateText(m.descriptionText, 300);
    if (description) ev.description = description;
    ev.startDate = londonIso(m.startMs, m.startLocal);
    const endDate = londonIso(m.endMs, m.endLocal);
    if (endDate) ev.endDate = endDate;
    ev.eventStatus = 'https://schema.org/EventScheduled';
    ev.eventAttendanceMode = isInPerson
        ? 'https://schema.org/OfflineEventAttendanceMode'
        : 'https://schema.org/OnlineEventAttendanceMode';
    ev.location = isInPerson
        ? { '@type': 'Place', name: m.venueName || a.locality, address: postal }
        : { '@type': 'VirtualLocation', url: m.url || SITE_URL };
    ev.image = absoluteUrl(cardImage(m));
    ev.organizer = { '@type': 'Organization', name: 'Holistique UK', url: SITE_URL };
    if (m.url) {
        ev.url = m.url;
        ev.offers = { '@type': 'Offer', url: m.url };
    }
    return ev;
}

// The <script> block that goes between the EVENTS-JSONLD markers. "<" is escaped so no
// event text can close the script element early.
function eventsJsonLdBlock(events) {
    if (events.length === 0) return '';
    const json = JSON.stringify(events.map(eventJsonLd), null, 4)
        .replace(/</g, '\\u003c')
        .split('\n').map(line => '    ' + line).join('\n');
    return `    <script type="application/ld+json">\n${json}\n    </script>`;
}

// Manifest entry for an upcoming event: the original Eventbrite fields plus its source.
// imageUrl is what the card shows; image_src is the remote original it was copied from.
function upcomingManifestEntry(m) {
    const entry = {
        id: m.id,
        name: m.name,
        description: truncateText(m.descriptionText, 150),
        url: m.url,
        startLocal: m.startLocal,
        endLocal: m.endLocal,
        venueName: m.venueName,
        city: m.city,
        imageUrl: cardImage(m),
        image_src: m.imageSrc || m.imageUrl || fallbackImage(m.name),
        status: m.status,
        source: m.source,
    };
    if (m.eventbriteUrl) entry.eventbriteUrl = m.eventbriteUrl;
    return entry;
}

function replaceSection(html, startMarker, endMarker, newContent) {
    const startIdx = html.indexOf(startMarker);
    const endIdx = html.indexOf(endMarker);
    if (startIdx === -1 || endIdx === -1) {
        return null; // markers not found
    }
    const before = html.substring(0, startIdx + startMarker.length);
    const after = html.substring(endIdx);
    return before + '\n' + newContent + '\n' + after;
}

// ── HTML Generators ─────────────────────────────────────────────────────────

// Upcoming cards take a normalised event (see fromEventbrite / fromDandelion).
function upcomingCardFields(m) {
    return {
        name: m.name,
        desc: truncateText(m.descriptionText, 150),
        dateStr: formatDateTime(m.startLocal),
        imageUrl: cardImage(m),
        location: m.city || m.venueName || 'Online',
        eventUrl: m.url || '#',
    };
}

function generateEventsPageUpcomingCard(event) {
    const { name, desc, dateStr, imageUrl, location, eventUrl } = upcomingCardFields(event);

    return `                    <a href="${escapeHtml(eventUrl)}" class="event-card reveal" target="_blank" rel="noopener">
                        <img class="event-card__img" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(name)}" loading="lazy">
                        <div class="event-card__body">
                            <p class="event-card__date">${dateStr}</p>
                            <h3 class="event-card__title">${escapeHtml(name)}</h3>
                            <p class="event-card__desc">${escapeHtml(desc)}</p>
                            <span class="event-card__tag">${escapeHtml(location)}</span>
                            <span class="event-card__tickets">Get Tickets &rarr;</span>
                        </div>
                    </a>`;
}

function generateEventsPagePastCard(event) {
    const name = event.name ? event.name.text : 'Untitled Event';
    const desc = truncateText(event.description ? event.description.text : '', 150);
    const dateStr = formatDateTime(event.start ? event.start.local : '');
    const imageUrl = getEventImage(event);
    const location = getEventLocation(event);
    const eventUrl = event.url || '#';

    return `                    <a href="${escapeHtml(eventUrl)}" class="event-card reveal" target="_blank" rel="noopener">
                        <img class="event-card__img" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(name)}" loading="lazy">
                        <div class="event-card__body">
                            <p class="event-card__date">${dateStr}</p>
                            <h3 class="event-card__title">${escapeHtml(name)}</h3>
                            <p class="event-card__desc">${escapeHtml(desc)}</p>
                            <span class="event-card__tag">${escapeHtml(location)}</span>
                        </div>
                    </a>`;
}

function generateHomepageCard(event) {
    const { name, desc, dateStr, imageUrl, location, eventUrl } = upcomingCardFields(event);

    return `                    <a href="${escapeHtml(eventUrl)}" class="event-card stagger-item" target="_blank" rel="noopener">
                        <img class="event-card__img" data-pixel-reveal
                             src="${escapeHtml(imageUrl)}" alt="${escapeHtml(name)}" loading="lazy" crossorigin="anonymous">
                        <div class="event-card__body">
                            <p class="event-card__date">${dateStr}</p>
                            <h3 class="event-card__title">${escapeHtml(name)}</h3>
                            <p class="event-card__desc">${escapeHtml(desc)}</p>
                            <span class="event-card__tag">${escapeHtml(location)}</span>
                        </div>
                    </a>`;
}

// ── Main Sync Logic ─────────────────────────────────────────────────────────

async function main() {
    // Load or create manifest
    let manifest;
    const manifestExisted = fs.existsSync(MANIFEST_PATH);
    if (manifestExisted) {
        manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    } else {
        manifest = { lastSync: null, upcoming: [], past: [] };
        console.log('Created default events-manifest.json');
    }

    const previousHash = JSON.stringify(manifest.upcoming) + JSON.stringify(manifest.past);

    // Each source is null when it was unavailable this run.
    let ebUpcoming = null;
    let pastEvents = null;

    if (!TOKEN || !ORG_ID) {
        console.warn('EVENTBRITE_TOKEN or EVENTBRITE_ORG_ID not set. Skipping Eventbrite.');
    } else {
        // Fetch upcoming events
        console.log('Fetching upcoming events from Eventbrite...');
        try {
            ebUpcoming = await fetchAllEvents('live,started');
            console.log(`  Found ${ebUpcoming.length} upcoming event(s).`);
        } catch (err) {
            console.warn('  Warning: failed to fetch upcoming events from Eventbrite:', err.message);
        }

        // Fetch past events
        console.log('Fetching past events from Eventbrite...');
        try {
            // Limit past events to 12 most recent (already sorted desc by API)
            pastEvents = (await fetchAllEvents('ended')).slice(0, 12);
            console.log(`  Found ${pastEvents.length} past event(s) (limited to 12).`);
        } catch (err) {
            console.warn('  Warning: failed to fetch past events from Eventbrite:', err.message);
        }
    }

    console.log('Fetching upcoming events from Dandelion...');
    let dandelionEvents = null;
    try {
        dandelionEvents = await fetchDandelionEvents();
        console.log(`  Found ${dandelionEvents.length} upcoming event(s).`);
    } catch (err) {
        console.warn('  Warning: failed to fetch events from Dandelion:', err.message);
    }

    if (ebUpcoming === null && dandelionEvents === null) {
        console.error('Both Eventbrite and Dandelion are unavailable for upcoming events. Nothing written.');
        process.exit(1);
    }
    if (dandelionEvents === null) console.warn('Proceeding with Eventbrite only for upcoming events.');
    if (ebUpcoming === null) console.warn('Proceeding with Dandelion only for upcoming events.');
    if (pastEvents === null) console.warn('Past events left as they are (Eventbrite unavailable).');

    const dandelionModels = (dandelionEvents || []).map(fromDandelion).filter(m => {
        if (Number.isNaN(m.startMs)) {
            console.warn(`  Warning: skipping Dandelion event with an unreadable start_time: ${m.name || m.id}`);
            return false;
        }
        return true;
    });
    const { upcoming: upcomingEvents, summary } = mergeUpcoming(dandelionModels, (ebUpcoming || []).map(fromEventbrite));
    logSourceSummary(summary);

    console.log('Self-hosting upcoming event images...');
    await mirrorEventImages(upcomingEvents, manifest.upcoming);

    // Extract event data for manifest
    function extractEventData(event) {
        return {
            id: event.id,
            name: event.name ? event.name.text : 'Untitled Event',
            description: truncateText(event.description ? event.description.text : '', 150),
            url: event.url || '',
            startLocal: event.start ? event.start.local : '',
            endLocal: event.end ? event.end.local : '',
            venueName: event.venue ? event.venue.name : null,
            city: event.venue && event.venue.address ? event.venue.address.city : null,
            imageUrl: getEventImage(event),
            status: event.status,
        };
    }

    const upcomingData = upcomingEvents.map(upcomingManifestEntry);
    const pastData = pastEvents !== null ? pastEvents.map(extractEventData) : manifest.past;

    // ── Update events.html ──────────────────────────────────────────────────

    if (fs.existsSync(EVENTS_PAGE_PATH)) {
        const originalEventsHtml = fs.readFileSync(EVENTS_PAGE_PATH, 'utf8');
        let eventsHtml = originalEventsHtml;

        // Upcoming section
        const upcomingContent = upcomingEvents.length > 0
            ? upcomingEvents.map(e => generateEventsPageUpcomingCard(e)).join('\n')
            : '                    <p class="events__empty reveal">Events are coming soon. Follow us on <a href="https://instagram.com/yvonne.holistique/" target="_blank">Instagram</a> for updates.</p>';

        const updatedUpcoming = replaceSection(
            eventsHtml,
            '<!-- EVENTS-UPCOMING-START -->',
            '<!-- EVENTS-UPCOMING-END -->',
            upcomingContent
        );
        if (updatedUpcoming) {
            eventsHtml = updatedUpcoming;
        } else {
            console.warn('  Warning: Could not find EVENTS-UPCOMING markers in events.html. Skipping upcoming section.');
        }

        // Past section (Eventbrite only; left as it is when Eventbrite was unavailable)
        if (pastEvents !== null) {
            const pastContent = pastEvents.length > 0
                ? pastEvents.map(e => generateEventsPagePastCard(e)).join('\n')
                : '                    <p class="events__empty reveal">No past events to show yet.</p>';

            const updatedPast = replaceSection(
                eventsHtml,
                '<!-- EVENTS-PAST-START -->',
                '<!-- EVENTS-PAST-END -->',
                pastContent
            );
            if (updatedPast) {
                eventsHtml = updatedPast;
            } else {
                console.warn('  Warning: Could not find EVENTS-PAST markers in events.html. Skipping past section.');
            }
        }

        // Event structured data (JSON-LD), regenerated from the upcoming events
        const updatedJsonLd = replaceSection(
            eventsHtml,
            '<!-- EVENTS-JSONLD-START -->',
            '<!-- EVENTS-JSONLD-END -->',
            eventsJsonLdBlock(upcomingEvents)
        );
        if (updatedJsonLd) {
            eventsHtml = updatedJsonLd;
        } else {
            console.warn('  Warning: Could not find EVENTS-JSONLD markers in events.html. Skipping event structured data.');
        }

        if (eventsHtml !== originalEventsHtml) {
            fs.writeFileSync(EVENTS_PAGE_PATH, eventsHtml, 'utf8');
            console.log('  Updated events.html.');
        } else {
            console.log('  events.html already up to date.');
        }
    } else {
        console.warn('  Warning: events.html not found. Skipping events page update.');
    }

    // ── Update index.html (top 3 upcoming) ──────────────────────────────────

    if (fs.existsSync(INDEX_PATH)) {
        let indexHtml = fs.readFileSync(INDEX_PATH, 'utf8');

        const top3 = upcomingEvents.slice(0, 3);
        const homepageContent = top3.length > 0
            ? top3.map(e => generateHomepageCard(e)).join('\n')
            : '                    <p class="events__empty stagger-item">Events are coming soon. Follow us on <a href="https://instagram.com/yvonne.holistique/" target="_blank">Instagram</a> for updates.</p>';

        const updatedIndex = replaceSection(
            indexHtml,
            '<!-- HOMEPAGE-EVENTS-START -->',
            '<!-- HOMEPAGE-EVENTS-END -->',
            homepageContent
        );
        if (updatedIndex && updatedIndex !== indexHtml) {
            fs.writeFileSync(INDEX_PATH, updatedIndex, 'utf8');
            console.log('  Updated index.html with top 3 upcoming events.');
        } else if (updatedIndex) {
            console.log('  index.html already up to date.');
        } else {
            console.warn('  Warning: Could not find HOMEPAGE-EVENTS markers in index.html. Skipping homepage update.');
        }
    } else {
        console.warn('  Warning: index.html not found. Skipping homepage update.');
    }

    // ── Update manifest ─────────────────────────────────────────────────────

    // Only rewrite the manifest when the event data itself differs. lastSync is
    // deliberately left untouched otherwise, so an unchanged run produces no file
    // writes at all and the workflow has nothing to commit.
    const newHash = JSON.stringify(upcomingData) + JSON.stringify(pastData);
    const eventsChanged = newHash !== previousHash;

    if (eventsChanged || !manifestExisted) {
        manifest.lastSync = new Date().toISOString();
        manifest.upcoming = upcomingData;
        manifest.past = pastData;

        fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
        console.log('Manifest updated.');
    } else {
        console.log('No changes — events-manifest.json is already up to date (lastSync left as-is).');
    }

    // ── Change detection ────────────────────────────────────────────────────

    console.log(`EVENTS_CHANGED=${eventsChanged}`);

    console.log(`Sync complete! ${upcomingEvents.length} upcoming, ${pastData.length} past event(s)${pastEvents === null ? ' (unchanged)' : ''}.`);
}

main().catch(err => {
    console.error('Sync failed:', err);
    process.exit(1);
});
