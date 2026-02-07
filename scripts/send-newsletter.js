/**
 * Send Newsletter for New Posts
 *
 * Called by GitHub Actions after sync-medium.js detects new posts.
 * Sends a POST request to the n8n newsletter webhook with post details.
 *
 * Environment variables:
 *   NEWSLETTER_WEBHOOK_URL - n8n webhook URL for newsletter broadcasts
 *   NEWSLETTER_SECRET - shared secret for authentication
 *
 * Run: node scripts/send-newsletter.js
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = path.resolve(__dirname, '..', 'posts-manifest.json');
const WEBHOOK_URL = process.env.NEWSLETTER_WEBHOOK_URL;
const SECRET = process.env.NEWSLETTER_SECRET;
const SITE_BASE_URL = process.env.SITE_BASE_URL || 'https://holistiqueuk.com';

function post(url, data, headers) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const lib = parsed.protocol === 'https:' ? https : http;
        const options = {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...headers
            }
        };

        const req = lib.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(body) });
                } catch {
                    resolve({ status: res.statusCode, data: body });
                }
            });
        });

        req.on('error', reject);
        req.write(JSON.stringify(data));
        req.end();
    });
}

async function main() {
    if (!WEBHOOK_URL) {
        console.log('NEWSLETTER_WEBHOOK_URL not set. Skipping newsletter send.');
        return;
    }

    if (!SECRET) {
        console.log('NEWSLETTER_SECRET not set. Skipping newsletter send.');
        return;
    }

    // Read manifest to find the latest posts
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

    // Find posts that were just added in this sync run
    // The sync script updates lastPostNumber, so we look for the newest post
    const latestPost = manifest.posts[manifest.posts.length - 1];

    if (!latestPost) {
        console.log('No posts found in manifest.');
        return;
    }

    console.log(`Sending newsletter for: "${latestPost.title}"`);

    const payload = {
        title: latestPost.title,
        category: latestPost.category,
        date: latestPost.date,
        url: `${SITE_BASE_URL}/${latestPost.file}`,
        mediumUrl: latestPost.mediumUrl
    };

    try {
        const result = await post(WEBHOOK_URL, payload, {
            'Authorization': `Bearer ${SECRET}`
        });

        if (result.status >= 200 && result.status < 300) {
            console.log('Newsletter sent successfully.');
        } else {
            console.error(`Newsletter send failed: HTTP ${result.status}`, result.data);
            process.exit(1);
        }
    } catch (err) {
        console.error('Newsletter send error:', err.message);
        process.exit(1);
    }
}

main();
