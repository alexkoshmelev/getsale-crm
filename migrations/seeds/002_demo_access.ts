import { Knex } from 'knex';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';

const DEMO_PASSWORD = 'demo123';
const DEMO_ORG_SLUG = 'demo-workspace';
const CHATS_PER_ACCOUNT = 10;
const MESSAGES_PER_CHAT_MIN = 15;
const MESSAGES_PER_CHAT_MAX = 40;
const DAYS_SPAN = 14;

/** Генерирует дату в пределах последних DAYS_SPAN дней */
function randomPastDate(): Date {
  const now = Date.now();
  const msAgo = Math.floor(Math.random() * DAYS_SPAN * 24 * 60 * 60 * 1000);
  return new Date(now - msAgo);
}

/** Дата N дней от сегодня (положительное = в прошлом, отрицательное = в будущем), 10:00 + случайные минуты — для таймлайна */
function daysFromTodayAt10(daysFromToday: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - daysFromToday); // daysFromToday=2 → 2 дня назад, -2 → через 2 дня
  d.setHours(10, Math.floor(Math.random() * 60), 0, 0);
  return d;
}

/** Примеры сообщений для реалистичности (входящие и исходящие) */
const INBOUND_SAMPLES = [
  'Добрый день! Интересует ваша услуга по настройке CRM',
  'Когда сможете перезвонить?',
  'Отправил документы на почту',
  'Спасибо, жду предложение',
  'Можем созвониться завтра в 10?',
  'Да, такой вариант подходит',
  'Напишите, пожалуйста, счёт на предоплату',
  'Хорошо, до встречи на демо',
  'Есть вопрос по тарифу Про',
  'Мы готовы перейти на следующий этап',
  'Пришлите, пожалуйста, договор',
  'Спасибо за оперативность!',
  'Уточните сроки внедрения',
  'Когда будет следующая итерация?',
  'Всё получил, спасибо',
  'Добрый вечер! Насчёт завтрашней встречи — перенести можно?',
  'Ок, тогда в четверг',
  'Проверил — всё верно',
  'Есть ещё пара вопросов по интеграции',
  'Отлично, жду звонка',
];

const OUTBOUND_SAMPLES = [
  'Добрый день! Направил вам КП по запросу',
  'Можем созвониться сегодня после 15:00',
  'Документы получили, спасибо. Проверим и отпишемся',
  'Напоминаю о встрече завтра в 11:00',
  'Счёт во вложении. Срок оплаты до пятницы',
  'Готовы ответить на вопросы по интеграции',
  'Демо запланировано на среду, подтвердите, пожалуйста',
  'Обновил предложение с учётом скидки',
  'Когда вам удобно получить обратный звонок?',
  'Договор подписан с нашей стороны, ждём ваш экземпляр',
  'Сроки по этапу 1 — до конца месяца',
  'Отправил календарь с датами на выбор',
  'По интеграции с 1С — нужна техдокументация с вашей стороны',
  'Напоминаю: следующий созвон в четверг в 10:00',
  'Готово, можете проверить в личном кабинете',
  'Переносим на четверг, ок?',
  'Да, тариф Про включает до 5 пользователей',
  'Спасибо за обратную связь, учту',
  'Отправил правки в договор',
  'До связи завтра',
];

export async function seed(knex: Knex): Promise<void> {
  const existingOrg = await knex('organizations').where({ slug: DEMO_ORG_SLUG }).first();
  if (existingOrg) {
    const syncChatsCount = await knex('bd_account_sync_chats')
      .whereIn('bd_account_id', knex('bd_accounts').select('id').where({ organization_id: existingOrg.id }))
      .count('* as c')
      .first();
    if (Number((syncChatsCount as any)?.c ?? 0) > 0) {
      console.log('⏭️ Demo workspace already exists with chats, skipping demo seed.');
      return;
    }
    console.log('🌱 Demo workspace exists but has no chats — repairing (adding folders, chats, messages)...');
  }

  console.log(existingOrg ? '🌱 Repairing demo access...' : '🌱 Seeding demo access...');

  let org: { id: string; name: string };
  let users: { id: string; email: string }[];
  let bdAccounts: { id: string; telegram_id: string; created_by_user_id: string }[];
  let contacts: { id: string; telegram_id: string; first_name: string; last_name: string }[];
  let pipeline: { id: string };
  let stages: { id: string; name: string }[];
  let companies: { id: string; name: string }[];

  if (!existingOrg) {
    const demoPasswordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
    const [orgRow] = await knex('organizations')
      .insert({ name: 'Demo Workspace', slug: DEMO_ORG_SLUG })
      .returning('*');
    org = orgRow;
    console.log(`✅ Organization: ${org.name} (${org.id})`);

    const demoUserEmails = ['demo1@getsale.com', 'demo2@getsale.com', 'demo3@getsale.com', 'demo4@getsale.com', 'demo5@getsale.com'];
    const demoUserNames = [
      { first: 'Анна', last: 'Козлова' },
      { first: 'Борис', last: 'Соколов' },
      { first: 'Виктор', last: 'Морозов' },
      { first: 'Галина', last: 'Волкова' },
      { first: 'Дмитрий', last: 'Новиков' },
    ];
    const demoAccountDisplayNames = ['Анна (продажи)', 'Борис (поддержка)', 'Виктор (менеджер)', 'Галина (продажи)', 'Дмитрий (руководитель)'];

    users = [];
    for (let i = 0; i < demoUserEmails.length; i++) {
      const [u] = await knex('users')
        .insert({
          email: demoUserEmails[i],
          password_hash: demoPasswordHash,
          organization_id: org.id,
          role: i === 0 ? 'owner' : 'bidi',
        })
        .onConflict('email')
        .merge(['password_hash', 'organization_id', 'role'])
        .returning('id', 'email');
      users.push({ id: u.id, email: u.email });
    }
    console.log(`✅ Users: ${users.length}`);

    for (let i = 0; i < users.length; i++) {
      await knex('organization_members')
        .insert({ user_id: users[i].id, organization_id: org.id, role: i === 0 ? 'owner' : 'bidi' })
        .onConflict(['user_id', 'organization_id'])
        .merge(['role']);
      await knex('user_profiles')
        .insert({
          user_id: users[i].id,
          organization_id: org.id,
          first_name: demoUserNames[i].first,
          last_name: demoUserNames[i].last,
        })
        .onConflict('user_id')
        .merge(['first_name', 'last_name', 'organization_id']);
    }
    console.log('✅ Organization members & profiles');

    const [pipelineRow] = await knex('pipelines')
      .insert({ organization_id: org.id, name: 'Sales Pipeline', description: 'Демо-воронка продаж', is_default: true })
      .returning('*');
    pipeline = pipelineRow;

    const stageNames = [
      { name: 'Lead', order_index: 1, color: '#3B82F6' },
      { name: 'Qualified', order_index: 2, color: '#10B981' },
      { name: 'Proposal', order_index: 3, color: '#F59E0B' },
      { name: 'Negotiation', order_index: 4, color: '#EF4444' },
      { name: 'Closed Won', order_index: 5, color: '#8B5CF6' },
      { name: 'Closed Lost', order_index: 6, color: '#6B7280' },
    ];
    stages = [];
    for (const s of stageNames) {
      const [row] = await knex('stages')
        .insert({ pipeline_id: pipeline.id, organization_id: org.id, name: s.name, order_index: s.order_index, color: s.color })
        .returning('id', 'name');
      stages.push({ id: row.id, name: row.name });
    }
    console.log('✅ Pipeline & stages');

    companies = [];
    for (const name of ['ООО Демо Клиент', 'ИП Иванов', 'АО Пример']) {
      const [c] = await knex('companies').insert({ organization_id: org.id, name, industry: 'Technology', size: '10-50' }).returning('id', 'name');
      companies.push({ id: c.id, name: c.name });
    }

    contacts = [];
    const contactNames = [
    'Алексей Петров', 'Мария Сидорова', 'Иван Козлов', 'Елена Новикова', 'Сергей Михайлов',
    'Ольга Федорова', 'Николай Смирнов', 'Татьяна Кузнецова', 'Андрей Попов', 'Наталья Соколова',
    'Дмитрий Лебедев', 'Екатерина Козлова', 'Павел Новиков', 'Юлия Морозова', 'Александр Волков',
    'Светлана Алексеева', 'Максим Степанов', 'Анна Павлова', 'Игорь Семёнов', 'Лариса Голубева',
    'Виктор Виноградов', 'Елена Борисова', 'Григорий Фролов', 'Марина Орлова', 'Роман Зайцев',
    'Дарья Соловьёва', 'Артём Егоров', 'Полина Крылова', 'Кирилл Герасимов', 'Валерия Титова',
    'Станислав Никитин', 'Алина Калинина', 'Тимур Романов', 'Вероника Власова', 'Глеб Белов',
    'Ульяна Медведева', 'Даниил Антонов', 'Ксения Тарасова', 'Филипп Жуков', 'Арина Баранов',
    'Вадим Симонов', 'София Рогова', 'Леонид Воронов', 'Виктория Фомина', 'Никита Данилов',
    'Алиса Журавлёва', 'Константин Макаров', 'Милана Блинова', 'Егор Колесников', 'Зоя Карпова',
  ];

  for (let i = 0; i < 50; i++) {
    const [first, last] = contactNames[i].split(' ');
    const telegramId = `demo_contact_${String(i + 1).padStart(2, '0')}`;
    const [c] = await knex('contacts')
      .insert({
        organization_id: org.id,
        first_name: first,
        last_name: last,
        telegram_id: telegramId,
        email: i % 3 === 0 ? `contact${i + 1}@example.com` : undefined,
        display_name: i % 4 === 0 ? contactNames[i] : undefined,
        username: i % 5 === 0 ? `user_${i + 1}` : undefined,
      })
      .returning('id', 'telegram_id', 'first_name', 'last_name');
    contacts.push({ id: c.id, telegram_id: c.telegram_id, first_name: c.first_name, last_name: c.last_name });
  }
  console.log(`✅ Contacts: ${contacts.length}`);

    bdAccounts = [];
    for (let i = 0; i < 5; i++) {
      const telegramId = `demo_telegram_${String(i + 1).padStart(3, '0')}`;
      const [acc] = await knex('bd_accounts')
        .insert({
          organization_id: org.id,
          telegram_id: telegramId,
          phone_number: null,
          api_id: null,
          api_hash: null,
          session_string: null,
          is_active: true,
          is_demo: true,
          created_by_user_id: users[i].id,
          display_name: demoAccountDisplayNames[i],
          sync_status: 'completed',
          sync_progress_done: CHATS_PER_ACCOUNT,
          sync_progress_total: CHATS_PER_ACCOUNT,
        })
        .returning('id', 'telegram_id', 'created_by_user_id');
      bdAccounts.push({ id: acc.id, telegram_id: acc.telegram_id, created_by_user_id: acc.created_by_user_id });
    }
    console.log(`✅ BD accounts (demo): ${bdAccounts.length}`);
  } else {
    org = existingOrg;
    const demoAccountsRows = await knex('bd_accounts')
      .where({ organization_id: org.id, is_demo: true })
      .orderBy('created_at');
    if (demoAccountsRows.length < 5) {
      console.log('⏭️ Repair: need 5 demo accounts, found ' + demoAccountsRows.length + '. Skip.');
      return;
    }
    bdAccounts = demoAccountsRows.map((a: any) => ({ id: a.id, telegram_id: a.telegram_id, created_by_user_id: a.created_by_user_id }));
    let contactsRows = await knex('contacts').where({ organization_id: org.id }).orderBy('created_at') as { id: string; telegram_id: string; first_name: string; last_name: string }[];
    const contactNamesRepair = [
      'Алексей Петров', 'Мария Сидорова', 'Иван Козлов', 'Елена Новикова', 'Сергей Михайлов',
      'Ольга Федорова', 'Николай Смирнов', 'Татьяна Кузнецова', 'Андрей Попов', 'Наталья Соколова',
      'Дмитрий Лебедев', 'Екатерина Козлова', 'Павел Новиков', 'Юлия Морозова', 'Александр Волков',
      'Светлана Алексеева', 'Максим Степанов', 'Анна Павлова', 'Игорь Семёнов', 'Лариса Голубева',
      'Виктор Виноградов', 'Елена Борисова', 'Григорий Фролов', 'Марина Орлова', 'Роман Зайцев',
      'Дарья Соловьёва', 'Артём Егоров', 'Полина Крылова', 'Кирилл Герасимов', 'Валерия Титова',
      'Станислав Никитин', 'Алина Калинина', 'Тимур Романов', 'Вероника Власова', 'Глеб Белов',
      'Ульяна Медведева', 'Даниил Антонов', 'Ксения Тарасова', 'Филипп Жуков', 'Арина Баранов',
      'Вадим Симонов', 'София Рогова', 'Леонид Воронов', 'Виктория Фомина', 'Никита Данилов',
      'Алиса Журавлёва', 'Константин Макаров', 'Милана Блинова', 'Егор Колесников', 'Зоя Карпова',
    ];
    while (contactsRows.length < 50) {
      const i = contactsRows.length;
      const [first, last] = contactNamesRepair[i].split(' ');
      const [c] = await knex('contacts')
        .insert({
          organization_id: org.id,
          first_name: first,
          last_name: last,
          telegram_id: `demo_contact_${String(i + 1).padStart(2, '0')}`,
        })
        .returning('id', 'telegram_id', 'first_name', 'last_name');
      contactsRows = [...contactsRows, c];
    }
    contacts = contactsRows.map((c: any) => ({
      id: c.id,
      telegram_id: c.telegram_id ?? null,
      first_name: c.first_name ?? '',
      last_name: c.last_name ?? '',
    }));
    const pipelineRow = await knex('pipelines').where({ organization_id: org.id, is_default: true }).first();
    if (!pipelineRow) {
      console.log('⏭️ Repair: no default pipeline. Skip.');
      return;
    }
    pipeline = pipelineRow;
    stages = await knex('stages').where({ pipeline_id: pipeline.id }).orderBy('order_index') as { id: string; name: string }[];
    companies = (await knex('companies').where({ organization_id: org.id })) as { id: string; name: string }[];
    users = await knex('users').where({ organization_id: org.id }).select('id', 'email') as { id: string; email: string }[];
    console.log('✅ Repair: loaded org, 5 accounts, 50 contacts, pipeline.');
  }

  // Папки для каждого аккаунта — немного разные наборы (работа, личное, ворк, моё, папка и т.д.)
  const DEMO_FOLDER_SETS: { folder_id: number; folder_title: string; order_index: number }[][] = [
    [{ folder_id: 0, folder_title: 'Все чаты', order_index: 0 }, { folder_id: 2, folder_title: 'Работа', order_index: 1 }, { folder_id: 3, folder_title: 'Личное', order_index: 2 }, { folder_id: 4, folder_title: 'Ворк', order_index: 3 }],
    [{ folder_id: 0, folder_title: 'Все чаты', order_index: 0 }, { folder_id: 2, folder_title: 'Моё', order_index: 1 }, { folder_id: 3, folder_title: 'Папка', order_index: 2 }, { folder_id: 4, folder_title: 'Клиенты', order_index: 3 }],
    [{ folder_id: 0, folder_title: 'Все чаты', order_index: 0 }, { folder_id: 2, folder_title: 'Ворк', order_index: 1 }, { folder_id: 3, folder_title: 'Личное', order_index: 2 }, { folder_id: 4, folder_title: 'Работа', order_index: 3 }, { folder_id: 5, folder_title: 'Проекты', order_index: 4 }],
    [{ folder_id: 0, folder_title: 'Все чаты', order_index: 0 }, { folder_id: 2, folder_title: 'Продажи', order_index: 1 }, { folder_id: 3, folder_title: 'Поддержка', order_index: 2 }, { folder_id: 4, folder_title: 'Личное', order_index: 3 }],
    [{ folder_id: 0, folder_title: 'Все чаты', order_index: 0 }, { folder_id: 2, folder_title: 'Руководство', order_index: 1 }, { folder_id: 3, folder_title: 'Команда', order_index: 2 }, { folder_id: 4, folder_title: 'Внешние', order_index: 3 }],
  ];

  for (let accIdx = 0; accIdx < bdAccounts.length; accIdx++) {
    const acc = bdAccounts[accIdx];
    const folders = DEMO_FOLDER_SETS[accIdx] ?? DEMO_FOLDER_SETS[0];
    for (const f of folders) {
      await knex('bd_account_sync_folders')
        .insert({
          bd_account_id: acc.id,
          folder_id: f.folder_id,
          folder_title: f.folder_title,
          order_index: f.order_index,
        })
        .onConflict(['bd_account_id', 'folder_id'])
        .merge(['folder_title', 'order_index']);
    }
  }

  const syncChats: { bd_account_id: string; telegram_chat_id: string; contact_id: string; title: string; folder_id: number }[] = [];
  for (let accIdx = 0; accIdx < bdAccounts.length; accIdx++) {
    const acc = bdAccounts[accIdx];
    const folders = DEMO_FOLDER_SETS[accIdx] ?? DEMO_FOLDER_SETS[0];
    const customFolderIds = folders.filter((f) => f.folder_id !== 0).map((f) => f.folder_id);
    const startContactIdx = accIdx * CHATS_PER_ACCOUNT;
    for (let j = 0; j < CHATS_PER_ACCOUNT; j++) {
      const contact = contacts[startContactIdx + j];
      if (!contact?.telegram_id?.trim()) continue;
      const title = [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim() || contact.telegram_id || contact.id || 'Chat';
      const folderId = customFolderIds.length > 0 ? customFolderIds[j % customFolderIds.length]! : 0;
      syncChats.push({
        bd_account_id: acc.id,
        telegram_chat_id: contact.telegram_id,
        contact_id: contact.id,
        title,
        folder_id: folderId,
      });
    }
  }

  for (const sc of syncChats) {
    await knex('bd_account_sync_chats')
      .insert({
        bd_account_id: sc.bd_account_id,
        telegram_chat_id: sc.telegram_chat_id,
        title: sc.title,
        peer_type: 'user',
        is_folder: false,
        folder_id: sc.folder_id,
        history_exhausted: true,
        telegram_unread_count: 0,
        telegram_last_message_at: randomPastDate(),
        telegram_last_message_preview: 'Демо-сообщение',
      })
      .onConflict(['bd_account_id', 'telegram_chat_id'])
      .merge(['title', 'folder_id', 'history_exhausted', 'telegram_last_message_at', 'telegram_last_message_preview']);
  }
  for (const sc of syncChats) {
    const folderIdsToInsert = sc.folder_id === 0 ? [0] : [0, sc.folder_id];
    for (const fid of folderIdsToInsert) {
      await knex('bd_account_sync_chat_folders')
        .insert({ bd_account_id: sc.bd_account_id, telegram_chat_id: sc.telegram_chat_id, folder_id: fid })
        .onConflict(['bd_account_id', 'telegram_chat_id', 'folder_id'])
        .merge(['folder_id']);
    }
  }
  console.log(`✅ Sync chats: ${syncChats.length}`);

  const contactByChannelId = new Map<string | undefined, { id: string }>();
  for (const c of contacts) {
    contactByChannelId.set(c.telegram_id, { id: c.id });
  }

  let messageCount = 0;
  for (const sc of syncChats) {
    const contactId = contactByChannelId.get(sc.telegram_chat_id)?.id;
    if (!contactId) continue;
    const acc = bdAccounts.find((a) => a.id === sc.bd_account_id);
    if (!acc) continue;

    const numMessages = MESSAGES_PER_CHAT_MIN + Math.floor(Math.random() * (MESSAGES_PER_CHAT_MAX - MESSAGES_PER_CHAT_MIN + 1));
    const dates: Date[] = [];
    for (let i = 0; i < numMessages; i++) {
      dates.push(randomPastDate());
    }
    dates.sort((a, b) => a.getTime() - b.getTime());

    for (let i = 0; i < numMessages; i++) {
      const isOut = i % 2 === 0;
      const samples = isOut ? OUTBOUND_SAMPLES : INBOUND_SAMPLES;
      const content = samples[Math.floor(Math.random() * samples.length)];
      const sentAt = dates[i];
      const telegramMessageId = String(i + 1);

      await knex('messages').insert({
        id: randomUUID(),
        organization_id: org.id,
        contact_id: contactId,
        bd_account_id: acc.id,
        channel: 'telegram',
        channel_id: sc.telegram_chat_id,
        direction: isOut ? 'outbound' : 'inbound',
        content,
        status: 'delivered',
        unread: false,
        metadata: {},
        sent_at: sentAt,
        telegram_message_id: telegramMessageId,
        telegram_date: sentAt,
        loaded_at: sentAt,
      });
      messageCount++;
    }
  }
  console.log(`✅ Messages: ${messageCount}`);

  // Демо-кампания для лидов (чтобы в карточке лида отображалась кампания)
  let campaignId: string | null = null;
  const existingCampaign = await knex('campaigns').where({ organization_id: org.id, name: 'Демо-кампания' }).first() as { id: string } | undefined;
  if (existingCampaign) {
    campaignId = existingCampaign.id;
  } else {
    const [inserted] = await knex('campaigns')
      .insert({
        organization_id: org.id,
        pipeline_id: pipeline.id,
        name: 'Демо-кампания',
        status: 'completed',
      })
      .returning('id');
    campaignId = inserted?.id ?? null;
  }

  // Лиды вместо сделок: 8 лидов от минус недели до плюс недели, с привязкой к диалогам (conversations)
  const leadDaysFromToday = [-7, -5, -3, -1, 0, 2, 4, 7];
  for (let i = 0; i < 8; i++) {
    const stage = stages[i % stages.length];
    const contact = contacts[i * 5];
    if (!stage || !contact) continue;
    const createdAt = daysFromTodayAt10(leadDaysFromToday[i] ?? 0);
    const [lead] = await knex('leads')
      .insert({
        organization_id: org.id,
        contact_id: contact.id,
        pipeline_id: pipeline.id,
        stage_id: stage.id,
        order_index: i,
        created_at: createdAt,
        updated_at: createdAt,
      })
      .returning('id');
    if (!lead) continue;
    const sc = syncChats[i * 5];
    if (sc) {
      await knex('conversations')
        .insert({
          id: randomUUID(),
          organization_id: org.id,
          bd_account_id: sc.bd_account_id,
          channel: 'telegram',
          channel_id: sc.telegram_chat_id,
          contact_id: contact.id,
          lead_id: lead.id,
          campaign_id: campaignId ?? null,
          became_lead_at: createdAt,
          created_at: createdAt,
          updated_at: createdAt,
        })
        .onConflict(['organization_id', 'bd_account_id', 'channel', 'channel_id'])
        .merge(['lead_id', 'campaign_id', 'became_lead_at', 'updated_at']);
    }
  }
  console.log('✅ Leads: 8 (with conversations for messaging)');

  console.log('\n🎉 Demo seed completed.');
  console.log('\n📝 Demo access:');
  console.log(`   Workspace: "${org.name}" (slug: ${DEMO_ORG_SLUG})`);
  console.log('   Logins: demo1@getsale.com … demo5@getsale.com');
  console.log(`   Password: ${DEMO_PASSWORD}`);
  console.log('   Demo Telegram accounts are read-only (no sending, no real connection).');
}
