# TODO List

## Current Tasks
- [ ] UI/UX Contact Card Cleanup & Enhancement:
  - Remove duplicate contact edit cards/modals (keep only the newest one we worked on).
  - Add all missing Telegram fields to the remaining Contact Card:
    - `first_name`
    - `last_name`
    - `username`
    - `telegram_id`
    - `last_seen_online` (time when the contact was last online)
    - `bio` (if available)
  - Consider adding more useful fields to the contact card, such as:
    - Profile picture (avatar URL or placeholder)
    - Contact source (e.g. which group they were parsed from)
    - Link to their Telegram profile (t.me/username)
    - Language code
    - Verification status/bot status

## Completed Tasks
- [x] Fix Telegram group search: use `Api.messages.SearchGlobal` (global message search) so discovery finds channels/groups where the keyword appears and we can get participants; `contacts.Search` only searches saved contacts and returns chats we may not be in.
- [x] Fix Telegram participant parsing: resolve channel IDs with `-100` prefix first for numeric IDs (SearchGlobal returns raw channelId), then `getEntity` + `channels.GetParticipants`.
- [x] Fix `campaign-service` crashing: removed non-existent `bd_account_id` from campaigns SELECT; CRM commits contacts before calling campaign-service so FK is satisfied.