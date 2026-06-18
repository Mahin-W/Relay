--
-- PostgreSQL database dump
--

\restrict U7pEubMAFwUTKbJCJEeh2ccZBbvcfpYQdFMzBjpa0Wgi3KnRhEZo50LuWjAxCJq

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: login_otps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.login_otps (
    manager_id text NOT NULL,
    group_id text NOT NULL,
    group_name text,
    restaurant_name text,
    dm_chat_id bigint,
    code text NOT NULL,
    attempts integer DEFAULT 0,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: platform_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_contacts (
    id bigint NOT NULL,
    staff_id bigint,
    platform text NOT NULL,
    platform_user_id text NOT NULL,
    platform_chat_id text,
    display_name text
);


--
-- Name: platform_contacts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.platform_contacts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: platform_contacts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.platform_contacts_id_seq OWNED BY public.platform_contacts.id;


--
-- Name: schedule_quality_scores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedule_quality_scores (
    id bigint NOT NULL,
    group_id text NOT NULL,
    week_start date NOT NULL,
    score integer,
    grade text,
    draft_edits integer DEFAULT 0,
    coverage_requests integer DEFAULT 0,
    no_shows integer DEFAULT 0,
    avg_fill_minutes integer,
    CONSTRAINT schedule_quality_scores_score_check CHECK (((score >= 0) AND (score <= 100)))
);


--
-- Name: schedule_quality_scores_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.schedule_quality_scores_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: schedule_quality_scores_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.schedule_quality_scores_id_seq OWNED BY public.schedule_quality_scores.id;


--
-- Name: platform_contacts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_contacts ALTER COLUMN id SET DEFAULT nextval('public.platform_contacts_id_seq'::regclass);


--
-- Name: schedule_quality_scores id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_quality_scores ALTER COLUMN id SET DEFAULT nextval('public.schedule_quality_scores_id_seq'::regclass);


--
-- Name: login_otps login_otps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.login_otps
    ADD CONSTRAINT login_otps_pkey PRIMARY KEY (manager_id);


--
-- Name: platform_contacts platform_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_contacts
    ADD CONSTRAINT platform_contacts_pkey PRIMARY KEY (id);


--
-- Name: platform_contacts platform_contacts_platform_platform_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_contacts
    ADD CONSTRAINT platform_contacts_platform_platform_user_id_key UNIQUE (platform, platform_user_id);


--
-- Name: schedule_quality_scores schedule_quality_scores_group_id_week_start_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_quality_scores
    ADD CONSTRAINT schedule_quality_scores_group_id_week_start_key UNIQUE (group_id, week_start);


--
-- Name: schedule_quality_scores schedule_quality_scores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_quality_scores
    ADD CONSTRAINT schedule_quality_scores_pkey PRIMARY KEY (id);


--
-- Name: idx_platform_contacts_staff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_contacts_staff ON public.platform_contacts USING btree (staff_id);


--
-- Name: platform_contacts platform_contacts_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_contacts
    ADD CONSTRAINT platform_contacts_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id);


--
-- Name: platform_contacts Allow all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all" ON public.platform_contacts USING (true);


--
-- Name: login_otps Allow all for anon on login_otps; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all for anon on login_otps" ON public.login_otps TO anon USING (true) WITH CHECK (true);


--
-- Name: login_otps; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.login_otps ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.platform_contacts ENABLE ROW LEVEL SECURITY;

--
-- Name: schedule_quality_scores; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.schedule_quality_scores ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict U7pEubMAFwUTKbJCJEeh2ccZBbvcfpYQdFMzBjpa0Wgi3KnRhEZo50LuWjAxCJq

