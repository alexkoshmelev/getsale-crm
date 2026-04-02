-- Read-only diagnostics: duplicate channel_ids for the same Telegram user.
-- Paste bd_account UUID into the query below (messaging DB).

-- Multiple channel_ids per contact (same telegram_id) under one BD account:
-- SELECT m.channel_id,
--        c.telegram_id::text AS telegram_id,
--        m.contact_id,
--        COUNT(*) AS message_rows
-- FROM messages m
-- JOIN contacts c ON c.id = m.contact_id
-- WHERE m.channel = 'telegram'
--   AND m.bd_account_id = 'PASTE-BD-ACCOUNT-UUID'::uuid
--   AND c.telegram_id IS NOT NULL
-- GROUP BY m.channel_id, c.telegram_id, m.contact_id
-- HAVING COUNT(DISTINCT m.channel_id) OVER (PARTITION BY  c.telegram_id, m.contact_id) > 1
-- ...  (simplified: run grouped query)

SELECT m.channel_id,
       c.telegram_id::text AS telegram_id,
       m.contact_id,
       m.bd_account_id,
       COUNT(*) AS message_rows
FROM messages m
JOIN contacts c ON c.id = m.contact_id
WHERE m.channel = 'telegram'
  AND m.bd_account_id = '00000000-0000-0000-0000-000000000000'::uuid
  AND c.telegram_id IS NOT NULL
GROUP BY m.channel_id, c.telegram_id, m.contact_id, m.bd_account_id
ORDER BY c.telegram_id::text, m.channel_id;
