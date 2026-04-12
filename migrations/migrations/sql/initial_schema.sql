--
-- PostgreSQL database dump
--

-- Dumped from database version 15.16
-- Dumped by pg_dump version 15.16

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS '';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: analytics_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analytics_metrics (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    metric_type character varying(100) NOT NULL,
    metric_name character varying(255) NOT NULL,
    value numeric(8,2) NOT NULL,
    dimensions jsonb DEFAULT '{}'::jsonb,
    recorded_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    action character varying(100) NOT NULL,
    resource_type character varying(50),
    resource_id character varying(255),
    old_value jsonb,
    new_value jsonb,
    ip character varying(45),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: automation_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_executions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rule_id uuid NOT NULL,
    trigger_event character varying(100) NOT NULL,
    status character varying(50) NOT NULL,
    result jsonb,
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    organization_id uuid,
    entity_type character varying(20) NOT NULL,
    entity_id uuid NOT NULL,
    deal_id uuid,
    correlation_id uuid,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    trigger_event_id uuid,
    breach_date date
);


--
-- Name: automation_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    trigger_type character varying(100) NOT NULL,
    trigger_conditions jsonb NOT NULL,
    actions jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: bd_account_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bd_account_status (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    status character varying(50) NOT NULL,
    message text,
    recorded_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: bd_account_sync_chat_folders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bd_account_sync_chat_folders (
    bd_account_id uuid NOT NULL,
    telegram_chat_id character varying(64) NOT NULL,
    folder_id integer NOT NULL
);


--
-- Name: bd_account_sync_chats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bd_account_sync_chats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bd_account_id uuid NOT NULL,
    telegram_chat_id character varying(255) NOT NULL,
    title character varying(500),
    peer_type character varying(50) NOT NULL,
    is_folder boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    telegram_unread_count integer DEFAULT 0,
    telegram_last_message_at timestamp with time zone,
    telegram_last_message_preview text,
    telegram_dialog_payload jsonb,
    last_synced_at timestamp with time zone,
    folder_id integer,
    history_exhausted boolean DEFAULT false NOT NULL,
    access_hash bigint,
    sync_list_origin character varying(32) DEFAULT 'sync_selection'::character varying NOT NULL
);


--
-- Name: bd_account_sync_folders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bd_account_sync_folders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bd_account_id uuid NOT NULL,
    folder_id integer NOT NULL,
    folder_title character varying(255) NOT NULL,
    order_index integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    is_user_created boolean DEFAULT false NOT NULL,
    icon character varying(20)
);


--
-- Name: bd_account_warmup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bd_account_warmup (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bd_account_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    warmup_status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    current_day integer DEFAULT 0 NOT NULL,
    daily_limit_schedule jsonb DEFAULT '[3, 5, 8, 10, 12, 14, 16, 18, 20, 20, 20, 20, 20, 20]'::jsonb NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: bd_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bd_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    telegram_id character varying(100) NOT NULL,
    phone_number character varying(50),
    api_id character varying(255),
    api_hash character varying(255),
    session_string text,
    is_active boolean DEFAULT true NOT NULL,
    connected_at timestamp with time zone,
    last_activity timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    sync_status character varying(50) DEFAULT 'idle'::character varying,
    sync_error text,
    sync_progress_total integer DEFAULT 0,
    sync_progress_done integer DEFAULT 0,
    sync_started_at timestamp with time zone,
    sync_completed_at timestamp with time zone,
    created_by_user_id uuid,
    first_name character varying(255),
    last_name character varying(255),
    username character varying(255),
    bio text,
    photo_file_id character varying(512),
    display_name character varying(255),
    is_demo boolean DEFAULT false NOT NULL,
    proxy_config jsonb,
    session_encrypted boolean DEFAULT false,
    send_blocked_until timestamp with time zone,
    max_dm_per_day integer,
    connection_state character varying(32) DEFAULT 'disconnected'::character varying NOT NULL,
    disconnect_reason text,
    last_error_code character varying(128),
    last_error_at timestamp with time zone,
    flood_wait_until timestamp with time zone,
    flood_wait_seconds integer,
    timezone character varying(64),
    working_hours_start character varying(5),
    working_hours_end character varying(5),
    working_days integer[],
    auto_responder_enabled boolean DEFAULT false NOT NULL,
    auto_responder_system_prompt text,
    auto_responder_history_count integer DEFAULT 25 NOT NULL,
    flood_reason text,
    flood_last_at timestamp with time zone,
    spam_restricted_at timestamp with time zone,
    spam_restriction_source character varying(32),
    peer_flood_count_1h integer DEFAULT 0 NOT NULL,
    peer_flood_first_at timestamp with time zone,
    last_spambot_check_at timestamp with time zone,
    last_spambot_result text,
    spam_check_retry_count integer DEFAULT 0 NOT NULL
);


--
-- Name: campaign_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_participants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    bd_account_id uuid,
    channel_id character varying(100),
    status character varying(50) DEFAULT 'pending'::character varying NOT NULL,
    current_step integer DEFAULT 0 NOT NULL,
    next_send_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    enqueue_order integer DEFAULT 0 NOT NULL,
    replied_at timestamp with time zone,
    failed_at timestamp with time zone,
    last_error text
);


--
-- Name: campaign_sends; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_sends (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_participant_id uuid NOT NULL,
    sequence_step integer NOT NULL,
    message_id uuid,
    sent_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    status character varying(50) DEFAULT 'sent'::character varying NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    read_at timestamp with time zone
);


--
-- Name: campaign_sequences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_sequences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    order_index integer NOT NULL,
    template_id uuid NOT NULL,
    delay_hours integer DEFAULT 24 NOT NULL,
    conditions jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    trigger_type character varying(20) DEFAULT 'delay'::character varying NOT NULL,
    delay_minutes integer DEFAULT 0 NOT NULL,
    is_hidden boolean DEFAULT false NOT NULL
);


--
-- Name: campaign_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaign_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    campaign_id uuid,
    name character varying(255) NOT NULL,
    channel character varying(50) NOT NULL,
    content text NOT NULL,
    conditions jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    media_url text,
    media_type character varying(30),
    media_metadata jsonb DEFAULT '{}'::jsonb,
    variant_group uuid,
    variant_weight integer DEFAULT 100 NOT NULL
);


--
-- Name: campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaigns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    company_id uuid,
    pipeline_id uuid,
    name character varying(255) NOT NULL,
    status character varying(50) DEFAULT 'draft'::character varying NOT NULL,
    target_audience jsonb DEFAULT '{}'::jsonb,
    schedule jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    lead_creation_settings jsonb,
    created_by_user_id uuid,
    deleted_at timestamp with time zone
);


--
-- Name: companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.companies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    industry character varying(100),
    size character varying(50),
    description text,
    goals jsonb,
    policies jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp with time zone,
    website character varying(500)
);


--
-- Name: contact_discovery_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_discovery_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    type character varying(255) NOT NULL,
    status character varying(255) DEFAULT 'pending'::character varying NOT NULL,
    progress integer DEFAULT 0 NOT NULL,
    total integer DEFAULT 0 NOT NULL,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    results jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by_user_id uuid
);


--
-- Name: contact_telegram_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contact_telegram_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    bd_account_id uuid NOT NULL,
    telegram_chat_id character varying(64) NOT NULL,
    telegram_chat_title character varying(512),
    search_keyword character varying(256),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    company_id uuid,
    first_name character varying(255) NOT NULL,
    last_name character varying(255),
    email character varying(255),
    phone character varying(50),
    telegram_id character varying(100),
    consent_flags jsonb DEFAULT '{"sms": false, "email": false, "telegram": false, "marketing": false}'::jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    display_name character varying(255),
    username character varying(255),
    bio text,
    premium boolean,
    deleted_at timestamp with time zone
);


--
-- Name: conversation_ai_insights; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_ai_insights (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    account_id uuid,
    type character varying(50) NOT NULL,
    payload_json jsonb NOT NULL,
    model_version character varying(100),
    generated_from_message_id uuid,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    bd_account_id uuid,
    channel character varying(50) NOT NULL,
    channel_id character varying(255) NOT NULL,
    contact_id uuid,
    lead_id uuid,
    campaign_id uuid,
    became_lead_at timestamp with time zone,
    last_viewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    first_manager_reply_at timestamp with time zone,
    shared_chat_created_at timestamp with time zone,
    shared_chat_channel_id bigint,
    won_at timestamp with time zone,
    revenue_amount numeric(12,2),
    lost_at timestamp with time zone,
    loss_reason text,
    shared_chat_invite_link text,
    CONSTRAINT conversations_revenue_only_if_won CHECK (((revenue_amount IS NULL) OR (won_at IS NOT NULL))),
    CONSTRAINT conversations_won_lost_exclusive CHECK ((NOT ((won_at IS NOT NULL) AND (lost_at IS NOT NULL))))
);


--
-- Name: conversion_rates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversion_rates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    from_stage character varying(100),
    to_stage character varying(100),
    rate numeric(8,2) NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: deals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    company_id uuid,
    contact_id uuid,
    pipeline_id uuid NOT NULL,
    stage_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    title character varying(255) NOT NULL,
    value numeric(8,2),
    currency character varying(10),
    history jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    bd_account_id uuid,
    channel character varying(50),
    channel_id character varying(255),
    probability integer,
    expected_close_date date,
    comments text,
    created_by_id uuid,
    lead_id uuid,
    deleted_at timestamp with time zone,
    description text
);


--
-- Name: lead_activity_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lead_activity_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid NOT NULL,
    type character varying(50) NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    correlation_id uuid
);


--
-- Name: leads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.leads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    pipeline_id uuid NOT NULL,
    stage_id uuid NOT NULL,
    order_index integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    responsible_id uuid,
    revenue_amount numeric(14,2),
    deleted_at timestamp with time zone
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid,
    bd_account_id uuid,
    channel character varying(50) NOT NULL,
    channel_id character varying(255),
    direction character varying(20) NOT NULL,
    content text NOT NULL,
    status character varying(50) DEFAULT 'sent'::character varying,
    unread boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    sent_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    telegram_message_id character varying(64),
    telegram_date timestamp with time zone,
    loaded_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    reply_to_telegram_id character varying(64),
    telegram_entities jsonb,
    telegram_media jsonb,
    telegram_extra jsonb,
    our_reactions jsonb,
    reactions jsonb DEFAULT '{}'::jsonb
)
PARTITION BY HASH (organization_id);


--
-- Name: messages_p0; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages_p0 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid,
    bd_account_id uuid,
    channel character varying(50) NOT NULL,
    channel_id character varying(255),
    direction character varying(20) NOT NULL,
    content text NOT NULL,
    status character varying(50) DEFAULT 'sent'::character varying,
    unread boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    sent_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    telegram_message_id character varying(64),
    telegram_date timestamp with time zone,
    loaded_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    reply_to_telegram_id character varying(64),
    telegram_entities jsonb,
    telegram_media jsonb,
    telegram_extra jsonb,
    our_reactions jsonb,
    reactions jsonb DEFAULT '{}'::jsonb
);


--
-- Name: messages_p1; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages_p1 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid,
    bd_account_id uuid,
    channel character varying(50) NOT NULL,
    channel_id character varying(255),
    direction character varying(20) NOT NULL,
    content text NOT NULL,
    status character varying(50) DEFAULT 'sent'::character varying,
    unread boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    sent_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    telegram_message_id character varying(64),
    telegram_date timestamp with time zone,
    loaded_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    reply_to_telegram_id character varying(64),
    telegram_entities jsonb,
    telegram_media jsonb,
    telegram_extra jsonb,
    our_reactions jsonb,
    reactions jsonb DEFAULT '{}'::jsonb
);


--
-- Name: messages_p10; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages_p10 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid,
    bd_account_id uuid,
    channel character varying(50) NOT NULL,
    channel_id character varying(255),
    direction character varying(20) NOT NULL,
    content text NOT NULL,
    status character varying(50) DEFAULT 'sent'::character varying,
    unread boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    sent_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    telegram_message_id character varying(64),
    telegram_date timestamp with time zone,
    loaded_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    reply_to_telegram_id character varying(64),
    telegram_entities jsonb,
    telegram_media jsonb,
    telegram_extra jsonb,
    our_reactions jsonb,
    reactions jsonb DEFAULT '{}'::jsonb
);


--
-- Name: messages_p11; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages_p11 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid,
    bd_account_id uuid,
    channel character varying(50) NOT NULL,
    channel_id character varying(255),
    direction character varying(20) NOT NULL,
    content text NOT NULL,
    status character varying(50) DEFAULT 'sent'::character varying,
    unread boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    sent_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    telegram_message_id character varying(64),
    telegram_date timestamp with time zone,
    loaded_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    reply_to_telegram_id character varying(64),
    telegram_entities jsonb,
    telegram_media jsonb,
    telegram_extra jsonb,
    our_reactions jsonb,
    reactions jsonb DEFAULT '{}'::jsonb
);


--
-- Name: messages_p12; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages_p12 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid,
    bd_account_id uuid,
    channel character varying(50) NOT NULL,
    channel_id character varying(255),
    direction character varying(20) NOT NULL,
    content text NOT NULL,
    status character varying(50) DEFAULT 'sent'::character varying,
    unread boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    sent_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    telegram_message_id character varying(64),
    telegram_date timestamp with time zone,
    loaded_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    reply_to_telegram_id character varying(64),
    telegram_entities jsonb,
    telegram_media jsonb,
    telegram_extra jsonb,
    our_reactions jsonb,
    reactions jsonb DEFAULT '{}'::jsonb
);


--
-- Name: messages_p13; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages_p13 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid,
    bd_account_id uuid,
    channel character varying(50) NOT NULL,
    channel_id character varying(255),
    direction character varying(20) NOT NULL,
    content text NOT NULL,
    status character varying(50) DEFAULT 'sent'::character varying,
    unread boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    sent_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    telegram_message_id character varying(64),
    telegram_date timestamp with time zone,
    loaded_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    reply_to_telegram_id character varying(64),
    telegram_entities jsonb,
    telegram_media jsonb,
    telegram_extra jsonb,
    our_reactions jsonb,
    reactions jsonb DEFAULT '{}'::jsonb
);


--
-- Name: messages_p14; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages_p14 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid,
    bd_account_id uuid,
    channel character varying(50) NOT NULL,
    channel_id character varying(255),
    direction character varying(20) NOT NULL,
    content text NOT NULL,
    status character varying(50) DEFAULT 'sent'::character varying,
    unread boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    sent_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    telegram_message_id character varying(64),
    telegram_date timestamp with time zone,
    loaded_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    reply_to_telegram_id character varying(64),
    telegram_entities jsonb,
    telegram_media jsonb,
    telegram_extra jsonb,
    our_reactions jsonb,
    reactions jsonb DEFAULT '{}'::jsonb
);


--
-- Name: messages_p15; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages_p15 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid,
    bd_account_id uuid,
    channel character varying(50) NOT NULL,
    channel_id character varying(255),
    direction character varying(20) NOT NULL,
    content text NOT NULL,
    status character varying(50) DEFAULT 'sent'::character varying,
    unread boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    sent_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    telegram_message_id character varying(64),
    telegram_date timestamp with time zone,
    loaded_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    reply_to_telegram_id character varying(64),
    telegram_entities jsonb,
    telegram_media jsonb,
    telegram_extra jsonb,
    our_reactions jsonb,
    reactions jsonb DEFAULT '{}'::jsonb
);


--
-- Name: messages_p2; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages_p2 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid,
    bd_account_id uuid,
    channel character varying(50) NOT NULL,
    channel_id character varying(255),
    direction character varying(20) NOT NULL,
    content text NOT NULL,
    status character varying(50) DEFAULT 'sent'::character varying,
    unread boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    sent_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    telegram_message_id character varying(64),
    telegram_date timestamp with time zone,
    loaded_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    reply_to_telegram_id character varying(64),
    telegram_entities jsonb,
    telegram_media jsonb,
    telegram_extra jsonb,
    our_reactions jsonb,
    reactions jsonb DEFAULT '{}'::jsonb
);


--
-- Name: messages_p3; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages_p3 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid,
    bd_account_id uuid,
    channel character varying(50) NOT NULL,
    channel_id character varying(255),
    direction character varying(20) NOT NULL,
    content text NOT NULL,
    status character varying(50) DEFAULT 'sent'::character varying,
    unread boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    sent_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    telegram_message_id character varying(64),
    telegram_date timestamp with time zone,
    loaded_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    reply_to_telegram_id character varying(64),
    telegram_entities jsonb,
    telegram_media jsonb,
    telegram_extra jsonb,
    our_reactions jsonb,
    reactions jsonb DEFAULT '{}'::jsonb
);


--
-- Name: messages_p4; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages_p4 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid,
    bd_account_id uuid,
    channel character varying(50) NOT NULL,
    channel_id character varying(255),
    direction character varying(20) NOT NULL,
    content text NOT NULL,
    status character varying(50) DEFAULT 'sent'::character varying,
    unread boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    sent_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    telegram_message_id character varying(64),
    telegram_date timestamp with time zone,
    loaded_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    reply_to_telegram_id character varying(64),
    telegram_entities jsonb,
    telegram_media jsonb,
    telegram_extra jsonb,
    our_reactions jsonb,
    reactions jsonb DEFAULT '{}'::jsonb
);


--
-- Name: messages_p5; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages_p5 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid,
    bd_account_id uuid,
    channel character varying(50) NOT NULL,
    channel_id character varying(255),
    direction character varying(20) NOT NULL,
    content text NOT NULL,
    status character varying(50) DEFAULT 'sent'::character varying,
    unread boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    sent_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    telegram_message_id character varying(64),
    telegram_date timestamp with time zone,
    loaded_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    reply_to_telegram_id character varying(64),
    telegram_entities jsonb,
    telegram_media jsonb,
    telegram_extra jsonb,
    our_reactions jsonb,
    reactions jsonb DEFAULT '{}'::jsonb
);


--
-- Name: messages_p6; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages_p6 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid,
    bd_account_id uuid,
    channel character varying(50) NOT NULL,
    channel_id character varying(255),
    direction character varying(20) NOT NULL,
    content text NOT NULL,
    status character varying(50) DEFAULT 'sent'::character varying,
    unread boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    sent_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    telegram_message_id character varying(64),
    telegram_date timestamp with time zone,
    loaded_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    reply_to_telegram_id character varying(64),
    telegram_entities jsonb,
    telegram_media jsonb,
    telegram_extra jsonb,
    our_reactions jsonb,
    reactions jsonb DEFAULT '{}'::jsonb
);


--
-- Name: messages_p7; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages_p7 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid,
    bd_account_id uuid,
    channel character varying(50) NOT NULL,
    channel_id character varying(255),
    direction character varying(20) NOT NULL,
    content text NOT NULL,
    status character varying(50) DEFAULT 'sent'::character varying,
    unread boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    sent_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    telegram_message_id character varying(64),
    telegram_date timestamp with time zone,
    loaded_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    reply_to_telegram_id character varying(64),
    telegram_entities jsonb,
    telegram_media jsonb,
    telegram_extra jsonb,
    our_reactions jsonb,
    reactions jsonb DEFAULT '{}'::jsonb
);


--
-- Name: messages_p8; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages_p8 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid,
    bd_account_id uuid,
    channel character varying(50) NOT NULL,
    channel_id character varying(255),
    direction character varying(20) NOT NULL,
    content text NOT NULL,
    status character varying(50) DEFAULT 'sent'::character varying,
    unread boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    sent_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    telegram_message_id character varying(64),
    telegram_date timestamp with time zone,
    loaded_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    reply_to_telegram_id character varying(64),
    telegram_entities jsonb,
    telegram_media jsonb,
    telegram_extra jsonb,
    our_reactions jsonb,
    reactions jsonb DEFAULT '{}'::jsonb
);


--
-- Name: messages_p9; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages_p9 (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    contact_id uuid,
    bd_account_id uuid,
    channel character varying(50) NOT NULL,
    channel_id character varying(255),
    direction character varying(20) NOT NULL,
    content text NOT NULL,
    status character varying(50) DEFAULT 'sent'::character varying,
    unread boolean DEFAULT true NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    sent_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    telegram_message_id character varying(64),
    telegram_date timestamp with time zone,
    loaded_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    reply_to_telegram_id character varying(64),
    telegram_entities jsonb,
    telegram_media jsonb,
    telegram_extra jsonb,
    our_reactions jsonb,
    reactions jsonb DEFAULT '{}'::jsonb
);


--
-- Name: mv_account_health; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.mv_account_health AS
 SELECT ba.id AS bd_account_id,
    ba.organization_id,
    ba.connection_state,
    ba.last_activity,
    ba.flood_wait_until,
    ba.spam_restricted_at,
    ba.last_spambot_check_at,
    ba.last_spambot_result,
    ba.send_blocked_until,
    COALESCE(sends_7d.cnt, 0) AS sends_last_7_days,
    COALESCE(sends_today.cnt, 0) AS sends_today,
    COALESCE(replies_7d.cnt, 0) AS replies_last_7_days,
        CASE
            WHEN (COALESCE(sends_7d.cnt, 0) > 0) THEN round((((COALESCE(replies_7d.cnt, 0))::numeric / (sends_7d.cnt)::numeric) * (100)::numeric), 1)
            ELSE (0)::numeric
        END AS reply_rate_7d,
    floods_7d.cnt AS flood_events_7_days,
    warmup.warmup_status,
    warmup.current_day AS warmup_day
   FROM (((((public.bd_accounts ba
     LEFT JOIN LATERAL ( SELECT (count(*))::integer AS cnt
           FROM (public.campaign_sends cs
             JOIN public.campaign_participants cp ON ((cp.id = cs.campaign_participant_id)))
          WHERE ((cp.bd_account_id = ba.id) AND ((cs.status)::text = ANY ((ARRAY['sent'::character varying, 'queued'::character varying])::text[])) AND (cs.sent_at >= (now() - '7 days'::interval)))) sends_7d ON (true))
     LEFT JOIN LATERAL ( SELECT (count(*))::integer AS cnt
           FROM (public.campaign_sends cs
             JOIN public.campaign_participants cp ON ((cp.id = cs.campaign_participant_id)))
          WHERE ((cp.bd_account_id = ba.id) AND ((cs.status)::text = ANY ((ARRAY['sent'::character varying, 'queued'::character varying])::text[])) AND (cs.sent_at >= CURRENT_DATE))) sends_today ON (true))
     LEFT JOIN LATERAL ( SELECT (count(*))::integer AS cnt
           FROM (public.campaign_participants cp
             JOIN public.campaigns c ON ((c.id = cp.campaign_id)))
          WHERE ((cp.bd_account_id = ba.id) AND ((cp.status)::text = 'replied'::text) AND (cp.replied_at >= (now() - '7 days'::interval)))) replies_7d ON (true))
     LEFT JOIN LATERAL ( SELECT (count(*))::integer AS cnt
           FROM public.bd_accounts ba2
          WHERE ((ba2.id = ba.id) AND (ba2.flood_wait_until > (now() - '7 days'::interval)))) floods_7d ON (true))
     LEFT JOIN public.bd_account_warmup warmup ON ((warmup.bd_account_id = ba.id)))
  WHERE (ba.is_active = true)
  WITH NO DATA;


--
-- Name: mv_campaign_stats; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.mv_campaign_stats AS
 SELECT cp.campaign_id,
    c.organization_id,
    count(*) AS total_participants,
    count(*) FILTER (WHERE ((cp.status)::text = 'sent'::text)) AS sent,
    count(*) FILTER (WHERE ((cp.status)::text = 'replied'::text)) AS replied,
    count(*) FILTER (WHERE ((cp.status)::text = 'failed'::text)) AS failed,
    count(*) FILTER (WHERE ((cp.status)::text = 'pending'::text)) AS pending
   FROM (public.campaign_participants cp
     JOIN public.campaigns c ON ((c.id = cp.campaign_id)))
  GROUP BY cp.campaign_id, c.organization_id
  WITH NO DATA;


--
-- Name: pipelines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pipelines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: stages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    pipeline_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    name character varying(100) NOT NULL,
    order_index integer NOT NULL,
    color character varying(20),
    automation_rules jsonb DEFAULT '[]'::jsonb,
    entry_rules jsonb DEFAULT '[]'::jsonb,
    exit_rules jsonb DEFAULT '[]'::jsonb,
    allowed_actions jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: mv_conversion_funnel; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.mv_conversion_funnel AS
 SELECT s.pipeline_id,
    p.organization_id,
    s.id AS stage_id,
    s.name AS stage_name,
    s.order_index AS stage_order,
    count(l.id) AS lead_count,
    COALESCE(sum(l.revenue_amount), (0)::numeric) AS total_value
   FROM ((public.stages s
     JOIN public.pipelines p ON ((p.id = s.pipeline_id)))
     LEFT JOIN public.leads l ON (((l.stage_id = s.id) AND (l.deleted_at IS NULL))))
  GROUP BY s.pipeline_id, p.organization_id, s.id, s.name, s.order_index
  WITH NO DATA;


--
-- Name: notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    entity_type character varying(20) NOT NULL,
    entity_id uuid NOT NULL,
    content text NOT NULL,
    user_id uuid,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: organization_activity; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_activity (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    action_type character varying(100) NOT NULL,
    entity_type character varying(50),
    entity_id character varying(255),
    metadata jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: organization_client_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_client_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    client_id uuid NOT NULL,
    assigned_to uuid NOT NULL,
    assigned_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    assigned_by uuid
);


--
-- Name: organization_invite_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_invite_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    token character varying(64) NOT NULL,
    role character varying(50) DEFAULT 'bidi'::character varying NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: organization_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    role character varying(50) DEFAULT 'bidi'::character varying NOT NULL,
    joined_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: organization_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_settings (
    organization_id uuid NOT NULL,
    key character varying(128) NOT NULL,
    value jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: organizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organizations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    slug character varying(255) NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    timezone character varying(50) DEFAULT 'UTC'::character varying
);


--
-- Name: proxy_pool; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.proxy_pool (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    host character varying(255) NOT NULL,
    port integer NOT NULL,
    username character varying(255),
    password character varying(255),
    proxy_type character varying(20) DEFAULT 'socks5'::character varying NOT NULL,
    country character varying(10),
    is_active boolean DEFAULT true NOT NULL,
    assigned_account_id uuid,
    health_status character varying(20) DEFAULT 'unknown'::character varying NOT NULL,
    last_check_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: recovery_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recovery_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    code_hash character varying(255) NOT NULL,
    used boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.refresh_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    family_id uuid DEFAULT gen_random_uuid() NOT NULL,
    used boolean DEFAULT false NOT NULL
);


--
-- Name: reminders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reminders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    entity_type character varying(20) NOT NULL,
    entity_id uuid NOT NULL,
    remind_at timestamp with time zone NOT NULL,
    title character varying(500),
    done boolean DEFAULT false NOT NULL,
    user_id uuid,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: role_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_permissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    role character varying(50) NOT NULL,
    resource character varying(50) NOT NULL,
    action character varying(50) NOT NULL
);


--
-- Name: stage_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stage_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    entity_type character varying(20) NOT NULL,
    entity_id uuid NOT NULL,
    pipeline_id uuid NOT NULL,
    from_stage_id uuid,
    to_stage_id uuid NOT NULL,
    changed_by uuid,
    reason text,
    source character varying(20) NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    correlation_id uuid,
    CONSTRAINT stage_history_entity_type_check CHECK (((entity_type)::text = ANY ((ARRAY['lead'::character varying, 'deal'::character varying])::text[]))),
    CONSTRAINT stage_history_source_check CHECK (((source)::text = ANY ((ARRAY['manual'::character varying, 'system'::character varying, 'automation'::character varying])::text[])))
);


--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    stripe_customer_id character varying(255),
    stripe_subscription_id character varying(255),
    plan character varying(50) DEFAULT 'free'::character varying NOT NULL,
    status character varying(50) DEFAULT 'active'::character varying NOT NULL,
    current_period_start timestamp with time zone,
    current_period_end timestamp with time zone,
    cancel_at_period_end boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: user_chat_pins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_chat_pins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    bd_account_id uuid NOT NULL,
    channel_id character varying(255) NOT NULL,
    order_index integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: user_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    first_name character varying(255),
    last_name character varying(255),
    avatar_url character varying(500),
    timezone character varying(50),
    preferences jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    organization_id uuid NOT NULL,
    role character varying(50) DEFAULT 'bidi'::character varying NOT NULL,
    bidi_id uuid,
    mfa_secret character varying(255),
    mfa_enabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: messages_p0; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages ATTACH PARTITION public.messages_p0 FOR VALUES WITH (modulus 16, remainder 0);


--
-- Name: messages_p1; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages ATTACH PARTITION public.messages_p1 FOR VALUES WITH (modulus 16, remainder 1);


--
-- Name: messages_p10; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages ATTACH PARTITION public.messages_p10 FOR VALUES WITH (modulus 16, remainder 10);


--
-- Name: messages_p11; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages ATTACH PARTITION public.messages_p11 FOR VALUES WITH (modulus 16, remainder 11);


--
-- Name: messages_p12; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages ATTACH PARTITION public.messages_p12 FOR VALUES WITH (modulus 16, remainder 12);


--
-- Name: messages_p13; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages ATTACH PARTITION public.messages_p13 FOR VALUES WITH (modulus 16, remainder 13);


--
-- Name: messages_p14; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages ATTACH PARTITION public.messages_p14 FOR VALUES WITH (modulus 16, remainder 14);


--
-- Name: messages_p15; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages ATTACH PARTITION public.messages_p15 FOR VALUES WITH (modulus 16, remainder 15);


--
-- Name: messages_p2; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages ATTACH PARTITION public.messages_p2 FOR VALUES WITH (modulus 16, remainder 2);


--
-- Name: messages_p3; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages ATTACH PARTITION public.messages_p3 FOR VALUES WITH (modulus 16, remainder 3);


--
-- Name: messages_p4; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages ATTACH PARTITION public.messages_p4 FOR VALUES WITH (modulus 16, remainder 4);


--
-- Name: messages_p5; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages ATTACH PARTITION public.messages_p5 FOR VALUES WITH (modulus 16, remainder 5);


--
-- Name: messages_p6; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages ATTACH PARTITION public.messages_p6 FOR VALUES WITH (modulus 16, remainder 6);


--
-- Name: messages_p7; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages ATTACH PARTITION public.messages_p7 FOR VALUES WITH (modulus 16, remainder 7);


--
-- Name: messages_p8; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages ATTACH PARTITION public.messages_p8 FOR VALUES WITH (modulus 16, remainder 8);


--
-- Name: messages_p9; Type: TABLE ATTACH; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages ATTACH PARTITION public.messages_p9 FOR VALUES WITH (modulus 16, remainder 9);


--
-- Name: analytics_metrics analytics_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_metrics
    ADD CONSTRAINT analytics_metrics_pkey PRIMARY KEY (id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: automation_executions automation_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_executions
    ADD CONSTRAINT automation_executions_pkey PRIMARY KEY (id);


--
-- Name: automation_rules automation_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_rules
    ADD CONSTRAINT automation_rules_pkey PRIMARY KEY (id);


--
-- Name: bd_account_status bd_account_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_account_status
    ADD CONSTRAINT bd_account_status_pkey PRIMARY KEY (id);


--
-- Name: bd_account_sync_chat_folders bd_account_sync_chat_folders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_account_sync_chat_folders
    ADD CONSTRAINT bd_account_sync_chat_folders_pkey PRIMARY KEY (bd_account_id, telegram_chat_id, folder_id);


--
-- Name: bd_account_sync_chats bd_account_sync_chats_bd_account_id_telegram_chat_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_account_sync_chats
    ADD CONSTRAINT bd_account_sync_chats_bd_account_id_telegram_chat_id_unique UNIQUE (bd_account_id, telegram_chat_id);


--
-- Name: bd_account_sync_chats bd_account_sync_chats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_account_sync_chats
    ADD CONSTRAINT bd_account_sync_chats_pkey PRIMARY KEY (id);


--
-- Name: bd_account_sync_folders bd_account_sync_folders_bd_account_id_folder_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_account_sync_folders
    ADD CONSTRAINT bd_account_sync_folders_bd_account_id_folder_id_unique UNIQUE (bd_account_id, folder_id);


--
-- Name: bd_account_sync_folders bd_account_sync_folders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_account_sync_folders
    ADD CONSTRAINT bd_account_sync_folders_pkey PRIMARY KEY (id);


--
-- Name: bd_account_warmup bd_account_warmup_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_account_warmup
    ADD CONSTRAINT bd_account_warmup_pkey PRIMARY KEY (id);


--
-- Name: bd_accounts bd_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_accounts
    ADD CONSTRAINT bd_accounts_pkey PRIMARY KEY (id);


--
-- Name: bd_accounts bd_accounts_telegram_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_accounts
    ADD CONSTRAINT bd_accounts_telegram_id_unique UNIQUE (telegram_id);


--
-- Name: campaign_participants campaign_participants_campaign_id_contact_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_participants
    ADD CONSTRAINT campaign_participants_campaign_id_contact_id_unique UNIQUE (campaign_id, contact_id);


--
-- Name: campaign_participants campaign_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_participants
    ADD CONSTRAINT campaign_participants_pkey PRIMARY KEY (id);


--
-- Name: campaign_sends campaign_sends_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_sends
    ADD CONSTRAINT campaign_sends_pkey PRIMARY KEY (id);


--
-- Name: campaign_sequences campaign_sequences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_sequences
    ADD CONSTRAINT campaign_sequences_pkey PRIMARY KEY (id);


--
-- Name: campaign_templates campaign_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_templates
    ADD CONSTRAINT campaign_templates_pkey PRIMARY KEY (id);


--
-- Name: campaigns campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_pkey PRIMARY KEY (id);


--
-- Name: companies companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (id);


--
-- Name: contact_discovery_tasks contact_discovery_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_discovery_tasks
    ADD CONSTRAINT contact_discovery_tasks_pkey PRIMARY KEY (id);


--
-- Name: contact_telegram_sources contact_telegram_sources_organization_id_contact_id_bd_account_; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_telegram_sources
    ADD CONSTRAINT contact_telegram_sources_organization_id_contact_id_bd_account_ UNIQUE (organization_id, contact_id, bd_account_id, telegram_chat_id);


--
-- Name: contact_telegram_sources contact_telegram_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_telegram_sources
    ADD CONSTRAINT contact_telegram_sources_pkey PRIMARY KEY (id);


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);


--
-- Name: conversation_ai_insights conversation_ai_insights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_ai_insights
    ADD CONSTRAINT conversation_ai_insights_pkey PRIMARY KEY (id);


--
-- Name: conversations conversations_organization_id_bd_account_id_channel_channel_id_; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_organization_id_bd_account_id_channel_channel_id_ UNIQUE (organization_id, bd_account_id, channel, channel_id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: conversion_rates conversion_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversion_rates
    ADD CONSTRAINT conversion_rates_pkey PRIMARY KEY (id);


--
-- Name: deals deals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_pkey PRIMARY KEY (id);


--
-- Name: lead_activity_log lead_activity_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_activity_log
    ADD CONSTRAINT lead_activity_log_pkey PRIMARY KEY (id);


--
-- Name: leads leads_organization_id_contact_id_pipeline_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_organization_id_contact_id_pipeline_id_unique UNIQUE (organization_id, contact_id, pipeline_id);


--
-- Name: leads leads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_pkey PRIMARY KEY (id);


--
-- Name: messages messages_pkey1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey1 PRIMARY KEY (id, organization_id);


--
-- Name: messages_p0 messages_p0_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages_p0
    ADD CONSTRAINT messages_p0_pkey PRIMARY KEY (id, organization_id);


--
-- Name: messages_p10 messages_p10_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages_p10
    ADD CONSTRAINT messages_p10_pkey PRIMARY KEY (id, organization_id);


--
-- Name: messages_p11 messages_p11_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages_p11
    ADD CONSTRAINT messages_p11_pkey PRIMARY KEY (id, organization_id);


--
-- Name: messages_p12 messages_p12_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages_p12
    ADD CONSTRAINT messages_p12_pkey PRIMARY KEY (id, organization_id);


--
-- Name: messages_p13 messages_p13_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages_p13
    ADD CONSTRAINT messages_p13_pkey PRIMARY KEY (id, organization_id);


--
-- Name: messages_p14 messages_p14_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages_p14
    ADD CONSTRAINT messages_p14_pkey PRIMARY KEY (id, organization_id);


--
-- Name: messages_p15 messages_p15_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages_p15
    ADD CONSTRAINT messages_p15_pkey PRIMARY KEY (id, organization_id);


--
-- Name: messages_p1 messages_p1_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages_p1
    ADD CONSTRAINT messages_p1_pkey PRIMARY KEY (id, organization_id);


--
-- Name: messages_p2 messages_p2_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages_p2
    ADD CONSTRAINT messages_p2_pkey PRIMARY KEY (id, organization_id);


--
-- Name: messages_p3 messages_p3_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages_p3
    ADD CONSTRAINT messages_p3_pkey PRIMARY KEY (id, organization_id);


--
-- Name: messages_p4 messages_p4_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages_p4
    ADD CONSTRAINT messages_p4_pkey PRIMARY KEY (id, organization_id);


--
-- Name: messages_p5 messages_p5_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages_p5
    ADD CONSTRAINT messages_p5_pkey PRIMARY KEY (id, organization_id);


--
-- Name: messages_p6 messages_p6_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages_p6
    ADD CONSTRAINT messages_p6_pkey PRIMARY KEY (id, organization_id);


--
-- Name: messages_p7 messages_p7_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages_p7
    ADD CONSTRAINT messages_p7_pkey PRIMARY KEY (id, organization_id);


--
-- Name: messages_p8 messages_p8_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages_p8
    ADD CONSTRAINT messages_p8_pkey PRIMARY KEY (id, organization_id);


--
-- Name: messages_p9 messages_p9_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages_p9
    ADD CONSTRAINT messages_p9_pkey PRIMARY KEY (id, organization_id);


--
-- Name: notes notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_pkey PRIMARY KEY (id);


--
-- Name: organization_activity organization_activity_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_activity
    ADD CONSTRAINT organization_activity_pkey PRIMARY KEY (id);


--
-- Name: organization_client_assignments organization_client_assignments_organization_id_client_id_uniqu; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_client_assignments
    ADD CONSTRAINT organization_client_assignments_organization_id_client_id_uniqu UNIQUE (organization_id, client_id);


--
-- Name: organization_client_assignments organization_client_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_client_assignments
    ADD CONSTRAINT organization_client_assignments_pkey PRIMARY KEY (id);


--
-- Name: organization_invite_links organization_invite_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_invite_links
    ADD CONSTRAINT organization_invite_links_pkey PRIMARY KEY (id);


--
-- Name: organization_invite_links organization_invite_links_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_invite_links
    ADD CONSTRAINT organization_invite_links_token_unique UNIQUE (token);


--
-- Name: organization_members organization_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_members
    ADD CONSTRAINT organization_members_pkey PRIMARY KEY (id);


--
-- Name: organization_members organization_members_user_id_organization_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_members
    ADD CONSTRAINT organization_members_user_id_organization_id_unique UNIQUE (user_id, organization_id);


--
-- Name: organization_settings organization_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_settings
    ADD CONSTRAINT organization_settings_pkey PRIMARY KEY (organization_id, key);


--
-- Name: organizations organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_slug_unique UNIQUE (slug);


--
-- Name: pipelines pipelines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipelines
    ADD CONSTRAINT pipelines_pkey PRIMARY KEY (id);


--
-- Name: proxy_pool proxy_pool_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proxy_pool
    ADD CONSTRAINT proxy_pool_pkey PRIMARY KEY (id);


--
-- Name: recovery_codes recovery_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recovery_codes
    ADD CONSTRAINT recovery_codes_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_token_unique UNIQUE (token);


--
-- Name: reminders reminders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminders
    ADD CONSTRAINT reminders_pkey PRIMARY KEY (id);


--
-- Name: role_permissions role_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (id);


--
-- Name: role_permissions role_permissions_role_resource_action_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_resource_action_unique UNIQUE (role, resource, action);


--
-- Name: stage_history stage_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stage_history
    ADD CONSTRAINT stage_history_pkey PRIMARY KEY (id);


--
-- Name: stages stages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stages
    ADD CONSTRAINT stages_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);


--
-- Name: subscriptions subscriptions_user_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_user_id_unique UNIQUE (user_id);


--
-- Name: bd_account_warmup uq_warmup_account; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_account_warmup
    ADD CONSTRAINT uq_warmup_account UNIQUE (bd_account_id);


--
-- Name: user_chat_pins user_chat_pins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_chat_pins
    ADD CONSTRAINT user_chat_pins_pkey PRIMARY KEY (id);


--
-- Name: user_chat_pins user_chat_pins_user_id_organization_id_bd_account_id_channel_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_chat_pins
    ADD CONSTRAINT user_chat_pins_user_id_organization_id_bd_account_id_channel_id UNIQUE (user_id, organization_id, bd_account_id, channel_id);


--
-- Name: user_profiles user_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT user_profiles_pkey PRIMARY KEY (id);


--
-- Name: user_profiles user_profiles_user_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT user_profiles_user_id_unique UNIQUE (user_id);


--
-- Name: users users_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_unique UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: analytics_metrics_metric_type_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analytics_metrics_metric_type_index ON public.analytics_metrics USING btree (metric_type);


--
-- Name: analytics_metrics_organization_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analytics_metrics_organization_id_index ON public.analytics_metrics USING btree (organization_id);


--
-- Name: analytics_metrics_recorded_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analytics_metrics_recorded_at_index ON public.analytics_metrics USING btree (recorded_at);


--
-- Name: audit_logs_action_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_action_index ON public.audit_logs USING btree (action);


--
-- Name: audit_logs_organization_id_created_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_organization_id_created_at_index ON public.audit_logs USING btree (organization_id, created_at);


--
-- Name: audit_logs_organization_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_organization_id_index ON public.audit_logs USING btree (organization_id);


--
-- Name: automation_executions_correlation_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX automation_executions_correlation_id_index ON public.automation_executions USING btree (correlation_id);


--
-- Name: automation_executions_organization_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX automation_executions_organization_id_index ON public.automation_executions USING btree (organization_id);


--
-- Name: automation_executions_rule_entity_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX automation_executions_rule_entity_unique ON public.automation_executions USING btree (rule_id, entity_type, entity_id) WHERE (breach_date IS NULL);


--
-- Name: automation_executions_rule_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX automation_executions_rule_id_index ON public.automation_executions USING btree (rule_id);


--
-- Name: automation_executions_trigger_event_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX automation_executions_trigger_event_id_index ON public.automation_executions USING btree (trigger_event_id);


--
-- Name: automation_rules_organization_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX automation_rules_organization_id_index ON public.automation_rules USING btree (organization_id);


--
-- Name: automation_sla_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX automation_sla_unique ON public.automation_executions USING btree (rule_id, entity_type, entity_id, breach_date) WHERE (breach_date IS NOT NULL);


--
-- Name: bd_account_status_account_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bd_account_status_account_id_index ON public.bd_account_status USING btree (account_id);


--
-- Name: bd_account_sync_chat_folders_bd_account_id_folder_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bd_account_sync_chat_folders_bd_account_id_folder_id_index ON public.bd_account_sync_chat_folders USING btree (bd_account_id, folder_id);


--
-- Name: bd_account_sync_chats_bd_account_id_folder_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bd_account_sync_chats_bd_account_id_folder_id_index ON public.bd_account_sync_chats USING btree (bd_account_id, folder_id);


--
-- Name: bd_account_sync_chats_bd_account_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bd_account_sync_chats_bd_account_id_index ON public.bd_account_sync_chats USING btree (bd_account_id);


--
-- Name: bd_account_sync_folders_bd_account_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bd_account_sync_folders_bd_account_id_index ON public.bd_account_sync_folders USING btree (bd_account_id);


--
-- Name: bd_accounts_created_by_user_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bd_accounts_created_by_user_id_index ON public.bd_accounts USING btree (created_by_user_id);


--
-- Name: bd_accounts_is_demo_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bd_accounts_is_demo_index ON public.bd_accounts USING btree (is_demo);


--
-- Name: bd_accounts_organization_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bd_accounts_organization_id_index ON public.bd_accounts USING btree (organization_id);


--
-- Name: bd_accounts_telegram_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bd_accounts_telegram_id_index ON public.bd_accounts USING btree (telegram_id);


--
-- Name: campaign_participants_campaign_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_participants_campaign_id_index ON public.campaign_participants USING btree (campaign_id);


--
-- Name: campaign_participants_campaign_id_next_send_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_participants_campaign_id_next_send_at_index ON public.campaign_participants USING btree (campaign_id, next_send_at);


--
-- Name: campaign_sends_campaign_participant_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_sends_campaign_participant_id_index ON public.campaign_sends USING btree (campaign_participant_id);


--
-- Name: campaign_sequences_campaign_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_sequences_campaign_id_index ON public.campaign_sequences USING btree (campaign_id);


--
-- Name: campaign_templates_campaign_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_templates_campaign_id_index ON public.campaign_templates USING btree (campaign_id);


--
-- Name: campaign_templates_organization_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaign_templates_organization_id_index ON public.campaign_templates USING btree (organization_id);


--
-- Name: campaigns_organization_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaigns_organization_id_index ON public.campaigns USING btree (organization_id);


--
-- Name: campaigns_status_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaigns_status_index ON public.campaigns USING btree (status);


--
-- Name: companies_organization_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX companies_organization_id_index ON public.companies USING btree (organization_id);


--
-- Name: contact_discovery_tasks_created_by_user_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contact_discovery_tasks_created_by_user_id_index ON public.contact_discovery_tasks USING btree (created_by_user_id);


--
-- Name: contact_discovery_tasks_organization_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contact_discovery_tasks_organization_id_index ON public.contact_discovery_tasks USING btree (organization_id);


--
-- Name: contact_discovery_tasks_status_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contact_discovery_tasks_status_index ON public.contact_discovery_tasks USING btree (status);


--
-- Name: contact_telegram_sources_organization_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contact_telegram_sources_organization_id_index ON public.contact_telegram_sources USING btree (organization_id);


--
-- Name: contact_telegram_sources_organization_id_search_keyword_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contact_telegram_sources_organization_id_search_keyword_index ON public.contact_telegram_sources USING btree (organization_id, search_keyword);


--
-- Name: contact_telegram_sources_organization_id_telegram_chat_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contact_telegram_sources_organization_id_telegram_chat_id_index ON public.contact_telegram_sources USING btree (organization_id, telegram_chat_id);


--
-- Name: contacts_company_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_company_id_index ON public.contacts USING btree (company_id);


--
-- Name: contacts_organization_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX contacts_organization_id_index ON public.contacts USING btree (organization_id);


--
-- Name: conversation_ai_insights_conversation_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversation_ai_insights_conversation_id_index ON public.conversation_ai_insights USING btree (conversation_id);


--
-- Name: conversation_ai_insights_conversation_id_type_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversation_ai_insights_conversation_id_type_index ON public.conversation_ai_insights USING btree (conversation_id, type);


--
-- Name: conversations_bd_account_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversations_bd_account_id_index ON public.conversations USING btree (bd_account_id);


--
-- Name: conversations_campaign_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversations_campaign_id_index ON public.conversations USING btree (campaign_id);


--
-- Name: conversations_campaign_shared_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversations_campaign_shared_idx ON public.conversations USING btree (campaign_id) WHERE (shared_chat_created_at IS NOT NULL);


--
-- Name: conversations_contact_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversations_contact_id_index ON public.conversations USING btree (contact_id);


--
-- Name: conversations_first_manager_reply_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversations_first_manager_reply_at_idx ON public.conversations USING btree (organization_id) WHERE (first_manager_reply_at IS NULL);


--
-- Name: conversations_last_viewed_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversations_last_viewed_at_index ON public.conversations USING btree (last_viewed_at);


--
-- Name: conversations_lead_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversations_lead_id_index ON public.conversations USING btree (lead_id);


--
-- Name: conversations_organization_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversations_organization_id_index ON public.conversations USING btree (organization_id);


--
-- Name: conversion_rates_organization_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversion_rates_organization_id_index ON public.conversion_rates USING btree (organization_id);


--
-- Name: deals_bd_account_id_channel_channel_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deals_bd_account_id_channel_channel_id_index ON public.deals USING btree (bd_account_id, channel, channel_id);


--
-- Name: deals_company_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deals_company_id_index ON public.deals USING btree (company_id);


--
-- Name: deals_lead_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deals_lead_id_index ON public.deals USING btree (lead_id);


--
-- Name: deals_lead_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX deals_lead_id_unique ON public.deals USING btree (lead_id) WHERE (lead_id IS NOT NULL);


--
-- Name: deals_organization_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deals_organization_id_index ON public.deals USING btree (organization_id);


--
-- Name: deals_owner_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deals_owner_id_index ON public.deals USING btree (owner_id);


--
-- Name: idx_bd_accounts_org_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bd_accounts_org_active ON public.bd_accounts USING btree (organization_id) WHERE (is_active = true);


--
-- Name: idx_campaign_participants_bd_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaign_participants_bd_channel ON public.campaign_participants USING btree (bd_account_id, channel_id) WHERE ((status)::text = ANY ((ARRAY['pending'::character varying, 'sent'::character varying])::text[]));


--
-- Name: idx_campaign_participants_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaign_participants_status ON public.campaign_participants USING btree (campaign_id, status, next_send_at);


--
-- Name: idx_campaign_sends_participant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_campaign_sends_participant ON public.campaign_sends USING btree (campaign_participant_id, sent_at DESC);


--
-- Name: idx_contacts_org_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_org_active ON public.contacts USING btree (organization_id, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: idx_contacts_org_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_contacts_org_created ON public.contacts USING btree (organization_id, created_at DESC);


--
-- Name: idx_contacts_org_telegram_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_contacts_org_telegram_id_unique ON public.contacts USING btree (organization_id, telegram_id) WHERE ((telegram_id IS NOT NULL) AND (TRIM(BOTH FROM telegram_id) <> ''::text));


--
-- Name: idx_conversations_new_leads; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_new_leads ON public.conversations USING btree (organization_id, became_lead_at DESC NULLS LAST) WHERE ((lead_id IS NOT NULL) AND (first_manager_reply_at IS NULL));


--
-- Name: idx_conversations_org_bd_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_org_bd_channel ON public.conversations USING btree (organization_id, bd_account_id, channel, channel_id);


--
-- Name: idx_conversations_org_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_org_updated ON public.conversations USING btree (organization_id, updated_at DESC);


--
-- Name: idx_cp_campaign_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cp_campaign_status ON public.campaign_participants USING btree (campaign_id, status);


--
-- Name: idx_deals_org_pipeline_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deals_org_pipeline_stage ON public.deals USING btree (organization_id, pipeline_id, stage_id);


--
-- Name: idx_deals_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deals_stage ON public.deals USING btree (stage_id, created_at DESC);


--
-- Name: idx_lead_activity_lead_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lead_activity_lead_created ON public.lead_activity_log USING btree (lead_id, created_at DESC);


--
-- Name: idx_leads_pipeline_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leads_pipeline_stage ON public.leads USING btree (organization_id, pipeline_id, stage_id, order_index);


--
-- Name: idx_leads_responsible; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leads_responsible ON public.leads USING btree (responsible_id, stage_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_messages_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_channel ON ONLY public.messages USING btree (channel_id, bd_account_id, created_at DESC);


--
-- Name: idx_messages_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_contact ON ONLY public.messages USING btree (contact_id, created_at DESC);


--
-- Name: idx_messages_org_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_org_created ON ONLY public.messages USING btree (organization_id, created_at DESC);


--
-- Name: idx_messages_telegram_msg; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_telegram_msg ON ONLY public.messages USING btree (bd_account_id, telegram_message_id);


--
-- Name: idx_mv_account_health_pk; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_mv_account_health_pk ON public.mv_account_health USING btree (bd_account_id);


--
-- Name: idx_mv_campaign_stats_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_mv_campaign_stats_id ON public.mv_campaign_stats USING btree (campaign_id);


--
-- Name: idx_mv_conversion_funnel_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_mv_conversion_funnel_stage ON public.mv_conversion_funnel USING btree (pipeline_id, stage_id);


--
-- Name: idx_notes_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notes_entity ON public.notes USING btree (entity_type, entity_id);


--
-- Name: idx_proxy_pool_assigned; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proxy_pool_assigned ON public.proxy_pool USING btree (assigned_account_id) WHERE (assigned_account_id IS NOT NULL);


--
-- Name: idx_proxy_pool_available; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proxy_pool_available ON public.proxy_pool USING btree (organization_id, is_active, assigned_account_id) WHERE ((is_active = true) AND (assigned_account_id IS NULL));


--
-- Name: idx_proxy_pool_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_proxy_pool_org ON public.proxy_pool USING btree (organization_id);


--
-- Name: idx_reminders_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reminders_entity ON public.reminders USING btree (entity_type, entity_id);


--
-- Name: idx_stages_pipeline_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stages_pipeline_order ON public.stages USING btree (pipeline_id, order_index);


--
-- Name: idx_templates_variant_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_templates_variant_group ON public.campaign_templates USING btree (variant_group) WHERE (variant_group IS NOT NULL);


--
-- Name: idx_warmup_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_warmup_account ON public.bd_account_warmup USING btree (bd_account_id);


--
-- Name: idx_warmup_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_warmup_status ON public.bd_account_warmup USING btree (warmup_status);


--
-- Name: lead_activity_log_lead_id_created_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lead_activity_log_lead_id_created_at_index ON public.lead_activity_log USING btree (lead_id, created_at);


--
-- Name: lead_activity_log_lead_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lead_activity_log_lead_id_index ON public.lead_activity_log USING btree (lead_id);


--
-- Name: leads_contact_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX leads_contact_id_index ON public.leads USING btree (contact_id);


--
-- Name: leads_organization_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX leads_organization_id_index ON public.leads USING btree (organization_id);


--
-- Name: leads_pipeline_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX leads_pipeline_id_index ON public.leads USING btree (pipeline_id);


--
-- Name: leads_stage_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX leads_stage_id_index ON public.leads USING btree (stage_id);


--
-- Name: messages_telegram_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX messages_telegram_unique ON ONLY public.messages USING btree (bd_account_id, channel_id, telegram_message_id, organization_id) WHERE (telegram_message_id IS NOT NULL);


--
-- Name: messages_p0_bd_account_id_channel_id_telegram_message_id_or_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX messages_p0_bd_account_id_channel_id_telegram_message_id_or_idx ON public.messages_p0 USING btree (bd_account_id, channel_id, telegram_message_id, organization_id) WHERE (telegram_message_id IS NOT NULL);


--
-- Name: messages_p0_bd_account_id_telegram_message_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p0_bd_account_id_telegram_message_id_idx ON public.messages_p0 USING btree (bd_account_id, telegram_message_id);


--
-- Name: messages_p0_channel_id_bd_account_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p0_channel_id_bd_account_id_created_at_idx ON public.messages_p0 USING btree (channel_id, bd_account_id, created_at DESC);


--
-- Name: messages_p0_contact_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p0_contact_id_created_at_idx ON public.messages_p0 USING btree (contact_id, created_at DESC);


--
-- Name: messages_p0_organization_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p0_organization_id_created_at_idx ON public.messages_p0 USING btree (organization_id, created_at DESC);


--
-- Name: messages_p10_bd_account_id_channel_id_telegram_message_id_o_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX messages_p10_bd_account_id_channel_id_telegram_message_id_o_idx ON public.messages_p10 USING btree (bd_account_id, channel_id, telegram_message_id, organization_id) WHERE (telegram_message_id IS NOT NULL);


--
-- Name: messages_p10_bd_account_id_telegram_message_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p10_bd_account_id_telegram_message_id_idx ON public.messages_p10 USING btree (bd_account_id, telegram_message_id);


--
-- Name: messages_p10_channel_id_bd_account_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p10_channel_id_bd_account_id_created_at_idx ON public.messages_p10 USING btree (channel_id, bd_account_id, created_at DESC);


--
-- Name: messages_p10_contact_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p10_contact_id_created_at_idx ON public.messages_p10 USING btree (contact_id, created_at DESC);


--
-- Name: messages_p10_organization_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p10_organization_id_created_at_idx ON public.messages_p10 USING btree (organization_id, created_at DESC);


--
-- Name: messages_p11_bd_account_id_channel_id_telegram_message_id_o_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX messages_p11_bd_account_id_channel_id_telegram_message_id_o_idx ON public.messages_p11 USING btree (bd_account_id, channel_id, telegram_message_id, organization_id) WHERE (telegram_message_id IS NOT NULL);


--
-- Name: messages_p11_bd_account_id_telegram_message_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p11_bd_account_id_telegram_message_id_idx ON public.messages_p11 USING btree (bd_account_id, telegram_message_id);


--
-- Name: messages_p11_channel_id_bd_account_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p11_channel_id_bd_account_id_created_at_idx ON public.messages_p11 USING btree (channel_id, bd_account_id, created_at DESC);


--
-- Name: messages_p11_contact_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p11_contact_id_created_at_idx ON public.messages_p11 USING btree (contact_id, created_at DESC);


--
-- Name: messages_p11_organization_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p11_organization_id_created_at_idx ON public.messages_p11 USING btree (organization_id, created_at DESC);


--
-- Name: messages_p12_bd_account_id_channel_id_telegram_message_id_o_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX messages_p12_bd_account_id_channel_id_telegram_message_id_o_idx ON public.messages_p12 USING btree (bd_account_id, channel_id, telegram_message_id, organization_id) WHERE (telegram_message_id IS NOT NULL);


--
-- Name: messages_p12_bd_account_id_telegram_message_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p12_bd_account_id_telegram_message_id_idx ON public.messages_p12 USING btree (bd_account_id, telegram_message_id);


--
-- Name: messages_p12_channel_id_bd_account_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p12_channel_id_bd_account_id_created_at_idx ON public.messages_p12 USING btree (channel_id, bd_account_id, created_at DESC);


--
-- Name: messages_p12_contact_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p12_contact_id_created_at_idx ON public.messages_p12 USING btree (contact_id, created_at DESC);


--
-- Name: messages_p12_organization_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p12_organization_id_created_at_idx ON public.messages_p12 USING btree (organization_id, created_at DESC);


--
-- Name: messages_p13_bd_account_id_channel_id_telegram_message_id_o_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX messages_p13_bd_account_id_channel_id_telegram_message_id_o_idx ON public.messages_p13 USING btree (bd_account_id, channel_id, telegram_message_id, organization_id) WHERE (telegram_message_id IS NOT NULL);


--
-- Name: messages_p13_bd_account_id_telegram_message_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p13_bd_account_id_telegram_message_id_idx ON public.messages_p13 USING btree (bd_account_id, telegram_message_id);


--
-- Name: messages_p13_channel_id_bd_account_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p13_channel_id_bd_account_id_created_at_idx ON public.messages_p13 USING btree (channel_id, bd_account_id, created_at DESC);


--
-- Name: messages_p13_contact_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p13_contact_id_created_at_idx ON public.messages_p13 USING btree (contact_id, created_at DESC);


--
-- Name: messages_p13_organization_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p13_organization_id_created_at_idx ON public.messages_p13 USING btree (organization_id, created_at DESC);


--
-- Name: messages_p14_bd_account_id_channel_id_telegram_message_id_o_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX messages_p14_bd_account_id_channel_id_telegram_message_id_o_idx ON public.messages_p14 USING btree (bd_account_id, channel_id, telegram_message_id, organization_id) WHERE (telegram_message_id IS NOT NULL);


--
-- Name: messages_p14_bd_account_id_telegram_message_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p14_bd_account_id_telegram_message_id_idx ON public.messages_p14 USING btree (bd_account_id, telegram_message_id);


--
-- Name: messages_p14_channel_id_bd_account_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p14_channel_id_bd_account_id_created_at_idx ON public.messages_p14 USING btree (channel_id, bd_account_id, created_at DESC);


--
-- Name: messages_p14_contact_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p14_contact_id_created_at_idx ON public.messages_p14 USING btree (contact_id, created_at DESC);


--
-- Name: messages_p14_organization_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p14_organization_id_created_at_idx ON public.messages_p14 USING btree (organization_id, created_at DESC);


--
-- Name: messages_p15_bd_account_id_channel_id_telegram_message_id_o_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX messages_p15_bd_account_id_channel_id_telegram_message_id_o_idx ON public.messages_p15 USING btree (bd_account_id, channel_id, telegram_message_id, organization_id) WHERE (telegram_message_id IS NOT NULL);


--
-- Name: messages_p15_bd_account_id_telegram_message_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p15_bd_account_id_telegram_message_id_idx ON public.messages_p15 USING btree (bd_account_id, telegram_message_id);


--
-- Name: messages_p15_channel_id_bd_account_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p15_channel_id_bd_account_id_created_at_idx ON public.messages_p15 USING btree (channel_id, bd_account_id, created_at DESC);


--
-- Name: messages_p15_contact_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p15_contact_id_created_at_idx ON public.messages_p15 USING btree (contact_id, created_at DESC);


--
-- Name: messages_p15_organization_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p15_organization_id_created_at_idx ON public.messages_p15 USING btree (organization_id, created_at DESC);


--
-- Name: messages_p1_bd_account_id_channel_id_telegram_message_id_or_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX messages_p1_bd_account_id_channel_id_telegram_message_id_or_idx ON public.messages_p1 USING btree (bd_account_id, channel_id, telegram_message_id, organization_id) WHERE (telegram_message_id IS NOT NULL);


--
-- Name: messages_p1_bd_account_id_telegram_message_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p1_bd_account_id_telegram_message_id_idx ON public.messages_p1 USING btree (bd_account_id, telegram_message_id);


--
-- Name: messages_p1_channel_id_bd_account_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p1_channel_id_bd_account_id_created_at_idx ON public.messages_p1 USING btree (channel_id, bd_account_id, created_at DESC);


--
-- Name: messages_p1_contact_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p1_contact_id_created_at_idx ON public.messages_p1 USING btree (contact_id, created_at DESC);


--
-- Name: messages_p1_organization_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p1_organization_id_created_at_idx ON public.messages_p1 USING btree (organization_id, created_at DESC);


--
-- Name: messages_p2_bd_account_id_channel_id_telegram_message_id_or_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX messages_p2_bd_account_id_channel_id_telegram_message_id_or_idx ON public.messages_p2 USING btree (bd_account_id, channel_id, telegram_message_id, organization_id) WHERE (telegram_message_id IS NOT NULL);


--
-- Name: messages_p2_bd_account_id_telegram_message_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p2_bd_account_id_telegram_message_id_idx ON public.messages_p2 USING btree (bd_account_id, telegram_message_id);


--
-- Name: messages_p2_channel_id_bd_account_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p2_channel_id_bd_account_id_created_at_idx ON public.messages_p2 USING btree (channel_id, bd_account_id, created_at DESC);


--
-- Name: messages_p2_contact_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p2_contact_id_created_at_idx ON public.messages_p2 USING btree (contact_id, created_at DESC);


--
-- Name: messages_p2_organization_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p2_organization_id_created_at_idx ON public.messages_p2 USING btree (organization_id, created_at DESC);


--
-- Name: messages_p3_bd_account_id_channel_id_telegram_message_id_or_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX messages_p3_bd_account_id_channel_id_telegram_message_id_or_idx ON public.messages_p3 USING btree (bd_account_id, channel_id, telegram_message_id, organization_id) WHERE (telegram_message_id IS NOT NULL);


--
-- Name: messages_p3_bd_account_id_telegram_message_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p3_bd_account_id_telegram_message_id_idx ON public.messages_p3 USING btree (bd_account_id, telegram_message_id);


--
-- Name: messages_p3_channel_id_bd_account_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p3_channel_id_bd_account_id_created_at_idx ON public.messages_p3 USING btree (channel_id, bd_account_id, created_at DESC);


--
-- Name: messages_p3_contact_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p3_contact_id_created_at_idx ON public.messages_p3 USING btree (contact_id, created_at DESC);


--
-- Name: messages_p3_organization_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p3_organization_id_created_at_idx ON public.messages_p3 USING btree (organization_id, created_at DESC);


--
-- Name: messages_p4_bd_account_id_channel_id_telegram_message_id_or_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX messages_p4_bd_account_id_channel_id_telegram_message_id_or_idx ON public.messages_p4 USING btree (bd_account_id, channel_id, telegram_message_id, organization_id) WHERE (telegram_message_id IS NOT NULL);


--
-- Name: messages_p4_bd_account_id_telegram_message_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p4_bd_account_id_telegram_message_id_idx ON public.messages_p4 USING btree (bd_account_id, telegram_message_id);


--
-- Name: messages_p4_channel_id_bd_account_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p4_channel_id_bd_account_id_created_at_idx ON public.messages_p4 USING btree (channel_id, bd_account_id, created_at DESC);


--
-- Name: messages_p4_contact_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p4_contact_id_created_at_idx ON public.messages_p4 USING btree (contact_id, created_at DESC);


--
-- Name: messages_p4_organization_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p4_organization_id_created_at_idx ON public.messages_p4 USING btree (organization_id, created_at DESC);


--
-- Name: messages_p5_bd_account_id_channel_id_telegram_message_id_or_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX messages_p5_bd_account_id_channel_id_telegram_message_id_or_idx ON public.messages_p5 USING btree (bd_account_id, channel_id, telegram_message_id, organization_id) WHERE (telegram_message_id IS NOT NULL);


--
-- Name: messages_p5_bd_account_id_telegram_message_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p5_bd_account_id_telegram_message_id_idx ON public.messages_p5 USING btree (bd_account_id, telegram_message_id);


--
-- Name: messages_p5_channel_id_bd_account_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p5_channel_id_bd_account_id_created_at_idx ON public.messages_p5 USING btree (channel_id, bd_account_id, created_at DESC);


--
-- Name: messages_p5_contact_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p5_contact_id_created_at_idx ON public.messages_p5 USING btree (contact_id, created_at DESC);


--
-- Name: messages_p5_organization_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p5_organization_id_created_at_idx ON public.messages_p5 USING btree (organization_id, created_at DESC);


--
-- Name: messages_p6_bd_account_id_channel_id_telegram_message_id_or_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX messages_p6_bd_account_id_channel_id_telegram_message_id_or_idx ON public.messages_p6 USING btree (bd_account_id, channel_id, telegram_message_id, organization_id) WHERE (telegram_message_id IS NOT NULL);


--
-- Name: messages_p6_bd_account_id_telegram_message_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p6_bd_account_id_telegram_message_id_idx ON public.messages_p6 USING btree (bd_account_id, telegram_message_id);


--
-- Name: messages_p6_channel_id_bd_account_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p6_channel_id_bd_account_id_created_at_idx ON public.messages_p6 USING btree (channel_id, bd_account_id, created_at DESC);


--
-- Name: messages_p6_contact_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p6_contact_id_created_at_idx ON public.messages_p6 USING btree (contact_id, created_at DESC);


--
-- Name: messages_p6_organization_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p6_organization_id_created_at_idx ON public.messages_p6 USING btree (organization_id, created_at DESC);


--
-- Name: messages_p7_bd_account_id_channel_id_telegram_message_id_or_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX messages_p7_bd_account_id_channel_id_telegram_message_id_or_idx ON public.messages_p7 USING btree (bd_account_id, channel_id, telegram_message_id, organization_id) WHERE (telegram_message_id IS NOT NULL);


--
-- Name: messages_p7_bd_account_id_telegram_message_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p7_bd_account_id_telegram_message_id_idx ON public.messages_p7 USING btree (bd_account_id, telegram_message_id);


--
-- Name: messages_p7_channel_id_bd_account_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p7_channel_id_bd_account_id_created_at_idx ON public.messages_p7 USING btree (channel_id, bd_account_id, created_at DESC);


--
-- Name: messages_p7_contact_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p7_contact_id_created_at_idx ON public.messages_p7 USING btree (contact_id, created_at DESC);


--
-- Name: messages_p7_organization_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p7_organization_id_created_at_idx ON public.messages_p7 USING btree (organization_id, created_at DESC);


--
-- Name: messages_p8_bd_account_id_channel_id_telegram_message_id_or_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX messages_p8_bd_account_id_channel_id_telegram_message_id_or_idx ON public.messages_p8 USING btree (bd_account_id, channel_id, telegram_message_id, organization_id) WHERE (telegram_message_id IS NOT NULL);


--
-- Name: messages_p8_bd_account_id_telegram_message_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p8_bd_account_id_telegram_message_id_idx ON public.messages_p8 USING btree (bd_account_id, telegram_message_id);


--
-- Name: messages_p8_channel_id_bd_account_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p8_channel_id_bd_account_id_created_at_idx ON public.messages_p8 USING btree (channel_id, bd_account_id, created_at DESC);


--
-- Name: messages_p8_contact_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p8_contact_id_created_at_idx ON public.messages_p8 USING btree (contact_id, created_at DESC);


--
-- Name: messages_p8_organization_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p8_organization_id_created_at_idx ON public.messages_p8 USING btree (organization_id, created_at DESC);


--
-- Name: messages_p9_bd_account_id_channel_id_telegram_message_id_or_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX messages_p9_bd_account_id_channel_id_telegram_message_id_or_idx ON public.messages_p9 USING btree (bd_account_id, channel_id, telegram_message_id, organization_id) WHERE (telegram_message_id IS NOT NULL);


--
-- Name: messages_p9_bd_account_id_telegram_message_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p9_bd_account_id_telegram_message_id_idx ON public.messages_p9 USING btree (bd_account_id, telegram_message_id);


--
-- Name: messages_p9_channel_id_bd_account_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p9_channel_id_bd_account_id_created_at_idx ON public.messages_p9 USING btree (channel_id, bd_account_id, created_at DESC);


--
-- Name: messages_p9_contact_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p9_contact_id_created_at_idx ON public.messages_p9 USING btree (contact_id, created_at DESC);


--
-- Name: messages_p9_organization_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_p9_organization_id_created_at_idx ON public.messages_p9 USING btree (organization_id, created_at DESC);


--
-- Name: notes_organization_id_entity_type_entity_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notes_organization_id_entity_type_entity_id_index ON public.notes USING btree (organization_id, entity_type, entity_id);


--
-- Name: organization_activity_organization_id_created_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX organization_activity_organization_id_created_at_index ON public.organization_activity USING btree (organization_id, created_at);


--
-- Name: organization_client_assignments_client_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX organization_client_assignments_client_id_index ON public.organization_client_assignments USING btree (client_id);


--
-- Name: organization_client_assignments_organization_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX organization_client_assignments_organization_id_index ON public.organization_client_assignments USING btree (organization_id);


--
-- Name: organization_invite_links_organization_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX organization_invite_links_organization_id_index ON public.organization_invite_links USING btree (organization_id);


--
-- Name: organization_invite_links_token_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX organization_invite_links_token_index ON public.organization_invite_links USING btree (token);


--
-- Name: organization_members_organization_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX organization_members_organization_id_index ON public.organization_members USING btree (organization_id);


--
-- Name: organization_members_user_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX organization_members_user_id_index ON public.organization_members USING btree (user_id);


--
-- Name: organization_settings_organization_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX organization_settings_organization_id_index ON public.organization_settings USING btree (organization_id);


--
-- Name: pipelines_organization_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pipelines_organization_id_index ON public.pipelines USING btree (organization_id);


--
-- Name: recovery_codes_user_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_codes_user_id_index ON public.recovery_codes USING btree (user_id);


--
-- Name: refresh_tokens_family_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX refresh_tokens_family_id_index ON public.refresh_tokens USING btree (family_id);


--
-- Name: refresh_tokens_token_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX refresh_tokens_token_index ON public.refresh_tokens USING btree (token);


--
-- Name: reminders_organization_id_entity_type_entity_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reminders_organization_id_entity_type_entity_id_index ON public.reminders USING btree (organization_id, entity_type, entity_id);


--
-- Name: reminders_organization_id_remind_at_done_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reminders_organization_id_remind_at_done_index ON public.reminders USING btree (organization_id, remind_at, done);


--
-- Name: role_permissions_role_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX role_permissions_role_index ON public.role_permissions USING btree (role);


--
-- Name: stage_history_correlation_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stage_history_correlation_id_index ON public.stage_history USING btree (correlation_id);


--
-- Name: stage_history_entity_type_entity_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stage_history_entity_type_entity_id_index ON public.stage_history USING btree (entity_type, entity_id);


--
-- Name: stage_history_organization_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stage_history_organization_id_index ON public.stage_history USING btree (organization_id);


--
-- Name: stage_history_pipeline_id_created_at_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stage_history_pipeline_id_created_at_index ON public.stage_history USING btree (pipeline_id, created_at);


--
-- Name: stages_organization_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stages_organization_id_index ON public.stages USING btree (organization_id);


--
-- Name: stages_pipeline_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stages_pipeline_id_index ON public.stages USING btree (pipeline_id);


--
-- Name: subscriptions_organization_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subscriptions_organization_id_index ON public.subscriptions USING btree (organization_id);


--
-- Name: user_chat_pins_user_id_organization_id_bd_account_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_chat_pins_user_id_organization_id_bd_account_id_index ON public.user_chat_pins USING btree (user_id, organization_id, bd_account_id);


--
-- Name: user_profiles_user_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_profiles_user_id_index ON public.user_profiles USING btree (user_id);


--
-- Name: users_email_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_email_index ON public.users USING btree (email);


--
-- Name: users_organization_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_organization_id_index ON public.users USING btree (organization_id);


--
-- Name: messages_p0_bd_account_id_channel_id_telegram_message_id_or_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_telegram_unique ATTACH PARTITION public.messages_p0_bd_account_id_channel_id_telegram_message_id_or_idx;


--
-- Name: messages_p0_bd_account_id_telegram_message_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_telegram_msg ATTACH PARTITION public.messages_p0_bd_account_id_telegram_message_id_idx;


--
-- Name: messages_p0_channel_id_bd_account_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_channel ATTACH PARTITION public.messages_p0_channel_id_bd_account_id_created_at_idx;


--
-- Name: messages_p0_contact_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_contact ATTACH PARTITION public.messages_p0_contact_id_created_at_idx;


--
-- Name: messages_p0_organization_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_org_created ATTACH PARTITION public.messages_p0_organization_id_created_at_idx;


--
-- Name: messages_p0_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_pkey1 ATTACH PARTITION public.messages_p0_pkey;


--
-- Name: messages_p10_bd_account_id_channel_id_telegram_message_id_o_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_telegram_unique ATTACH PARTITION public.messages_p10_bd_account_id_channel_id_telegram_message_id_o_idx;


--
-- Name: messages_p10_bd_account_id_telegram_message_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_telegram_msg ATTACH PARTITION public.messages_p10_bd_account_id_telegram_message_id_idx;


--
-- Name: messages_p10_channel_id_bd_account_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_channel ATTACH PARTITION public.messages_p10_channel_id_bd_account_id_created_at_idx;


--
-- Name: messages_p10_contact_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_contact ATTACH PARTITION public.messages_p10_contact_id_created_at_idx;


--
-- Name: messages_p10_organization_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_org_created ATTACH PARTITION public.messages_p10_organization_id_created_at_idx;


--
-- Name: messages_p10_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_pkey1 ATTACH PARTITION public.messages_p10_pkey;


--
-- Name: messages_p11_bd_account_id_channel_id_telegram_message_id_o_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_telegram_unique ATTACH PARTITION public.messages_p11_bd_account_id_channel_id_telegram_message_id_o_idx;


--
-- Name: messages_p11_bd_account_id_telegram_message_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_telegram_msg ATTACH PARTITION public.messages_p11_bd_account_id_telegram_message_id_idx;


--
-- Name: messages_p11_channel_id_bd_account_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_channel ATTACH PARTITION public.messages_p11_channel_id_bd_account_id_created_at_idx;


--
-- Name: messages_p11_contact_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_contact ATTACH PARTITION public.messages_p11_contact_id_created_at_idx;


--
-- Name: messages_p11_organization_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_org_created ATTACH PARTITION public.messages_p11_organization_id_created_at_idx;


--
-- Name: messages_p11_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_pkey1 ATTACH PARTITION public.messages_p11_pkey;


--
-- Name: messages_p12_bd_account_id_channel_id_telegram_message_id_o_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_telegram_unique ATTACH PARTITION public.messages_p12_bd_account_id_channel_id_telegram_message_id_o_idx;


--
-- Name: messages_p12_bd_account_id_telegram_message_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_telegram_msg ATTACH PARTITION public.messages_p12_bd_account_id_telegram_message_id_idx;


--
-- Name: messages_p12_channel_id_bd_account_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_channel ATTACH PARTITION public.messages_p12_channel_id_bd_account_id_created_at_idx;


--
-- Name: messages_p12_contact_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_contact ATTACH PARTITION public.messages_p12_contact_id_created_at_idx;


--
-- Name: messages_p12_organization_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_org_created ATTACH PARTITION public.messages_p12_organization_id_created_at_idx;


--
-- Name: messages_p12_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_pkey1 ATTACH PARTITION public.messages_p12_pkey;


--
-- Name: messages_p13_bd_account_id_channel_id_telegram_message_id_o_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_telegram_unique ATTACH PARTITION public.messages_p13_bd_account_id_channel_id_telegram_message_id_o_idx;


--
-- Name: messages_p13_bd_account_id_telegram_message_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_telegram_msg ATTACH PARTITION public.messages_p13_bd_account_id_telegram_message_id_idx;


--
-- Name: messages_p13_channel_id_bd_account_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_channel ATTACH PARTITION public.messages_p13_channel_id_bd_account_id_created_at_idx;


--
-- Name: messages_p13_contact_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_contact ATTACH PARTITION public.messages_p13_contact_id_created_at_idx;


--
-- Name: messages_p13_organization_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_org_created ATTACH PARTITION public.messages_p13_organization_id_created_at_idx;


--
-- Name: messages_p13_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_pkey1 ATTACH PARTITION public.messages_p13_pkey;


--
-- Name: messages_p14_bd_account_id_channel_id_telegram_message_id_o_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_telegram_unique ATTACH PARTITION public.messages_p14_bd_account_id_channel_id_telegram_message_id_o_idx;


--
-- Name: messages_p14_bd_account_id_telegram_message_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_telegram_msg ATTACH PARTITION public.messages_p14_bd_account_id_telegram_message_id_idx;


--
-- Name: messages_p14_channel_id_bd_account_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_channel ATTACH PARTITION public.messages_p14_channel_id_bd_account_id_created_at_idx;


--
-- Name: messages_p14_contact_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_contact ATTACH PARTITION public.messages_p14_contact_id_created_at_idx;


--
-- Name: messages_p14_organization_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_org_created ATTACH PARTITION public.messages_p14_organization_id_created_at_idx;


--
-- Name: messages_p14_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_pkey1 ATTACH PARTITION public.messages_p14_pkey;


--
-- Name: messages_p15_bd_account_id_channel_id_telegram_message_id_o_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_telegram_unique ATTACH PARTITION public.messages_p15_bd_account_id_channel_id_telegram_message_id_o_idx;


--
-- Name: messages_p15_bd_account_id_telegram_message_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_telegram_msg ATTACH PARTITION public.messages_p15_bd_account_id_telegram_message_id_idx;


--
-- Name: messages_p15_channel_id_bd_account_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_channel ATTACH PARTITION public.messages_p15_channel_id_bd_account_id_created_at_idx;


--
-- Name: messages_p15_contact_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_contact ATTACH PARTITION public.messages_p15_contact_id_created_at_idx;


--
-- Name: messages_p15_organization_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_org_created ATTACH PARTITION public.messages_p15_organization_id_created_at_idx;


--
-- Name: messages_p15_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_pkey1 ATTACH PARTITION public.messages_p15_pkey;


--
-- Name: messages_p1_bd_account_id_channel_id_telegram_message_id_or_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_telegram_unique ATTACH PARTITION public.messages_p1_bd_account_id_channel_id_telegram_message_id_or_idx;


--
-- Name: messages_p1_bd_account_id_telegram_message_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_telegram_msg ATTACH PARTITION public.messages_p1_bd_account_id_telegram_message_id_idx;


--
-- Name: messages_p1_channel_id_bd_account_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_channel ATTACH PARTITION public.messages_p1_channel_id_bd_account_id_created_at_idx;


--
-- Name: messages_p1_contact_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_contact ATTACH PARTITION public.messages_p1_contact_id_created_at_idx;


--
-- Name: messages_p1_organization_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_org_created ATTACH PARTITION public.messages_p1_organization_id_created_at_idx;


--
-- Name: messages_p1_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_pkey1 ATTACH PARTITION public.messages_p1_pkey;


--
-- Name: messages_p2_bd_account_id_channel_id_telegram_message_id_or_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_telegram_unique ATTACH PARTITION public.messages_p2_bd_account_id_channel_id_telegram_message_id_or_idx;


--
-- Name: messages_p2_bd_account_id_telegram_message_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_telegram_msg ATTACH PARTITION public.messages_p2_bd_account_id_telegram_message_id_idx;


--
-- Name: messages_p2_channel_id_bd_account_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_channel ATTACH PARTITION public.messages_p2_channel_id_bd_account_id_created_at_idx;


--
-- Name: messages_p2_contact_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_contact ATTACH PARTITION public.messages_p2_contact_id_created_at_idx;


--
-- Name: messages_p2_organization_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_org_created ATTACH PARTITION public.messages_p2_organization_id_created_at_idx;


--
-- Name: messages_p2_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_pkey1 ATTACH PARTITION public.messages_p2_pkey;


--
-- Name: messages_p3_bd_account_id_channel_id_telegram_message_id_or_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_telegram_unique ATTACH PARTITION public.messages_p3_bd_account_id_channel_id_telegram_message_id_or_idx;


--
-- Name: messages_p3_bd_account_id_telegram_message_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_telegram_msg ATTACH PARTITION public.messages_p3_bd_account_id_telegram_message_id_idx;


--
-- Name: messages_p3_channel_id_bd_account_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_channel ATTACH PARTITION public.messages_p3_channel_id_bd_account_id_created_at_idx;


--
-- Name: messages_p3_contact_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_contact ATTACH PARTITION public.messages_p3_contact_id_created_at_idx;


--
-- Name: messages_p3_organization_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_org_created ATTACH PARTITION public.messages_p3_organization_id_created_at_idx;


--
-- Name: messages_p3_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_pkey1 ATTACH PARTITION public.messages_p3_pkey;


--
-- Name: messages_p4_bd_account_id_channel_id_telegram_message_id_or_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_telegram_unique ATTACH PARTITION public.messages_p4_bd_account_id_channel_id_telegram_message_id_or_idx;


--
-- Name: messages_p4_bd_account_id_telegram_message_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_telegram_msg ATTACH PARTITION public.messages_p4_bd_account_id_telegram_message_id_idx;


--
-- Name: messages_p4_channel_id_bd_account_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_channel ATTACH PARTITION public.messages_p4_channel_id_bd_account_id_created_at_idx;


--
-- Name: messages_p4_contact_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_contact ATTACH PARTITION public.messages_p4_contact_id_created_at_idx;


--
-- Name: messages_p4_organization_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_org_created ATTACH PARTITION public.messages_p4_organization_id_created_at_idx;


--
-- Name: messages_p4_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_pkey1 ATTACH PARTITION public.messages_p4_pkey;


--
-- Name: messages_p5_bd_account_id_channel_id_telegram_message_id_or_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_telegram_unique ATTACH PARTITION public.messages_p5_bd_account_id_channel_id_telegram_message_id_or_idx;


--
-- Name: messages_p5_bd_account_id_telegram_message_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_telegram_msg ATTACH PARTITION public.messages_p5_bd_account_id_telegram_message_id_idx;


--
-- Name: messages_p5_channel_id_bd_account_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_channel ATTACH PARTITION public.messages_p5_channel_id_bd_account_id_created_at_idx;


--
-- Name: messages_p5_contact_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_contact ATTACH PARTITION public.messages_p5_contact_id_created_at_idx;


--
-- Name: messages_p5_organization_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_org_created ATTACH PARTITION public.messages_p5_organization_id_created_at_idx;


--
-- Name: messages_p5_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_pkey1 ATTACH PARTITION public.messages_p5_pkey;


--
-- Name: messages_p6_bd_account_id_channel_id_telegram_message_id_or_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_telegram_unique ATTACH PARTITION public.messages_p6_bd_account_id_channel_id_telegram_message_id_or_idx;


--
-- Name: messages_p6_bd_account_id_telegram_message_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_telegram_msg ATTACH PARTITION public.messages_p6_bd_account_id_telegram_message_id_idx;


--
-- Name: messages_p6_channel_id_bd_account_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_channel ATTACH PARTITION public.messages_p6_channel_id_bd_account_id_created_at_idx;


--
-- Name: messages_p6_contact_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_contact ATTACH PARTITION public.messages_p6_contact_id_created_at_idx;


--
-- Name: messages_p6_organization_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_org_created ATTACH PARTITION public.messages_p6_organization_id_created_at_idx;


--
-- Name: messages_p6_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_pkey1 ATTACH PARTITION public.messages_p6_pkey;


--
-- Name: messages_p7_bd_account_id_channel_id_telegram_message_id_or_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_telegram_unique ATTACH PARTITION public.messages_p7_bd_account_id_channel_id_telegram_message_id_or_idx;


--
-- Name: messages_p7_bd_account_id_telegram_message_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_telegram_msg ATTACH PARTITION public.messages_p7_bd_account_id_telegram_message_id_idx;


--
-- Name: messages_p7_channel_id_bd_account_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_channel ATTACH PARTITION public.messages_p7_channel_id_bd_account_id_created_at_idx;


--
-- Name: messages_p7_contact_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_contact ATTACH PARTITION public.messages_p7_contact_id_created_at_idx;


--
-- Name: messages_p7_organization_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_org_created ATTACH PARTITION public.messages_p7_organization_id_created_at_idx;


--
-- Name: messages_p7_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_pkey1 ATTACH PARTITION public.messages_p7_pkey;


--
-- Name: messages_p8_bd_account_id_channel_id_telegram_message_id_or_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_telegram_unique ATTACH PARTITION public.messages_p8_bd_account_id_channel_id_telegram_message_id_or_idx;


--
-- Name: messages_p8_bd_account_id_telegram_message_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_telegram_msg ATTACH PARTITION public.messages_p8_bd_account_id_telegram_message_id_idx;


--
-- Name: messages_p8_channel_id_bd_account_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_channel ATTACH PARTITION public.messages_p8_channel_id_bd_account_id_created_at_idx;


--
-- Name: messages_p8_contact_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_contact ATTACH PARTITION public.messages_p8_contact_id_created_at_idx;


--
-- Name: messages_p8_organization_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_org_created ATTACH PARTITION public.messages_p8_organization_id_created_at_idx;


--
-- Name: messages_p8_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_pkey1 ATTACH PARTITION public.messages_p8_pkey;


--
-- Name: messages_p9_bd_account_id_channel_id_telegram_message_id_or_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_telegram_unique ATTACH PARTITION public.messages_p9_bd_account_id_channel_id_telegram_message_id_or_idx;


--
-- Name: messages_p9_bd_account_id_telegram_message_id_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_telegram_msg ATTACH PARTITION public.messages_p9_bd_account_id_telegram_message_id_idx;


--
-- Name: messages_p9_channel_id_bd_account_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_channel ATTACH PARTITION public.messages_p9_channel_id_bd_account_id_created_at_idx;


--
-- Name: messages_p9_contact_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_contact ATTACH PARTITION public.messages_p9_contact_id_created_at_idx;


--
-- Name: messages_p9_organization_id_created_at_idx; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.idx_messages_org_created ATTACH PARTITION public.messages_p9_organization_id_created_at_idx;


--
-- Name: messages_p9_pkey; Type: INDEX ATTACH; Schema: public; Owner: -
--

ALTER INDEX public.messages_pkey1 ATTACH PARTITION public.messages_p9_pkey;


--
-- Name: analytics_metrics analytics_metrics_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analytics_metrics
    ADD CONSTRAINT analytics_metrics_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: audit_logs audit_logs_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: audit_logs audit_logs_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: automation_executions automation_executions_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_executions
    ADD CONSTRAINT automation_executions_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: automation_executions automation_executions_rule_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_executions
    ADD CONSTRAINT automation_executions_rule_id_foreign FOREIGN KEY (rule_id) REFERENCES public.automation_rules(id) ON DELETE CASCADE;


--
-- Name: automation_rules automation_rules_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_rules
    ADD CONSTRAINT automation_rules_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: bd_account_status bd_account_status_account_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_account_status
    ADD CONSTRAINT bd_account_status_account_id_foreign FOREIGN KEY (account_id) REFERENCES public.bd_accounts(id) ON DELETE CASCADE;


--
-- Name: bd_account_sync_chat_folders bd_account_sync_chat_folders_bd_account_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_account_sync_chat_folders
    ADD CONSTRAINT bd_account_sync_chat_folders_bd_account_id_foreign FOREIGN KEY (bd_account_id) REFERENCES public.bd_accounts(id) ON DELETE CASCADE;


--
-- Name: bd_account_sync_chats bd_account_sync_chats_bd_account_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_account_sync_chats
    ADD CONSTRAINT bd_account_sync_chats_bd_account_id_foreign FOREIGN KEY (bd_account_id) REFERENCES public.bd_accounts(id) ON DELETE CASCADE;


--
-- Name: bd_account_sync_folders bd_account_sync_folders_bd_account_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_account_sync_folders
    ADD CONSTRAINT bd_account_sync_folders_bd_account_id_foreign FOREIGN KEY (bd_account_id) REFERENCES public.bd_accounts(id) ON DELETE CASCADE;


--
-- Name: bd_account_warmup bd_account_warmup_bd_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_account_warmup
    ADD CONSTRAINT bd_account_warmup_bd_account_id_fkey FOREIGN KEY (bd_account_id) REFERENCES public.bd_accounts(id) ON DELETE CASCADE;


--
-- Name: bd_account_warmup bd_account_warmup_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_account_warmup
    ADD CONSTRAINT bd_account_warmup_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: bd_accounts bd_accounts_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bd_accounts
    ADD CONSTRAINT bd_accounts_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: campaign_participants campaign_participants_bd_account_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_participants
    ADD CONSTRAINT campaign_participants_bd_account_id_foreign FOREIGN KEY (bd_account_id) REFERENCES public.bd_accounts(id) ON DELETE SET NULL;


--
-- Name: campaign_participants campaign_participants_campaign_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_participants
    ADD CONSTRAINT campaign_participants_campaign_id_foreign FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;


--
-- Name: campaign_participants campaign_participants_contact_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_participants
    ADD CONSTRAINT campaign_participants_contact_id_foreign FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: campaign_sends campaign_sends_campaign_participant_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_sends
    ADD CONSTRAINT campaign_sends_campaign_participant_id_foreign FOREIGN KEY (campaign_participant_id) REFERENCES public.campaign_participants(id) ON DELETE CASCADE;


--
-- Name: campaign_sequences campaign_sequences_campaign_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_sequences
    ADD CONSTRAINT campaign_sequences_campaign_id_foreign FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;


--
-- Name: campaign_sequences campaign_sequences_template_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_sequences
    ADD CONSTRAINT campaign_sequences_template_id_foreign FOREIGN KEY (template_id) REFERENCES public.campaign_templates(id) ON DELETE RESTRICT;


--
-- Name: campaign_templates campaign_templates_campaign_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_templates
    ADD CONSTRAINT campaign_templates_campaign_id_foreign FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE;


--
-- Name: campaign_templates campaign_templates_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaign_templates
    ADD CONSTRAINT campaign_templates_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: campaigns campaigns_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: campaigns campaigns_created_by_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_created_by_user_id_foreign FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: campaigns campaigns_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: campaigns campaigns_pipeline_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_pipeline_id_foreign FOREIGN KEY (pipeline_id) REFERENCES public.pipelines(id);


--
-- Name: companies companies_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: contact_telegram_sources contact_telegram_sources_bd_account_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_telegram_sources
    ADD CONSTRAINT contact_telegram_sources_bd_account_id_foreign FOREIGN KEY (bd_account_id) REFERENCES public.bd_accounts(id) ON DELETE CASCADE;


--
-- Name: contact_telegram_sources contact_telegram_sources_contact_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_telegram_sources
    ADD CONSTRAINT contact_telegram_sources_contact_id_foreign FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: contact_telegram_sources contact_telegram_sources_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contact_telegram_sources
    ADD CONSTRAINT contact_telegram_sources_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: contacts contacts_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: contacts contacts_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: conversation_ai_insights conversation_ai_insights_account_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_ai_insights
    ADD CONSTRAINT conversation_ai_insights_account_id_foreign FOREIGN KEY (account_id) REFERENCES public.bd_accounts(id) ON DELETE SET NULL;


--
-- Name: conversation_ai_insights conversation_ai_insights_conversation_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_ai_insights
    ADD CONSTRAINT conversation_ai_insights_conversation_id_foreign FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_bd_account_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_bd_account_id_foreign FOREIGN KEY (bd_account_id) REFERENCES public.bd_accounts(id) ON DELETE SET NULL;


--
-- Name: conversations conversations_campaign_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_campaign_id_foreign FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id) ON DELETE SET NULL;


--
-- Name: conversations conversations_contact_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_contact_id_foreign FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: conversations conversations_lead_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_lead_id_foreign FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON DELETE SET NULL;


--
-- Name: conversations conversations_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: conversion_rates conversion_rates_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversion_rates
    ADD CONSTRAINT conversion_rates_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: deals deals_bd_account_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_bd_account_id_foreign FOREIGN KEY (bd_account_id) REFERENCES public.bd_accounts(id) ON DELETE SET NULL;


--
-- Name: deals deals_company_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_company_id_foreign FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: deals deals_contact_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_contact_id_foreign FOREIGN KEY (contact_id) REFERENCES public.contacts(id);


--
-- Name: deals deals_created_by_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_created_by_id_foreign FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: deals deals_lead_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_lead_id_foreign FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON DELETE SET NULL;


--
-- Name: deals deals_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: deals deals_owner_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_owner_id_foreign FOREIGN KEY (owner_id) REFERENCES public.users(id);


--
-- Name: deals deals_pipeline_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_pipeline_id_foreign FOREIGN KEY (pipeline_id) REFERENCES public.pipelines(id);


--
-- Name: deals deals_stage_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_stage_id_foreign FOREIGN KEY (stage_id) REFERENCES public.stages(id);


--
-- Name: lead_activity_log lead_activity_log_lead_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_activity_log
    ADD CONSTRAINT lead_activity_log_lead_id_foreign FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON DELETE CASCADE;


--
-- Name: leads leads_contact_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_contact_id_foreign FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;


--
-- Name: leads leads_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: leads leads_pipeline_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_pipeline_id_foreign FOREIGN KEY (pipeline_id) REFERENCES public.pipelines(id) ON DELETE CASCADE;


--
-- Name: leads leads_responsible_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_responsible_id_foreign FOREIGN KEY (responsible_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: leads leads_stage_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_stage_id_foreign FOREIGN KEY (stage_id) REFERENCES public.stages(id) ON DELETE CASCADE;


--
-- Name: notes notes_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: notes notes_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: organization_activity organization_activity_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_activity
    ADD CONSTRAINT organization_activity_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: organization_activity organization_activity_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_activity
    ADD CONSTRAINT organization_activity_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: organization_client_assignments organization_client_assignments_assigned_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_client_assignments
    ADD CONSTRAINT organization_client_assignments_assigned_by_foreign FOREIGN KEY (assigned_by) REFERENCES public.users(id);


--
-- Name: organization_client_assignments organization_client_assignments_assigned_to_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_client_assignments
    ADD CONSTRAINT organization_client_assignments_assigned_to_foreign FOREIGN KEY (assigned_to) REFERENCES public.users(id);


--
-- Name: organization_client_assignments organization_client_assignments_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_client_assignments
    ADD CONSTRAINT organization_client_assignments_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: organization_invite_links organization_invite_links_created_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_invite_links
    ADD CONSTRAINT organization_invite_links_created_by_foreign FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: organization_invite_links organization_invite_links_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_invite_links
    ADD CONSTRAINT organization_invite_links_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: organization_members organization_members_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_members
    ADD CONSTRAINT organization_members_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: organization_members organization_members_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_members
    ADD CONSTRAINT organization_members_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: organization_settings organization_settings_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_settings
    ADD CONSTRAINT organization_settings_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: pipelines pipelines_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pipelines
    ADD CONSTRAINT pipelines_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: proxy_pool proxy_pool_assigned_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proxy_pool
    ADD CONSTRAINT proxy_pool_assigned_account_id_fkey FOREIGN KEY (assigned_account_id) REFERENCES public.bd_accounts(id) ON DELETE SET NULL;


--
-- Name: proxy_pool proxy_pool_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.proxy_pool
    ADD CONSTRAINT proxy_pool_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: recovery_codes recovery_codes_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recovery_codes
    ADD CONSTRAINT recovery_codes_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens refresh_tokens_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: reminders reminders_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminders
    ADD CONSTRAINT reminders_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: reminders reminders_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminders
    ADD CONSTRAINT reminders_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: stage_history stage_history_changed_by_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stage_history
    ADD CONSTRAINT stage_history_changed_by_foreign FOREIGN KEY (changed_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: stage_history stage_history_from_stage_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stage_history
    ADD CONSTRAINT stage_history_from_stage_id_foreign FOREIGN KEY (from_stage_id) REFERENCES public.stages(id) ON DELETE SET NULL;


--
-- Name: stage_history stage_history_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stage_history
    ADD CONSTRAINT stage_history_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: stage_history stage_history_pipeline_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stage_history
    ADD CONSTRAINT stage_history_pipeline_id_foreign FOREIGN KEY (pipeline_id) REFERENCES public.pipelines(id) ON DELETE CASCADE;


--
-- Name: stage_history stage_history_to_stage_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stage_history
    ADD CONSTRAINT stage_history_to_stage_id_foreign FOREIGN KEY (to_stage_id) REFERENCES public.stages(id) ON DELETE CASCADE;


--
-- Name: stages stages_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stages
    ADD CONSTRAINT stages_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: stages stages_pipeline_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stages
    ADD CONSTRAINT stages_pipeline_id_foreign FOREIGN KEY (pipeline_id) REFERENCES public.pipelines(id) ON DELETE CASCADE;


--
-- Name: subscriptions subscriptions_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: subscriptions subscriptions_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: user_chat_pins user_chat_pins_bd_account_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_chat_pins
    ADD CONSTRAINT user_chat_pins_bd_account_id_foreign FOREIGN KEY (bd_account_id) REFERENCES public.bd_accounts(id) ON DELETE CASCADE;


--
-- Name: user_chat_pins user_chat_pins_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_chat_pins
    ADD CONSTRAINT user_chat_pins_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: user_chat_pins user_chat_pins_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_chat_pins
    ADD CONSTRAINT user_chat_pins_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_profiles user_profiles_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT user_profiles_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: user_profiles user_profiles_user_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT user_profiles_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: users users_organization_id_foreign; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_organization_id_foreign FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: analytics_metrics; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.analytics_metrics ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: automation_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.automation_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: bd_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bd_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: analytics_metrics bypass_rls_analytics_metrics; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_analytics_metrics ON public.analytics_metrics USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: audit_logs bypass_rls_audit_logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_audit_logs ON public.audit_logs USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: automation_rules bypass_rls_automation_rules; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_automation_rules ON public.automation_rules USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: bd_accounts bypass_rls_bd_accounts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_bd_accounts ON public.bd_accounts USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: campaign_participants bypass_rls_campaign_participants; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_campaign_participants ON public.campaign_participants USING ((current_setting('app.bypass_rls'::text, true) = 'true'::text));


--
-- Name: campaign_sends bypass_rls_campaign_sends; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_campaign_sends ON public.campaign_sends USING ((current_setting('app.bypass_rls'::text, true) = 'true'::text));


--
-- Name: campaign_sequences bypass_rls_campaign_sequences; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_campaign_sequences ON public.campaign_sequences USING ((current_setting('app.bypass_rls'::text, true) = 'true'::text));


--
-- Name: campaign_templates bypass_rls_campaign_templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_campaign_templates ON public.campaign_templates USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: campaigns bypass_rls_campaigns; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_campaigns ON public.campaigns USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: companies bypass_rls_companies; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_companies ON public.companies USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: contact_discovery_tasks bypass_rls_contact_discovery_tasks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_contact_discovery_tasks ON public.contact_discovery_tasks USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: contact_telegram_sources bypass_rls_contact_telegram_sources; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_contact_telegram_sources ON public.contact_telegram_sources USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: contacts bypass_rls_contacts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_contacts ON public.contacts USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: conversations bypass_rls_conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_conversations ON public.conversations USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: conversion_rates bypass_rls_conversion_rates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_conversion_rates ON public.conversion_rates USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: deals bypass_rls_deals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_deals ON public.deals USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: leads bypass_rls_leads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_leads ON public.leads USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: notes bypass_rls_notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_notes ON public.notes USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: organization_activity bypass_rls_organization_activity; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_organization_activity ON public.organization_activity USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: organization_client_assignments bypass_rls_organization_client_assignments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_organization_client_assignments ON public.organization_client_assignments USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: organization_invite_links bypass_rls_organization_invite_links; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_organization_invite_links ON public.organization_invite_links USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: organization_members bypass_rls_organization_members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_organization_members ON public.organization_members USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: organization_settings bypass_rls_organization_settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_organization_settings ON public.organization_settings USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: pipelines bypass_rls_pipelines; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_pipelines ON public.pipelines USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: reminders bypass_rls_reminders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_reminders ON public.reminders USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: stage_history bypass_rls_stage_history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_stage_history ON public.stage_history USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: stages bypass_rls_stages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_stages ON public.stages USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: subscriptions bypass_rls_subscriptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_subscriptions ON public.subscriptions USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: user_profiles bypass_rls_user_profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_user_profiles ON public.user_profiles USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: users bypass_rls_users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bypass_rls_users ON public.users USING ((current_setting('app.current_org_id'::text, true) IS NULL));


--
-- Name: campaign_participants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.campaign_participants ENABLE ROW LEVEL SECURITY;

--
-- Name: campaign_sends; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.campaign_sends ENABLE ROW LEVEL SECURITY;

--
-- Name: campaign_sequences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.campaign_sequences ENABLE ROW LEVEL SECURITY;

--
-- Name: campaign_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.campaign_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: campaigns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;

--
-- Name: companies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

--
-- Name: contact_discovery_tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contact_discovery_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: contact_telegram_sources; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contact_telegram_sources ENABLE ROW LEVEL SECURITY;

--
-- Name: contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

--
-- Name: conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

--
-- Name: conversion_rates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversion_rates ENABLE ROW LEVEL SECURITY;

--
-- Name: deals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.deals ENABLE ROW LEVEL SECURITY;

--
-- Name: leads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

--
-- Name: notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_activity; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.organization_activity ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_client_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.organization_client_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_invite_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.organization_invite_links ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;

--
-- Name: organization_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.organization_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: pipelines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pipelines ENABLE ROW LEVEL SECURITY;

--
-- Name: reminders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;

--
-- Name: stage_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stage_history ENABLE ROW LEVEL SECURITY;

--
-- Name: stages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stages ENABLE ROW LEVEL SECURITY;

--
-- Name: subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: analytics_metrics tenant_isolation_analytics_metrics; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_analytics_metrics ON public.analytics_metrics USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: audit_logs tenant_isolation_audit_logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_audit_logs ON public.audit_logs USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: automation_rules tenant_isolation_automation_rules; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_automation_rules ON public.automation_rules USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: bd_accounts tenant_isolation_bd_accounts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_bd_accounts ON public.bd_accounts USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: campaign_participants tenant_isolation_campaign_participants; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_campaign_participants ON public.campaign_participants USING ((campaign_id IN ( SELECT campaigns.id
   FROM public.campaigns
  WHERE (campaigns.organization_id = (current_setting('app.current_organization_id'::text))::uuid))));


--
-- Name: campaign_sends tenant_isolation_campaign_sends; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_campaign_sends ON public.campaign_sends USING ((campaign_participant_id IN ( SELECT cp.id
   FROM (public.campaign_participants cp
     JOIN public.campaigns c ON ((c.id = cp.campaign_id)))
  WHERE (c.organization_id = (current_setting('app.current_organization_id'::text))::uuid))));


--
-- Name: campaign_sequences tenant_isolation_campaign_sequences; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_campaign_sequences ON public.campaign_sequences USING ((campaign_id IN ( SELECT campaigns.id
   FROM public.campaigns
  WHERE (campaigns.organization_id = (current_setting('app.current_organization_id'::text))::uuid))));


--
-- Name: campaign_templates tenant_isolation_campaign_templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_campaign_templates ON public.campaign_templates USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: campaigns tenant_isolation_campaigns; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_campaigns ON public.campaigns USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: companies tenant_isolation_companies; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_companies ON public.companies USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: contact_discovery_tasks tenant_isolation_contact_discovery_tasks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_contact_discovery_tasks ON public.contact_discovery_tasks USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: contact_telegram_sources tenant_isolation_contact_telegram_sources; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_contact_telegram_sources ON public.contact_telegram_sources USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: contacts tenant_isolation_contacts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_contacts ON public.contacts USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: conversations tenant_isolation_conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_conversations ON public.conversations USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: conversion_rates tenant_isolation_conversion_rates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_conversion_rates ON public.conversion_rates USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: deals tenant_isolation_deals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_deals ON public.deals USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: leads tenant_isolation_leads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_leads ON public.leads USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: notes tenant_isolation_notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_notes ON public.notes USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: organization_activity tenant_isolation_organization_activity; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_organization_activity ON public.organization_activity USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: organization_client_assignments tenant_isolation_organization_client_assignments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_organization_client_assignments ON public.organization_client_assignments USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: organization_invite_links tenant_isolation_organization_invite_links; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_organization_invite_links ON public.organization_invite_links USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: organization_members tenant_isolation_organization_members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_organization_members ON public.organization_members USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: organization_settings tenant_isolation_organization_settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_organization_settings ON public.organization_settings USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: pipelines tenant_isolation_pipelines; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_pipelines ON public.pipelines USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: reminders tenant_isolation_reminders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_reminders ON public.reminders USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: stage_history tenant_isolation_stage_history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_stage_history ON public.stage_history USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: stages tenant_isolation_stages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_stages ON public.stages USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: subscriptions tenant_isolation_subscriptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_subscriptions ON public.subscriptions USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: user_profiles tenant_isolation_user_profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_user_profiles ON public.user_profiles USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: users tenant_isolation_users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY tenant_isolation_users ON public.users USING ((organization_id = (current_setting('app.current_org_id'::text, true))::uuid));


--
-- Name: user_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

