# AGENTS.md: Holistique UK website

Instructions for AI coding agents (Grok Build, Claude Code, Codex, Cursor, etc.) and for anyone maintaining https://holistiqueuk.com.

## What this site is

- Plain static HTML. There is no framework, no `package.json` and no build step. Whatever is on `main` is what is live.
- Every page is self-contained, with one inline `<style>` block and its own inline `<script>` tags. The only external assets are Google Fonts (on every page), plus GSAP 3.12.5 (from cdnjs) and three.js 0.159.0 (from jsdelivr), which load on `index.html` only.
- The site is hosted on GitHub Pages from the root of the `main` branch. Every push to `main` goes live within a couple of minutes. Browsers may keep showing a cached copy of a page for up to 10 minutes.
- Cloudflare sits in front of GitHub Pages and handles DNS and proxying. The custom domain comes from the `CNAME` file. Never delete or edit that file.

## Pages

| File | What it is |
|---|---|
| `index.html` | Home page. Its events block is filled in automatically. |
| `about.html` | Yvonne’s full gong and acupuncture biography, with forest and studio portraits. |
| `acupuncture.html` | Acupuncture treatments. |
| `events.html` | Upcoming events, synced automatically from Dandelion and Eventbrite (cards book through Dandelion). Past events come from Eventbrite. |
| `self-acupuncture-course.html` | The self-acupuncture course. |
| `wellness-tools.html` | Wellness tools and discount codes, synced automatically from Linktree. |
| `newsletter.html` | Standalone newsletter signup page (also reachable at `/newsletter`), using the Brevo form. |
| `blog.html` | The Journal landing page. It links to `blog-post.html`. |
| `blog-post.html` | The list of articles. Cards for new articles are inserted automatically. |
| `post-1.html` … `post-N.html` | Individual articles, generated from Medium posts. |
| `photos/` | Images. Prefer `.webp`. |
| `photos/events/` | Self-hosted images for upcoming events, managed by the events sync. Don't add files here; the sync deletes anything that isn't an upcoming event's image. |
| `sitemap.xml`, `robots.txt`, `og-image.jpg` | SEO files. `sitemap.xml` is updated by hand. |

## Automations (GitHub Actions, `.github/workflows/`)

Bots commit directly to `main` as `github-actions[bot]`, several times a day. You can also start any of these workflows by hand from the Actions tab, using "Run workflow".

| Workflow | Runs (UTC) | Script | Source | Writes |
|---|---|---|---|---|
| Sync Eventbrite Events | Every 6 hours, on the hour | `scripts/sync-events.js` | Dandelion feed (`dandelion.events/o/holistique/events.json`, no auth) and Eventbrite API | `events-manifest.json`, `events.html`, `index.html` |
| Sync Linktree Wellness Tools | Every 6 hours, at half past | `scripts/sync-linktree.js` | linktr.ee/holistiqueuk | `linktree-manifest.json`, `wellness-tools.html` |
| Sync Medium Posts | 09:00 on the 1st and 15th | `scripts/sync-medium.js`, then `scripts/send-newsletter.js` | Medium RSS feed for @yvonne.holistique | `posts-manifest.json`, new `post-N.html` files, `blog-post.html`. Its newsletter-email step is switched off (see rule 6). |

The repository secrets are under Settings → Secrets and variables → Actions:

- `EVENTBRITE_TOKEN` and `EVENTBRITE_ORG_ID` are used by the events sync.
- `NEWSLETTER_SECRET` is left over from the old n8n email and no longer does anything. `NEWSLETTER_WEBHOOK_URL` has been deleted, so the newsletter step skips.

The Linktree and Medium syncs don't need secrets. The scripts use only Node's built-in modules (Node 20 or later).

A deploy shows up in the Actions tab as a `pages-build-deployment` run.

## Rules

1. **Pull before you start work and again before you push** (`git pull --rebase`). The bots push to `main` constantly, so a push from a stale checkout will be rejected.
2. **Never hand-edit content between sync markers.** The bots overwrite everything between these comment pairs:
   - `events.html`: `<!-- EVENTS-UPCOMING-START -->` / `-END -->` and `<!-- EVENTS-PAST-START -->` / `-END -->`
   - `index.html`: `<!-- HOMEPAGE-EVENTS-START -->` / `-END -->`
   - `wellness-tools.html`: `<!-- WELLNESS-TOOLS-START -->` / `-END -->` and `<!-- WELLNESS-TOOLS-SCHEMA-START -->` / `-END -->`

   Change the content at its source instead: events in Dandelion and Eventbrite, wellness tools in Linktree, articles on Medium. To change how the cards look, edit the HTML template inside the matching script.
   **Events merge:** Yvonne lists each event on both platforms.
   - **Matching:** `sync-events.js` pairs the two copies by the same start instant. Failing that, it pairs events on the same London day whose normalised titles contain one another.
   - **Rendering a pair:** one card, using Dandelion's link, image, description and title, with any gaps filled from Eventbrite.
   - **Stragglers:** an event listed on only one platform still gets a card, from that platform.
   - **Times:** Dandelion times can carry non-UK offsets. They are converted to London time.
   - **Outages:** if one source fails, the sync carries on with the other; it exits 1 only when both fail. Past events (Eventbrite only) are left untouched when Eventbrite is down.
   - **Log:** each run prints a source summary (matched / Dandelion-only / Eventbrite-only).
   - **Images:** upcoming-event images are self-hosted. Dandelion's image CDN loads intermittently for visitors, so the sync downloads each card's image to `photos/events/<event id>.<jpg|png|webp>`, and cards use that local path.
     - The remote original is recorded as `image_src` in `events-manifest.json`.
     - An image is only re-downloaded when its file is missing or its `image_src` changes.
     - If a download fails, that card uses the remote URL until the next run.
     - Images for events that are no longer upcoming are deleted.
     - Past events still hotlink to Eventbrite.
3. **Wellness-tool descriptions** can be hand-written in the `enrichment` map of `linktree-manifest.json`. When sources disagree, hand-written `enrichment` wins over `auto_enrichment` (read from each product site's Open Graph tags), which wins over Linktree. `node scripts/sync-linktree.js --refresh-auto` refetches only the automatic entries.
4. **Site-wide changes affect every page.** Each HTML file has its own copy of the header, footer, newsletter box and contact links. Search for every copy and update them all. Also update the page template inside `scripts/sync-medium.js`, or the next generated article will still have the old design.
5. **Articles:** `sync-medium.js` only creates posts that aren't already in `posts-manifest.json`. It never regenerates an existing `post-N.html`, so hand edits to those files are safe. It doesn't touch `sitemap.xml`, so add new pages there yourself.
6. **Newsletter signups go to Brevo only.** The official Brevo form is embedded as an iframe in the `#newsletter` block on `index.html` and on `newsletter.html`. Every other page's newsletter box is just a "Subscribe" link to `newsletter.html`, and so is the box in the article template in `scripts/sync-medium.js`. Don't rebuild the form as a custom one. To change its fields or styling, edit it in Brevo (Contacts → Forms). If the embed URL changes, copy the new one from Brevo's Share → Iframe option and replace the `src` in both files. The iframe is 390px tall, or 480px on narrow screens, to fit the form; Brevo's suggested 305px cuts off the Subscribe button.
   There is no automatic new-article email; new articles are emailed as a campaign from Brevo. The old n8n email was switched off on 30 Sep 2026 and its `NEWSLETTER_WEBHOOK_URL` secret deleted. `scripts/send-newsletter.js` still runs in the Medium workflow, but it skips when that secret is missing.
7. **Never commit secrets.** This repository is public.
8. **Publishing (GitHub Pages / Jekyll):** files and folders whose names start with `.` or `_` are not published, and `_config.yml` keeps this file off the live site. Everything else in the repository is publicly served, including `scripts/` and the JSON manifests.

## Checking your work

- To preview locally, run `python -m http.server 8000` (or `npx serve`) in the repository root, then open http://localhost:8000.
- To run a sync locally, use `node scripts/sync-linktree.js` or `node scripts/sync-medium.js`; neither needs secrets. Without `EVENTBRITE_TOKEN` and `EVENTBRITE_ORG_ID` set, `node scripts/sync-events.js` runs Dandelion-only for upcoming events, drops any Eventbrite-only straggler, and leaves past events as they are. Don't commit that output; the scheduled workflow has the secrets. Syncs change files, so only commit their output if you meant to.
- After pushing, wait for the `pages-build-deployment` run in the Actions tab to finish, then reload https://holistiqueuk.com.

## About page and community gallery

- `about.html` uses ordinary document scrolling (no homepage panels or snap). Its biography complements the existing acupuncture bio; preserve both.
- About links appear across page headers/mobile menus/footers and the article template in `scripts/sync-medium.js`. Journal pages use a separate compact header.
- The homepage gallery has 13 slides, 13 dots and corresponding `nth-child` stacking rules. The three new community photos appear first, with contained images so the full photographs remain visible. Keep all three counts in sync when adding images.
- Gallery Previous/Next buttons and arrow keys navigate photos; Escape closes, Tab stays inside the gallery, and focus returns to the gallery trigger. The homepage honours direct links to its sections after its intro unlocks.
- The five named Yvonne/community WebPs have metadata stripped. Never replace them with original iPhone JPGs containing GPS metadata.
