import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, MessageReceivedEvent } from '@getsale/events';
import { MessageChannel, MessageDirection, MessageStatus } from '@getsale/types';

interface TelegramClientInfo {
  client: TelegramClient;
  accountId: string;
  organizationId: string;
  userId: string;
  phoneNumber: string;
  isConnected: boolean;
  lastActivity: Date;
  reconnectAttempts: number;
}

export class TelegramManager {
  private clients: Map<string, TelegramClientInfo> = new Map();
  private pool: Pool;
  private rabbitmq: RabbitMQClient;
  private reconnectIntervals: Map<string, NodeJS.Timeout> = new Map();
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly RECONNECT_DELAY = 5000; // 5 seconds

  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly CLEANUP_INTERVAL = 60000; // 1 minute
  
  private sessionSaveInterval: NodeJS.Timeout | null = null;
  private readonly SESSION_SAVE_INTERVAL = 300000; // 5 minutes - save sessions periodically

  constructor(pool: Pool, rabbitmq: RabbitMQClient) {
    this.pool = pool;
    this.rabbitmq = rabbitmq;
    // Start periodic cleanup of inactive clients
    this.startCleanupInterval();
    // Start periodic session saving to keep sessions alive
    this.startSessionSaveInterval();
  }

  /**
   * Send authentication code to phone number
   */
  async sendCode(
    accountId: string,
    organizationId: string,
    userId: string,
    phoneNumber: string,
    apiId: number,
    apiHash: string
  ): Promise<{ phoneCodeHash: string }> {
    try {
      // Check if client already exists for this account
      if (this.clients.has(accountId)) {
        await this.disconnectAccount(accountId);
      }

      const session = new StringSession('');
      const client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 5,
        retryDelay: 1000,
        timeout: 30000, // Increased timeout to handle datacenter migration
        // Don't disable updates, but we won't set up handlers until after auth
      });

      // Connect client with proper error handling for datacenter migration
      try {
        await client.connect();
        console.log(`[TelegramManager] Connected client for sending code to ${phoneNumber}`);
        
        // Wait a bit for connection to stabilize and avoid builder.resolve errors
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error: any) {
        // If connection fails, clean up and rethrow
        console.error(`[TelegramManager] Connection error for ${phoneNumber}:`, error.message);
        throw error;
      }

      // Send code using the API
      const result = await client.invoke(
        new Api.auth.SendCode({
          phoneNumber,
          apiId,
          apiHash,
          settings: new Api.CodeSettings({}),
        })
      );

      const phoneCodeHash = (result as Api.auth.SentCode).phoneCodeHash;

      // Store temporary client info (not fully connected yet)
      const clientInfo: TelegramClientInfo = {
        client,
        accountId,
        organizationId,
        userId,
        phoneNumber,
        isConnected: false,
        lastActivity: new Date(),
        reconnectAttempts: 0,
      };

      this.clients.set(accountId, clientInfo);

      return { phoneCodeHash };
    } catch (error: any) {
      console.error(`[TelegramManager] Error sending code for account ${accountId}:`, error);
      await this.updateAccountStatus(accountId, 'error', error.message || 'Failed to send code');
      throw error;
    }
  }

  /**
   * Sign in with phone code
   */
  async signIn(
    accountId: string,
    phoneNumber: string,
    phoneCode: string,
    phoneCodeHash: string
  ): Promise<{ requiresPassword: boolean }> {
    try {
      const clientInfo = this.clients.get(accountId);
      if (!clientInfo || !clientInfo.client) {
        throw new Error('Client not found. Please send code first.');
      }

      const client = clientInfo.client;

      // Sign in with code - DO NOT set up event handlers before sign in
      // Event handlers should only be set up AFTER successful authentication
      // to avoid builder.resolve errors during datacenter migration
      let result: Api.auth.Authorization;
      try {
        result = await client.invoke(
          new Api.auth.SignIn({
            phoneNumber,
            phoneCodeHash,
            phoneCode,
          })
        );
      } catch (error: any) {
        // Check for specific Telegram errors
        if (error.errorMessage === 'PHONE_CODE_INVALID') {
          throw new Error('Неверный код подтверждения. Пожалуйста, запросите новый код.');
        }
        if (error.errorMessage === 'PHONE_CODE_EXPIRED') {
          throw new Error('Код подтверждения истек. Пожалуйста, запросите новый код.');
        }
        if (error.errorMessage === 'PHONE_NUMBER_INVALID') {
          throw new Error('Неверный номер телефона.');
        }
        // Check if password is required
        if (error.errorMessage === 'SESSION_PASSWORD_NEEDED' || error.code === 401) {
          return { requiresPassword: true };
        }
        throw error;
      }

      // If we get here, sign in was successful
      if (result instanceof Api.auth.AuthorizationSignUpRequired) {
        throw new Error('Account not found. Please sign up first.');
      }

      const auth = result as Api.auth.Authorization;
      const user = auth.user as Api.User;

      // Update client info
      clientInfo.isConnected = true;
      clientInfo.phoneNumber = phoneNumber;

      // Set up event handlers AFTER successful authentication
      // This prevents builder.resolve errors during datacenter migration
      this.setupEventHandlers(client, accountId, clientInfo.organizationId);

      // Save session immediately after successful sign in
      await this.saveSession(accountId, client);
      
      // Update account with telegram_id and connection status
      await this.pool.query(
        'UPDATE bd_accounts SET telegram_id = $1, connected_at = NOW(), last_activity = NOW(), is_active = true WHERE id = $2',
        [String(user.id), accountId]
      );

      await this.updateAccountStatus(accountId, 'connected', 'Successfully signed in');

      return { requiresPassword: false };
    } catch (error: any) {
      console.error(`[TelegramManager] Error signing in account ${accountId}:`, error);
      await this.updateAccountStatus(accountId, 'error', error.message || 'Sign in failed');
      throw error;
    }
  }

  /**
   * Sign in with 2FA password
   */
  async signInWithPassword(
    accountId: string,
    password: string
  ): Promise<void> {
    try {
      const clientInfo = this.clients.get(accountId);
      if (!clientInfo || !clientInfo.client) {
        throw new Error('Client not found. Please send code first.');
      }

      const client = clientInfo.client;

      // Get password info - DO NOT set up event handlers before password check
      // Event handlers should only be set up AFTER successful authentication
      const passwordResult = await client.invoke(new Api.account.GetPassword());
      
      // Compute password check
      const { computeCheck } = await import('telegram/Password');
      const passwordCheck = await computeCheck(passwordResult, password);

      // Sign in with password
      const result = await client.invoke(
        new Api.auth.CheckPassword({
          password: passwordCheck,
        })
      );

      const auth = result as Api.auth.Authorization;
      const user = auth.user as Api.User;

      // Update client info
      clientInfo.isConnected = true;

      // Set up event handlers AFTER successful authentication
      // This prevents builder.resolve errors during datacenter migration
      this.setupEventHandlers(client, accountId, clientInfo.organizationId);

      // Save session immediately after successful sign in with password
      await this.saveSession(accountId, client);
      
      // Update account with telegram_id and connection status
      await this.pool.query(
        'UPDATE bd_accounts SET telegram_id = $1, connected_at = NOW(), last_activity = NOW(), is_active = true WHERE id = $2',
        [String(user.id), accountId]
      );

      await this.updateAccountStatus(accountId, 'connected', 'Successfully signed in with password');
    } catch (error: any) {
      console.error(`[TelegramManager] Error signing in with password for account ${accountId}:`, error);
      await this.updateAccountStatus(accountId, 'error', error.message || 'Password sign in failed');
      throw error;
    }
  }

  /**
   * Initialize and connect a Telegram account (for existing sessions)
   */
  async connectAccount(
    accountId: string,
    organizationId: string,
    userId: string,
    phoneNumber: string,
    apiId: number,
    apiHash: string,
    sessionString?: string
  ): Promise<TelegramClient> {
    try {
      // Check if client already exists
      if (this.clients.has(accountId)) {
        const existing = this.clients.get(accountId)!;
        if (existing.isConnected) {
          return existing.client;
        }
        // Disconnect old client
        await this.disconnectAccount(accountId);
      }

      if (!sessionString) {
        throw new Error('Session string is required for existing accounts');
      }

      const session = new StringSession(sessionString);
      const client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 5,
        retryDelay: 1000,
        timeout: 30000, // Increased timeout to 30 seconds to reduce TIMEOUT errors
      });

      // Connect client first
      await client.connect();
      console.log(`[TelegramManager] Connected account ${accountId} (${phoneNumber})`);

      // Wait for connection to stabilize before setting up handlers
      // This helps avoid builder.resolve errors during initialization
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Verify session is valid by checking if we're authorized
      try {
        await client.getMe();
        console.log(`[TelegramManager] Session verified for account ${accountId}`);
      } catch (error: any) {
        console.error(`[TelegramManager] Session invalid for account ${accountId}:`, error.message);
        await client.disconnect();
        throw new Error('Invalid session. Please reconnect the account.');
      }

      // Set up event handlers AFTER verifying session is valid and connection is stable
      // This prevents builder.resolve errors during datacenter migration
      this.setupEventHandlers(client, accountId, organizationId);

      // Save session immediately after connection
      await this.saveSession(accountId, client);

      // Store client info
      const clientInfo: TelegramClientInfo = {
        client,
        accountId,
        organizationId,
        userId,
        phoneNumber,
        isConnected: true,
        lastActivity: new Date(),
        reconnectAttempts: 0,
      };

      this.clients.set(accountId, clientInfo);

      // Update status
      await this.updateAccountStatus(accountId, 'connected', 'Successfully connected');

      return client;
    } catch (error: any) {
      console.error(`[TelegramManager] Error connecting account ${accountId}:`, error);
      await this.updateAccountStatus(accountId, 'error', error.message || 'Connection failed');
      throw error;
    }
  }

  /**
   * Setup event handlers for Telegram client
   * Must be called AFTER client is fully authenticated
   */
  private setupEventHandlers(
    client: TelegramClient,
    accountId: string,
    organizationId: string
  ): void {
    try {
      // Check if client is ready before setting up handlers
      if (!client.connected) {
        console.warn(`[TelegramManager] Client not connected for account ${accountId}, skipping event handlers`);
        return;
      }

      // Handle new messages - use UpdateNewMessage
      // Wrap in try-catch to prevent builder.resolve errors from crashing
      try {
        client.addEventHandler(
          async (event: any) => {
            try {
              // Verify client is still connected before processing
              if (!client.connected) {
                return;
              }

              // Check if account still exists and is active before processing
              const accountCheck = await this.pool.query(
                'SELECT id, is_active FROM bd_accounts WHERE id = $1',
                [accountId]
              );
              
              if (accountCheck.rows.length === 0 || !accountCheck.rows[0].is_active) {
                console.log(`[TelegramManager] Account ${accountId} no longer exists or is inactive, disconnecting...`);
                await this.disconnectAccount(accountId);
                return;
              }

              // event is an UpdateNewMessage or UpdateNewChannelMessage
              const message = event.message;
              if (message && message instanceof Api.Message) {
                await this.handleNewMessage(message, accountId, organizationId);
              }
            } catch (error: any) {
              // Handle TIMEOUT and other errors gracefully
              if (error.message === 'TIMEOUT' || error.message?.includes('TIMEOUT')) {
                console.warn(`[TelegramManager] Timeout error for account ${accountId}, will retry:`, error.message);
                // Don't disconnect on timeout - it's a temporary network issue
                return;
              }
              // Handle builder.resolve errors (can occur during datacenter migration)
              if (error.message?.includes('builder.resolve is not a function') || 
                  error.message?.includes('builder.resolve') ||
                  error.stack?.includes('builder.resolve')) {
                // Silently ignore - this is an internal library issue
                return;
              }
              console.error(`[TelegramManager] Error handling new message for account ${accountId}:`, error);
            }
          },
          {
            func: (update: any) => {
              try {
                return update instanceof Api.UpdateNewMessage || 
                       update instanceof Api.UpdateNewChannelMessage;
              } catch (error: any) {
                // Ignore errors in filter function
                if (error.message?.includes('builder.resolve')) {
                  return false;
                }
                return false;
              }
            }
          }
        );
      } catch (error: any) {
        // If setting up handler fails due to builder.resolve, just log and continue
        if (error.message?.includes('builder.resolve') || error.stack?.includes('builder.resolve')) {
          console.warn(`[TelegramManager] Could not set up message handler for ${accountId} (builder.resolve issue), will retry later`);
          return;
        }
        throw error;
      }

      // Handle disconnect events using client's disconnect event
      // Note: gramJS doesn't have a direct disconnect event, so we monitor connection state
      // We'll handle reconnection in the error handlers and through periodic checks

      // Add error handler for client errors
      // Wrap in try-catch to prevent builder.resolve errors during setup
      try {
        client.addEventHandler(
          async (error: any) => {
            try {
              // Silently ignore builder.resolve errors - they're internal library issues
              if (error.message?.includes('builder.resolve is not a function') ||
                  error.message?.includes('builder.resolve') ||
                  error.stack?.includes('builder.resolve')) {
                return; // Silently ignore
              }

              if (error.message === 'TIMEOUT' || error.message?.includes('TIMEOUT')) {
                console.warn(`[TelegramManager] Client timeout for account ${accountId}:`, error.message);
                return; // Don't disconnect on timeout
              }
              
              // Check if account still exists
              const accountCheck = await this.pool.query(
                'SELECT id, is_active FROM bd_accounts WHERE id = $1',
                [accountId]
              );
              
              if (accountCheck.rows.length === 0 || !accountCheck.rows[0].is_active) {
                console.log(`[TelegramManager] Account ${accountId} no longer exists, disconnecting...`);
                await this.disconnectAccount(accountId);
              }
            } catch (err: any) {
              // Ignore builder.resolve errors in error handler itself
              if (err.message?.includes('builder.resolve') || err.stack?.includes('builder.resolve')) {
                return;
              }
              console.error(`[TelegramManager] Error in error handler for account ${accountId}:`, err);
            }
          },
          {
            func: (update: any) => {
              try {
                // Catch all errors, but filter out builder.resolve errors
                if (update instanceof Error) {
                  if (update.message?.includes('builder.resolve')) {
                    return false; // Don't process builder.resolve errors
                  }
                  return true;
                }
                return update && update.message;
              } catch (error: any) {
                // Ignore errors in filter function
                return false;
              }
            }
          }
        );
      } catch (error: any) {
        // If setting up error handler fails, just log and continue
        if (error.message?.includes('builder.resolve') || error.stack?.includes('builder.resolve')) {
          console.warn(`[TelegramManager] Could not set up error handler for ${accountId} (builder.resolve issue)`);
          return;
        }
        throw error;
      }
    } catch (error: any) {
      console.error(`[TelegramManager] Error setting up event handlers:`, error.message);
      // Don't throw - allow client to continue without event handlers
    }
  }

  /**
   * Handle new incoming message
   */
  private async handleNewMessage(
    message: Api.Message,
    accountId: string,
    organizationId: string
  ): Promise<void> {
    try {
      if (!message.text && !message.media) {
        return; // Skip empty messages
      }

      // Extract chat ID and sender ID properly
      let chatId = '';
      let senderId = '';
      
      if (message.peerId) {
        if (message.peerId instanceof Api.PeerUser) {
          chatId = String(message.peerId.userId);
        } else if (message.peerId instanceof Api.PeerChat) {
          chatId = String(message.peerId.chatId);
        } else if (message.peerId instanceof Api.PeerChannel) {
          chatId = String(message.peerId.channelId);
        } else {
          chatId = String(message.peerId);
        }
      }
      
      if (message.fromId) {
        if (message.fromId instanceof Api.PeerUser) {
          senderId = String(message.fromId.userId);
        } else {
          senderId = String(message.fromId);
        }
      }
      
      const text = message.text || '';
      const messageId = String(message.id);

      // Find or create contact
      let contactId: string | null = null;
      const contactResult = await this.pool.query(
        'SELECT id FROM contacts WHERE telegram_id = $1 AND organization_id = $2 LIMIT 1',
        [senderId, organizationId]
      );

      if (contactResult.rows.length > 0) {
        contactId = contactResult.rows[0].id;
      }

      // Save message to database
      const msgResult = await this.pool.query(
        `INSERT INTO messages (organization_id, bd_account_id, contact_id, channel, channel_id, direction, content, status, unread, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [
          organizationId,
          accountId,
          contactId,
          MessageChannel.TELEGRAM,
          chatId,
          MessageDirection.INBOUND,
          text,
          MessageStatus.DELIVERED,
          true,
          JSON.stringify({
            telegramMessageId: messageId,
            senderId,
            hasMedia: !!message.media,
          }),
        ]
      );

      const savedMessage = msgResult.rows[0];

      // Update last activity
      const clientInfo = this.clients.get(accountId);
      if (clientInfo) {
        clientInfo.lastActivity = new Date();
        await this.pool.query(
          'UPDATE bd_accounts SET last_activity = NOW() WHERE id = $1',
          [accountId]
        );
      }

      // Publish event
      const event: MessageReceivedEvent = {
        id: randomUUID(),
        type: EventType.MESSAGE_RECEIVED,
        timestamp: new Date(),
        organizationId,
        data: {
          messageId: savedMessage.id,
          channel: MessageChannel.TELEGRAM,
          contactId: contactId || undefined,
          bdAccountId: accountId,
          content: text,
        },
      };

      await this.rabbitmq.publishEvent(event);
    } catch (error) {
      console.error(`[TelegramManager] Error handling new message:`, error);
    }
  }

  /**
   * Get all dialogs for an account
   */
  async getDialogs(accountId: string): Promise<any[]> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }

    try {
      const dialogs = await clientInfo.client.getDialogs({ limit: 100 });
      return dialogs.map((dialog: any) => ({
        id: String(dialog.id),
        name: dialog.name || dialog.title || 'Unknown',
        unreadCount: dialog.unreadCount || 0,
        lastMessage: dialog.message?.text || '',
        lastMessageDate: dialog.message?.date,
        isUser: dialog.isUser,
        isGroup: dialog.isGroup,
        isChannel: dialog.isChannel,
      }));
    } catch (error) {
      console.error(`[TelegramManager] Error getting dialogs for ${accountId}:`, error);
      throw error;
    }
  }

  /**
   * Send message via Telegram
   */
  async sendMessage(
    accountId: string,
    chatId: string,
    text: string
  ): Promise<Api.Message> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }

    try {
      const message = await clientInfo.client.sendMessage(chatId, { message: text });
      
      // Update last activity
      clientInfo.lastActivity = new Date();
      await this.pool.query(
        'UPDATE bd_accounts SET last_activity = NOW() WHERE id = $1',
        [accountId]
      );

      return message;
    } catch (error) {
      console.error(`[TelegramManager] Error sending message:`, error);
      throw error;
    }
  }

  /**
   * Disconnect an account
   */
  async disconnectAccount(accountId: string): Promise<void> {
    const clientInfo = this.clients.get(accountId);
    if (clientInfo) {
      try {
        await clientInfo.client.disconnect();
      } catch (error) {
        console.error(`[TelegramManager] Error disconnecting account ${accountId}:`, error);
      }
      this.clients.delete(accountId);
      
      // Clear reconnect interval
      const interval = this.reconnectIntervals.get(accountId);
      if (interval) {
        clearInterval(interval);
        this.reconnectIntervals.delete(accountId);
      }
    }
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(accountId: string): void {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo) return;

    if (clientInfo.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error(`[TelegramManager] Max reconnect attempts reached for ${accountId}`);
      this.updateAccountStatus(accountId, 'error', 'Max reconnect attempts reached');
      return;
    }

    // Clear existing interval
    const existing = this.reconnectIntervals.get(accountId);
    if (existing) {
      clearInterval(existing);
    }

    // Schedule reconnect
    const interval = setTimeout(async () => {
      try {
        clientInfo.reconnectAttempts++;
        console.log(`[TelegramManager] Attempting to reconnect account ${accountId} (attempt ${clientInfo.reconnectAttempts})`);
        
        // Get account details from DB
        const result = await this.pool.query(
          'SELECT api_id, api_hash, session_string, phone_number FROM bd_accounts WHERE id = $1',
          [accountId]
        );

        if (result.rows.length === 0) {
          throw new Error('Account not found');
        }

        const account = result.rows[0];
        await this.connectAccount(
          accountId,
          account.organization_id || clientInfo.organizationId,
          clientInfo.userId,
          account.phone_number || clientInfo.phoneNumber,
          parseInt(account.api_id),
          account.api_hash,
          account.session_string
        );

        // Reset reconnect attempts on success
        clientInfo.reconnectAttempts = 0;
        this.reconnectIntervals.delete(accountId);
      } catch (error) {
        console.error(`[TelegramManager] Reconnection failed for ${accountId}:`, error);
        // Schedule next attempt
        this.scheduleReconnect(accountId);
      }
    }, this.RECONNECT_DELAY);

    this.reconnectIntervals.set(accountId, interval);
  }

  /**
   * Update account status in database
   */
  private async updateAccountStatus(
    accountId: string,
    status: string,
    message?: string
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO bd_account_status (account_id, status, message)
         VALUES ($1, $2, $3)`,
        [accountId, status, message || '']
      );
    } catch (error) {
      console.error(`[TelegramManager] Error updating account status:`, error);
    }
  }

  /**
   * Get client info
   */
  getClientInfo(accountId: string): TelegramClientInfo | undefined {
    return this.clients.get(accountId);
  }

  /**
   * Check if account is connected
   */
  isConnected(accountId: string): boolean {
    const clientInfo = this.clients.get(accountId);
    return clientInfo?.isConnected || false;
  }

  /**
   * Initialize all active accounts on startup
   */
  async initializeActiveAccounts(): Promise<void> {
    try {
      const result = await this.pool.query(
        `SELECT id, organization_id, phone_number, api_id, api_hash, session_string
         FROM bd_accounts
         WHERE is_active = true AND session_string IS NOT NULL AND session_string != ''`
      );

      for (const account of result.rows) {
        try {
          // Use organization_id as userId fallback (will be replaced when user connects)
          const userId = account.organization_id;
          
          await this.connectAccount(
            account.id,
            account.organization_id,
            userId,
            account.phone_number,
            parseInt(account.api_id),
            account.api_hash,
            account.session_string
          );
        } catch (error) {
          console.error(`[TelegramManager] Failed to initialize account ${account.id}:`, error);
        }
      }
    } catch (error) {
      console.error('[TelegramManager] Error initializing active accounts:', error);
    }
  }

  /**
   * Start periodic cleanup of inactive clients
   */
  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(async () => {
      try {
        await this.cleanupInactiveClients();
      } catch (error) {
        console.error('[TelegramManager] Error during cleanup:', error);
      }
    }, this.CLEANUP_INTERVAL);
  }

  /**
   * Clean up clients for accounts that no longer exist or are inactive
   */
  private async cleanupInactiveClients(): Promise<void> {
    const accountIds = Array.from(this.clients.keys());
    
    if (accountIds.length === 0) {
      return;
    }

    try {
      const result = await this.pool.query(
        `SELECT id FROM bd_accounts 
         WHERE id = ANY($1::uuid[]) AND is_active = true`,
        [accountIds]
      );

      const activeAccountIds = new Set(result.rows.map((row: any) => row.id));

      // Disconnect clients for accounts that are no longer active
      for (const accountId of accountIds) {
        if (!activeAccountIds.has(accountId)) {
          console.log(`[TelegramManager] Cleaning up inactive client for account ${accountId}`);
          await this.disconnectAccount(accountId);
        }
      }
    } catch (error) {
      console.error('[TelegramManager] Error checking active accounts:', error);
    }
  }

  /**
   * Save session to database
   */
  private async saveSession(accountId: string, client: TelegramClient): Promise<void> {
    try {
      const sessionString = client.session.save() as string;
      await this.pool.query(
        'UPDATE bd_accounts SET session_string = $1, last_activity = NOW() WHERE id = $2',
        [sessionString, accountId]
      );
    } catch (error) {
      console.error(`[TelegramManager] Error saving session for account ${accountId}:`, error);
    }
  }

  /**
   * Start periodic session saving to keep sessions alive
   */
  private startSessionSaveInterval(): void {
    this.sessionSaveInterval = setInterval(async () => {
      try {
        await this.saveAllSessions();
      } catch (error) {
        console.error('[TelegramManager] Error during session save:', error);
      }
    }, this.SESSION_SAVE_INTERVAL);
  }

  /**
   * Save all active sessions to database
   */
  private async saveAllSessions(): Promise<void> {
    for (const [accountId, clientInfo] of this.clients) {
      if (clientInfo.isConnected && clientInfo.client.connected) {
        try {
          await this.saveSession(accountId, clientInfo.client);
          // Update last activity
          clientInfo.lastActivity = new Date();
        } catch (error) {
          console.error(`[TelegramManager] Error saving session for account ${accountId}:`, error);
        }
      }
    }
  }

  /**
   * Cleanup on shutdown
   */
  async shutdown(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    
    if (this.sessionSaveInterval) {
      clearInterval(this.sessionSaveInterval);
      this.sessionSaveInterval = null;
    }

    // Save all sessions before disconnecting
    await this.saveAllSessions();

    for (const [accountId] of this.clients) {
      await this.disconnectAccount(accountId);
    }
  }
}

