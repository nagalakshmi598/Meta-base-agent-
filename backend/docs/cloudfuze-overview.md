# CloudFuze Migration — Overview

CloudFuze is an enterprise cloud-to-cloud migration platform that moves data between
collaboration and productivity tools. It migrates messaging, files, email, and
collaboration metadata while preserving structure, timestamps, and ownership.

## What CloudFuze migrates
- **Messaging**: Slack ↔ Microsoft Teams, Google Chat — channels, direct messages, threads, reactions, attachments.
- **Files / Content**: Box, Dropbox, Google Drive ↔ OneDrive, SharePoint — folders, files, permissions, versions.
- **Email**: Gmail ↔ Outlook / Exchange.
- **Collaboration metadata**: workspaces, channels, members, permissions.

## How a migration works (phases)
1. **Pre-migration**: connect source and destination via API, enumerate users/channels/messages, build a user mapping (source email → destination account), and estimate volume.
2. **Migration**: process messages/files in batches, re-link attachments, map @mentions to destination users, and handle API rate limits with automatic backoff.
3. **Post-migration**: verify migrated vs expected counts, flag failures for retry, and optionally run a **delta sync** to catch content created after the initial run.

## Migration statuses
- **PROCESSED** — migration completed successfully.
- **PROCESSED_WITH_SOME_CONFLICTS** — completed, but some individual items conflicted.
- **CONFLICT** — a file/folder/message with the same name already exists at the destination, so the item was skipped to avoid overwriting.
- **NO_MESSAGE** — the source channel/workspace was empty, so there was nothing to migrate (not a failure).
- **FAILED / ERROR** — the item errored during migration and needs review or retry.
- **IN_PROGRESS** — the migration is still running.

## Common conflict / error reasons and what they mean
- **File/Folder name contains special characters** — the destination disallows characters like `\\ / : * ? " < > |`. Rename the item and retry.
- **Access denied / Forbidden (403)** — the account lacks permission to read the source or write to the destination. Re-authorize or grant the needed scopes.
- **Unauthorized (401) / token expired** — reconnect the source/destination account; OAuth tokens are invalid.
- **Requested file not found (404)** — the item was moved or deleted before migration.
- **Timeout** — the item/channel was too large or the network too slow; retry, ideally off-peak.
- **Rate limit / throttled (429)** — the destination API throttled the transfer; it retries at a slower pace.
- **Maximum storage quota reached** — the destination account is out of space; free space or upgrade, then retry.

## How threads and channels are handled
Slack threads are preserved as threaded replies in Microsoft Teams where the destination
supports it. Public channels migrate by default; private channels require explicit
permission grants; direct messages migrate as 1:1 or group chats. Archived channels can
be included based on configuration.

## Delta migration
After the initial migration, a delta sync migrates only new or changed content since the
last run, so ongoing activity during a phased cutover isn't lost.

## Security
CloudFuze uses OAuth for source/destination connections, retains no customer data after a
migration completes, and preserves timestamps, thread structure, attachments, and reactions.
