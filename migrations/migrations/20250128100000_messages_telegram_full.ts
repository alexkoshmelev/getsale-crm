import { Knex } from 'knex';

/**
 * Расширяем хранение сообщений: полные данные из Telegram API
 * (entities, media, reply_to, fwd_from, views, edit_date, reactions и т.д.)
 * плюс наши поля: loaded_at, unread.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('messages', (table) => {
    // Идентификатор сообщения в Telegram (уникален в рамках чата)
    table.string('telegram_message_id', 64).nullable();
    // Дата отправки в Telegram (unixtime → timestamptz храним как timestamp)
    table.timestamp('telegram_date', { useTz: true }).nullable();
    // Когда мы загрузили сообщение в нашу БД
    table.timestamp('loaded_at', { useTz: true }).nullable().defaultTo(knex.fn.now());
    // Ответ на сообщение (Telegram id того сообщения)
    table.string('reply_to_telegram_id', 64).nullable();
    // Форматирование текста: bold, italic, link, mention, code, pre и т.д.
    table.jsonb('telegram_entities').nullable();
    // Медиа: фото, видео, голос, документ, стикер и т.д. (тип + метаданные, без файлов)
    table.jsonb('telegram_media').nullable();
    // Остальное из Telegram: fwd_from, views, forwards, edit_date, reactions, post_author, grouped_id, reply_markup и т.д.
    table.jsonb('telegram_extra').nullable();
  });

  // Уникальность: одно и то же сообщение Telegram не дублируем (в рамках аккаунта и чата)
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS messages_telegram_unique
    ON messages (bd_account_id, channel_id, telegram_message_id)
    WHERE telegram_message_id IS NOT NULL
  `);

  // Индексы для частых запросов
  await knex.schema.alterTable('messages', (table) => {
    table.index('telegram_message_id');
    table.index('telegram_date');
    table.index('reply_to_telegram_id');
  });

  // Переносим telegramMessageId из metadata в колонку (для существующих строк).
  // Обновляем только по одной строке на каждую (bd_account_id, channel_id, telegram_message_id),
  // иначе дубликаты нарушат messages_telegram_unique. Берём строку с минимальным id.
  await knex.raw(`
    UPDATE messages m
    SET telegram_message_id = m.metadata->>'telegramMessageId',
        loaded_at = COALESCE(m.created_at, NOW())
    WHERE m.metadata->>'telegramMessageId' IS NOT NULL
      AND m.telegram_message_id IS NULL
      AND m.id IN (
        SELECT DISTINCT ON (m3.bd_account_id, m3.channel_id, m3.metadata->>'telegramMessageId') m3.id
        FROM messages m3
        WHERE m3.metadata->>'telegramMessageId' IS NOT NULL AND m3.telegram_message_id IS NULL
        ORDER BY m3.bd_account_id, m3.channel_id, m3.metadata->>'telegramMessageId', m3.id
      )
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS messages_telegram_unique');
  await knex.schema.alterTable('messages', (table) => {
    table.dropIndex('telegram_message_id');
    table.dropIndex('telegram_date');
    table.dropIndex('reply_to_telegram_id');
    table.dropColumn('telegram_message_id');
    table.dropColumn('telegram_date');
    table.dropColumn('loaded_at');
    table.dropColumn('reply_to_telegram_id');
    table.dropColumn('telegram_entities');
    table.dropColumn('telegram_media');
    table.dropColumn('telegram_extra');
  });
}
