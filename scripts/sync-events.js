/**
 * Eventbrite -> Holistique UK Events Sync
 *
 * Fetches upcoming and past events from the Eventbrite API, updates
 * events-manifest.json, and injects event cards into events.html and index.html.
 *
 * Run: node scripts/sync-events.js
 *
 * Env vars required:
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

// ── Fallback Images ─────────────────────────────────────────────────────────

const FALLBACK_IMAGES = [
    { keywords: ['sound', 'gong'], url: 'https://images.unsplash.com/photo-1591228127791-8e2eaef098d3?w=600&h=400&fit=crop&q=80' },
    { keywords: ['breath'], url: 'https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?w=600&h=400&fit=crop&q=80' },
    { keywords: ['meditat'], url: 'https://images.unsplash.com/photo-1506126613408-eca07ce68773?w=600&h=400&fit=crop&q=80' },
    { keywords: ['yoga'], url: 'https://images.unsplash.com/photo-1575052814086-f385e2e2ad1b?w=600&h=400&fit=crop&q=80' },
];
const DEFAULT_FALLBACK = 'https://images.unsplash.com/photo-1545389336-cf090694435e?w=600&h=400&fit=crop&q=80';

// ── Helpers ─────────────────────────────────────────────────────────────────

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const doRequest = (requestUrl) => {
            const options = {
                headers: {
                    'Authorization': `Bearer ${TOKEN}`,
                    'User-Agent': 'HolistiqueSync/1.0',
                },
            };
            https.get(requestUrl, options, (res) => {
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
            }).on('error', reject);
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
        const data = await fetchJson(url);
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

    // Fallback based on event name keywords
    const nameLower = (event.name && event.name.text || '').toLowerCase();
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

function generateEventsPageUpcomingCard(event) {
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
    const name = event.name ? event.name.text : 'Untitled Event';
    const desc = truncateText(event.description ? event.description.text : '', 150);
    const dateStr = formatDateTime(event.start ? event.start.local : '');
    const imageUrl = getEventImage(event);
    const location = getEventLocation(event);
    const eventUrl = event.url || '#';

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
    // Check env vars
    if (!TOKEN || !ORG_ID) {
        console.log('EVENTBRITE_TOKEN or EVENTBRITE_ORG_ID not set. Skipping event sync.');
        process.exit(0);
    }

    // Load or create manifest
    let manifest;
    if (fs.existsSync(MANIFEST_PATH)) {
        manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    } else {
        manifest = { lastSync: null, upcoming: [], past: [] };
        console.log('Created default events-manifest.json');
    }

    const previousHash = JSON.stringify(manifest.upcoming) + JSON.stringify(manifest.past);

    // Fetch upcoming events
    console.log('Fetching upcoming events from Eventbrite...');
    let upcomingEvents;
    try {
        upcomingEvents = await fetchAllEvents('live,started');
    } catch (err) {
        console.error('Failed to fetch upcoming events:', err.message);
        process.exit(1);
    }
    console.log(`  Found ${upcomingEvents.length} upcoming event(s).`);

    // Fetch past events
    console.log('Fetching past events from Eventbrite...');
    let pastEvents;
    try {
        pastEvents = await fetchAllEvents('ended');
    } catch (err) {
        console.error('Failed to fetch past events:', err.message);
        process.exit(1);
    }
    // Limit past events to 12 most recent (already sorted desc by API)
    pastEvents = pastEvents.slice(0, 12);
    console.log(`  Found ${pastEvents.length} past event(s) (limited to 12).`);

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

    const upcomingData = upcomingEvents.map(extractEventData);
    const pastData = pastEvents.map(extractEventData);

    // ── Update events.html ──────────────────────────────────────────────────

    if (fs.existsSync(EVENTS_PAGE_PATH)) {
        let eventsHtml = fs.readFileSync(EVENTS_PAGE_PATH, 'utf8');
        let changed = false;

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
            changed = true;
        } else {
            console.warn('  Warning: Could not find EVENTS-UPCOMING markers in events.html. Skipping upcoming section.');
        }

        // Past section
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
            changed = true;
        } else {
            console.warn('  Warning: Could not find EVENTS-PAST markers in events.html. Skipping past section.');
        }

        if (changed) {
            fs.writeFileSync(EVENTS_PAGE_PATH, eventsHtml, 'utf8');
            console.log('  Updated events.html.');
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
        if (updatedIndex) {
            fs.writeFileSync(INDEX_PATH, updatedIndex, 'utf8');
            console.log('  Updated index.html with top 3 upcoming events.');
        } else {
            console.warn('  Warning: Could not find HOMEPAGE-EVENTS markers in index.html. Skipping homepage update.');
        }
    } else {
        console.warn('  Warning: index.html not found. Skipping homepage update.');
    }

    // ── Update manifest ─────────────────────────────────────────────────────

    manifest.lastSync = new Date().toISOString();
    manifest.upcoming = upcomingData;
    manifest.past = pastData;

    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log('Manifest updated.');

    // ── Change detection ────────────────────────────────────────────────────

    const newHash = JSON.stringify(upcomingData) + JSON.stringify(pastData);
    if (newHash !== previousHash) {
        console.log('EVENTS_CHANGED=true');
    } else {
        console.log('EVENTS_CHANGED=false');
    }

    console.log(`Sync complete! ${upcomingEvents.length} upcoming, ${pastEvents.length} past event(s).`);
}

main().catch(err => {
    console.error('Sync failed:', err);
    process.exit(1);
});
