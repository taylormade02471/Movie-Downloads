# GitHub Copilot handoff: Movie-Downloads cloud hosting and shared password

Prepared September 24, 2026, for Kyle Taylor.

## Task

Update the existing Movie-Downloads app so friends and family can browse and watch the owner's movie library on a separate website while the owner's computer is turned off. Require a shared password before showing the catalog or allowing the website to issue playback links. Keep the existing browsing and watch experience, adapting it as needed for cloud storage and phone screens.

Implement the changes in the existing repository, test them, and open a reviewable pull request. Do not report a working online service until deployment and real cloud playback have been verified. If an account connection or secret is missing, finish the code that can be completed and state exactly what setup remains.

## Repository and verified starting point

- Repository: https://github.com/taylormade02471/Movie-Downloads
- Branch inspected: `copilot/build-movie-streaming-app`
- Inspected commit: `a5b927b3597cd7cd824483b1ba81631e28c62a14`
- Recheck the branch for newer commits before making changes. Preserve other contributors' work.
- `package.json`: dependency-free Node app; `npm start` runs `node server.js`; `npm test` runs `node --test`.
- `server.js`: Node HTTP server, local movie discovery, and byte-range streaming.
- `public/index.html`: movie selector and browser video player.
- `public/app.js`: fetches the catalog and starts playback.
- `test/server.test.js`: server, range-request, and some frontend behavior tests.

The existing `/api/movies` reads only immediate files in a local `movies/` directory. It does not recursively discover subfolders. `/api/stream/:filename` serves local movie bytes, including partial requests and HEAD requests. The frontend currently accepts stream paths beginning with `/api/stream/`.

At handoff time, no password protection, OneDrive integration, or Vercel deployment has been implemented in this work. The repository was inspected and cloned; its working tree remains unchanged. The existing test suite was read but not run during handoff preparation.

## Owner's decisions

1. The site must work when the owner's computer is off. Do not rely on localhost, a home tunnel, Windows file sharing, or a running desktop process.
2. Viewers must not log into or remotely access the owner's computer.
3. Movies are on the computer and already copied to OneDrive. The owner estimates the collection at approximately 20 GB; that total has not been independently measured.
4. Start by using the existing OneDrive storage. Do not move the collection or create paid storage without the owner's agreement.
5. Prefer Vercel hosting with a free `.vercel.app` address. A purchased domain is optional, not a prerequisite. Availability of a particular hostname has not been checked.
6. Every viewer must enter the same simple, lowercase password. The owner has selected its value in the private conversation. Configure that exact value through the server-only `MOVIE_PASSWORD` setting; obtain it privately from the owner if this agent lacks that context. Do not invent a replacement, require uppercase letters, add individual viewer accounts, or make visitors sign into Microsoft.
7. Keep the movie catalog and watch page straightforward and usable on phones and computers.

Private setup values are deliberately omitted from this GitHub-ready handoff. Do not paste the password, the owner's OneDrive sharing URLs, Microsoft tokens, or live playback URLs into public issues, commits, logs, screenshots, or test fixtures.

## What was actually verified in OneDrive

The owner supplied two sharing links for a folder named **Movie downloads**. Both opened the same folder in a browser without signing into Microsoft.

The visible root listing contained six folders and two MKV files. An MP4 inside a subfolder was also inspected. Two sample files were opened in OneDrive's own browser preview:

| Sample | Observed size | Playback observation |
| --- | --- | --- |
| MP4 in a movie subfolder | 2.68 GB | Playback advanced to about 45 seconds; no media error; player reported ready state 4 |
| MKV at the folder root | 2.40 GB | Playback advanced to about 31 seconds; no media error; player reported ready state 4 |

These observations establish short playback in OneDrive's player only. They do **not** establish direct playback in our app, embed support, long-session reliability, audio correctness, cross-browser compatibility, or working seek behavior. A seek interaction was attempted but did not complete because the slider was unavailable; seeking remains unverified. No complete movie was watched and the full collection was not inventoried.

Some OneDrive pages displayed create/upload and file-management controls. Whether anonymous visitors could execute those actions was not tested. Verify sharing permissions; do not assume the links are view-only.

## Proposed architecture

Use Vercel for the frontend and lightweight server endpoints. Use OneDrive as the source of the catalog and movie content, subject to a successful integration test. The browser should receive video bytes directly from an authorized cloud playback URL, rather than proxying full movies through Vercel functions.

Keep a small storage-provider boundary so local development can still use sample files, and another provider can be added if OneDrive cannot meet the requirements. Do not rewrite the project into a larger framework solely for this task.

### 1. Prove the OneDrive connection first

- Use Microsoft's supported authentication and Microsoft Graph APIs. Determine the correct flow for the actual account; the sharing URLs use personal OneDrive, but no owner OAuth connection has been established.
- The owner authorizes the backend. Viewers use only the movie-site password.
- Request the least privileges that support the required operations. Do not request write access solely to list and read movies.
- Limit application behavior to the selected movie folder and its descendants, even if a delegated API permission technically grants wider access.
- Store credentials and any refreshable token state only on the server. Use durable protected storage if refresh-token rotation requires persistence; do not assume a serverless process or local filesystem persists.
- Keep the initial owner authorization and subsequent reconnection flow separate from viewer login.
- List children recursively, follow pagination, and use stable drive/item identifiers. Restrict discovery to supported video files; exclude artwork, subtitles, documents, and other sidecar files from movie entries.
- Resolve a fresh playback URL after an authenticated viewer selects a movie. Microsoft Graph download URLs expire and must not be treated as permanent catalog entries.
- Test redirects, content type, range behavior, browser access, and URL expiry with real representative files before deciding OneDrive is production-ready.
- Do not scrape undocumented OneDrive internals, transplant browser cookies, or hardcode URLs extracted from the preview player as the production integration.

If this cannot be made reliable using supported APIs, explain the specific failing behavior and propose the storage fallback. Do not quietly replace in-site playback with a cloud-folder link and call the task complete.

### 2. Shared-password access

- Add a simple login page with one password field and an Enter/Watch button. Disable automatic capitalization for the field. Do not show the expected password in the page or an error message.
- Validate the password on the server against `MOVIE_PASSWORD`, using an appropriate constant-time comparison.
- Fail closed if required authentication settings are missing. Do not fall back to a hardcoded password or anonymous mode in production.
- Issue a signed or server-backed session using an independent, strong `SESSION_SECRET`. Use HttpOnly, Secure in production, and SameSite cookies. A 12-hour session is a suggested initial default, not an owner-requested requirement.
- Protect the catalog endpoint, movie pages, playback-link endpoint, and any remaining local streaming endpoint, including HEAD and range requests. A frontend-only password modal is insufficient.
- Add logout, session expiration, cookie-tampering checks, same-origin protections for state-changing requests, and bounded request bodies.
- Apply login throttling that works across the selected hosting model. In-memory counters alone do not provide reliable global throttling across serverless instances. Avoid introducing a paid service without approval.
- Do not allow shared viewer credentials to grant admin, upload, delete, rename, or provider-configuration access.
- Use private/no-store caching where needed so protected catalog data and playback links are not served from a public CDN cache to unauthenticated visitors.

**Access boundary:** The website password does not revoke existing OneDrive share links. Those links currently open without a Microsoft sign-in. Anyone retaining such a link can bypass the website. After authenticated backend access works, ask the owner before revoking/replacing existing share links or changing their permissions. Report this boundary accurately if the links remain active.

Direct playback URLs issued to an authorized browser may also remain usable until they expire. A password gate is not DRM and cannot prevent an authorized viewer from copying a usable URL or recording content. Do not claim immediate revocation of already issued provider URLs on logout.

### 3. Catalog and playback behavior

- Preserve the current simple selection and watching experience; adapt the frontend's `/api/stream/` restriction deliberately if the endpoint now resolves a temporary cloud URL.
- Show clean titles, loading state, empty-library state, provider errors, expired-session handling, and a clear message for unsupported media.
- Never accept an arbitrary client-supplied remote URL to fetch or redirect to. Resolve allowlisted movie IDs within the configured provider folder.
- Test nested files, duplicate filenames in different folders, spaces, Unicode filenames, and removed movies.
- Support play/pause, seek, buffering, and fullscreen where the browser allows it.
- Test MP4 and MKV separately. Successful MKV playback in OneDrive's preview does not prove the same file will play directly in every browser; OneDrive may use a different playback pipeline.
- If conversion is required, document a suitable browser-compatible format, such as MP4 with H.264 video and AAC audio, and obtain approval for any large conversion/upload operation. Do not promise realtime transcoding on a free Vercel deployment.

### 4. Hosting and configuration

- Add the smallest Vercel-compatible server routing/configuration needed for the existing project.
- Do not place the movie collection in Git, Git LFS, a Vercel build bundle, or a GitHub Pages deployment.
- Keep secrets server-only. Do not use public frontend environment-variable prefixes for passwords or provider credentials.
- Provide an `.env.example` containing variable names and placeholders only. Ignore real environment files and token caches in Git.
- Configuration should cover the shared password, session secret, Microsoft application/redirect settings, folder identification, and the chosen durable credential-storage mechanism. Document the final names the implementation actually uses.
- GitHub Pages can serve static pages but cannot run this app's password/authentication backend by itself. It is not the preferred deployment target for this design.
- Do not purchase a custom domain. Use the assigned Vercel hostname initially and provide optional custom-domain instructions later.
- Do not assume an existing movie-site Vercel project, deployment, environment configuration, or Microsoft app registration exists; none was verified during this work.

## Storage fallback and cost context

Cloudflare R2 Standard storage was discussed as a fallback, not selected or provisioned. Its checked pricing includes 10 GB-month of storage, 1 million Class A operations, and 10 million Class B operations per month, with no R2 internet egress charge. Additional standard storage is $0.015 per GB-month.

For a steady 20 GB collection, the storage-only estimate is about **$0.15/month**, assuming the full free storage allowance is available. This is not a guaranteed total bill: requests above allowances, other metered services, taxes, billing rounding, and future growth can add cost. Recheck pricing before provisioning. Existing OneDrive plan capacity and service limits have not been audited.

## Implementation sequence and acceptance checks

1. Inspect current repository instructions and latest branch; create a focused feature branch.
2. Add server-enforced authentication and meaningful tests for unauthorized access, wrong-password rejection, successful login, expiry, tampering, logout, and throttling.
3. Implement and test the supported OneDrive provider, including recursive discovery and fresh playback links. Use synthetic media and fake provider data in committed tests; use the owner's movies only for private integration checks.
4. Connect the catalog and watch UI and verify authentication before any protected catalog or playback data is returned.
5. Run the full test suite and any build command introduced. Record actual results. The existing unreadable-file test may behave differently when run as root; handle/report that explicitly instead of silently claiming a clean suite.
6. Deploy a preview when account access and required configuration are available. Test in a fresh browser session, including direct unauthenticated requests to all protected routes.
7. Verify real play and seek behavior on at least one MP4 and one MKV, plus supported phone/desktop browsers. Test recovery from expired/revoked provider credentials and expired playback URLs. Do not count OneDrive preview as website verification.
8. Verify the hosted app has no dependency on the owner's desktop. Have the owner confirm a final playback test with the computer off if needed.
9. Open a pull request explaining changes, configuration, test results, remaining limitations, and preview URL. Follow repository merge/deployment rules and distinguish a preview from a verified production launch.

### Required completion report

- PR link and exact commit/branch.
- What changed and what remains blocked.
- Test and build results, including skips/failures.
- Preview/production URL and actual deployment status, if deployed.
- Owner setup still required, with exact field names but no secret values.
- Whether the original anonymous OneDrive links remain active.
- Confirmed formats/browsers and any conversion requirement.
- Costs or account requirements introduced; no unapproved purchases.

## Official references checked for this handoff

- Microsoft Graph content download, permissions, URL expiry, and byte ranges: https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0
- Vercel domains and assigned `.vercel.app` addresses: https://vercel.com/docs/domains/working-with-domains
- Vercel Hobby plan: https://vercel.com/docs/plans/hobby
- Vercel guidance for large files and dedicated media storage: https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions
- GitHub Pages overview: https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/

Recheck current provider documentation during implementation. Provider documentation does not substitute for testing this app's actual deployment.
