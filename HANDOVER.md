# Holistique UK website: handover

For whoever takes over https://holistiqueuk.com. Last updated 11 October 2026.

This repository is public, so never put passwords, API keys or other secrets in it. They belong in the repository's Actions secrets (Settings → Secrets and variables → Actions) or in each service's own account.

## The short version

- **What it is:** plain HTML files in this GitHub repository. GitHub Pages publishes the `main` branch, and a change is live about 2 minutes after it is pushed. There is no website builder and no database.
- **What updates itself:** events, wellness tools and journal articles are pulled in automatically from other platforms (see below). Most day-to-day changes happen on those platforms, not here.
- **Working on it with an AI agent:** [`AGENTS.md`](AGENTS.md) holds the technical rules. Grok Build, Claude Code, Codex and Cursor all read it automatically.

## Getting started with Grok Build

1. Get access to this repository. The current maintainer either adds you as a collaborator or transfers the repository to you (see the checklist below).
2. Install Grok Build:
   - Windows (PowerShell): `irm https://x.ai/cli/install.ps1 | iex`
   - Mac or Linux: `curl -fsSL https://x.ai/cli/install.sh | bash`
3. Download the site and start Grok inside it:

   ```
   git clone https://github.com/JamesMo14/Holistique.git
   cd Holistique
   grok
   ```

4. Ask for the change you want. Grok edits the files, commits them and pushes to `main`.
5. In the repository's **Actions** tab, wait for the `pages-build-deployment` run to turn green, then reload the site.

Automated jobs push to `main` several times a day, so always pull the latest version (`git pull --rebase`) before starting and before pushing.

## Where the content comes from

Change content at its source. Edits made directly to the synced parts of the pages are overwritten.

| Content | Source | How it reaches the site |
|---|---|---|
| Upcoming events | Dandelion (organiser page "holistique", which is the booking link) and Eventbrite | Synced every 6 hours. Events listed on both platforms appear once. |
| Past events | Eventbrite | Synced every 6 hours |
| Wellness tools and discount codes | Linktree (`linktr.ee/holistiqueuk`) | Synced every 6 hours (currently failing, see known issues) |
| Journal articles | Medium (`@yvonne.holistique`) | Synced on the 1st and 15th of each month |
| Newsletter signups | Brevo form (Yvonne's Brevo account) | Embedded on the homepage and at `/newsletter`. Emails about new articles are sent by hand as Brevo campaigns. |
| Everything else (text, photos, pages) | The HTML files in this repository | Edit with Grok and push |

You can run any of the three syncs on demand: open the **Actions** tab, pick the workflow, and click **Run workflow**.

## Accounts and services the site depends on

| Service | What it does for the site | Held by (Oct 2026) | At handover |
|---|---|---|---|
| GitHub (this repository) | Code, hosting (GitHub Pages), automations and secrets | Current maintainer (`JamesMo14`) | Transfer the repository, or add the new owner as a collaborator |
| Porkbun | Registrar for the domain name `holistiqueuk.com`, which renews on 23 July 2027 | Current maintainer | Move it to the new owner's Porkbun account with "Push Domain" |
| Cloudflare | DNS, HTTPS proxy, and email forwarding for `@holistiqueuk.com` addresses | Current maintainer | New owner adds the domain to their own free Cloudflare account (see checklist) |
| Brevo | Newsletter list and form | Yvonne | Nothing to do |
| Dandelion | Event listings and bookings (read from a public feed with no key) | Yvonne | Nothing to do |
| Eventbrite | Event listings and the past-events archive (read with an API token) | Yvonne's organiser account. Not yet confirmed whose account created the API token. | Replace the token if it belongs to someone who is leaving |
| Linktree, Medium, Instagram, WhatsApp | Wellness tools, articles, social links and contact | Yvonne | Nothing to do |

The repository's Actions secrets are:

- `EVENTBRITE_TOKEN` and `EVENTBRITE_ORG_ID`, used by the events sync.
- `NEWSLETTER_SECRET`, a leftover from an old newsletter set-up that no longer does anything. It can be deleted.

## Handover checklist

1. **GitHub**
   1. Go to **Settings → Danger Zone → Transfer** and enter the new owner's GitHub username. They must accept within a day. The secrets and automations move with the repository.
   2. Afterwards, check **Settings → Pages**: the custom domain should still read `holistiqueuk.com`, publishing from branch `main`, folder `/` (root).
   3. Optional: verify the domain under the new owner's GitHub **Settings → Pages**, so that no one else can claim it.
2. **Cloudflare**
   1. The new owner creates a free Cloudflare account and adds `holistiqueuk.com`.
   2. They import the DNS records, exported as a file from the current account.
   3. They set up Email Routing again, so `@holistiqueuk.com` mail reaches their inbox.
   4. Cloudflare will show two new nameservers. Note them for the next step.
3. **Domain**
   1. In Porkbun, use **Domain Management → Details → Push Domain** to send the domain to the new owner's Porkbun username. They must accept within 72 hours, and new Porkbun accounts may need ID verification first.
   2. The new owner then sets the domain's nameservers to the two Cloudflare ones from step 2.
4. **Secrets:** replace `EVENTBRITE_TOKEN` if needed, and delete `NEWSLETTER_SECRET`.
5. **Tidy-up:** delete the old email-sending DNS records `resend._domainkey` and `send` in Cloudflare. The site no longer sends email itself; Brevo does.

## Known issues (as of 11 October 2026)

- **Wellness Tools sync failing:** it has failed on most runs since 23 September 2026, because Linktree answers GitHub's servers with HTTP 406. The page keeps showing the last list that synced successfully. A fix needs a different way of fetching the Linktree page.
- **No HTTPS redirect:** `http://holistiqueuk.com` is not redirected to `https://`. To fix it, turn on **SSL/TLS → Edge Certificates → Always Use HTTPS** in Cloudflare.
- **Sitemap out of date:** `sitemap.xml` is updated by hand and is missing the seven newest articles (`post-13.html` to `post-19.html`).
- **Rich results test not run:** the events page's Google structured data passes the Schema.org validator with 0 errors, but Google's Rich Results Test hasn't been run (it needs a signed-in Google account): https://search.google.com/test/rich-results?url=https%3A%2F%2Fholistiqueuk.com%2Fevents.html
