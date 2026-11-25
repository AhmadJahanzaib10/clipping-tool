CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`niche` text DEFAULT '' NOT NULL,
	`rate_per_1k` real,
	`allowed_platforms` text NOT NULL,
	`config` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaigns_slug_unique` ON `campaigns` (`slug`);--> statement-breakpoint
CREATE TABLE `clips` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`campaign_id` text,
	`operator_id` text,
	`rank` integer,
	`score` real,
	`scores` text,
	`start_sec` real NOT NULL,
	`end_sec` real NOT NULL,
	`hook_a` text,
	`hook_b` text,
	`hook_choice` text DEFAULT 'A' NOT NULL,
	`title` text,
	`caption_tiktok` text,
	`caption_instagram` text,
	`caption_youtube` text,
	`hashtags` text,
	`emphasis_words` text,
	`reason` text,
	`edit` text,
	`status` text DEFAULT 'candidate' NOT NULL,
	`base_version` integer DEFAULT 0 NOT NULL,
	`compose_version` integer DEFAULT 0 NOT NULL,
	`output_path` text,
	`base_path` text,
	`thumb_path` text,
	`views_72h` integer,
	`views_platform` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`operator_id`) REFERENCES `operators`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `clips_source_idx` ON `clips` (`source_id`);--> statement-breakpoint
CREATE INDEX `clips_status_idx` ON `clips` (`status`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text,
	`clip_id` text,
	`level` text NOT NULL,
	`message` text NOT NULL,
	`data` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`clip_id`) REFERENCES `clips`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_source_idx` ON `events` (`source_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `operators` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`drive_folder` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operators_slug_unique` ON `operators` (`slug`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sfx` (
	`id` text PRIMARY KEY NOT NULL,
	`category` text NOT NULL,
	`file` text NOT NULL,
	`name` text NOT NULL,
	`duration_sec` real,
	`peak_db` real,
	`lufs` real,
	`tags` text NOT NULL,
	`default_gain_db` real DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`cached_path` text,
	`waveform_path` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sfx_file_unique` ON `sfx` (`file`);--> statement-breakpoint
CREATE INDEX `sfx_category_idx` ON `sfx` (`category`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`operator_id` text,
	`campaign_id` text,
	`kind` text NOT NULL,
	`url` text,
	`title` text,
	`duration_sec` real,
	`width` integer,
	`height` integer,
	`status` text DEFAULT 'queued' NOT NULL,
	`transcript_provider` text,
	`transcript_quality` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`operator_id`) REFERENCES `operators`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sources_created_idx` ON `sources` (`created_at`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`source_id` text,
	`clip_id` text,
	`payload` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`worker_id` text,
	`lease_until` text,
	`run_after` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`clip_id`) REFERENCES `clips`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`,`priority`);--> statement-breakpoint
CREATE INDEX `tasks_source_idx` ON `tasks` (`source_id`);--> statement-breakpoint
CREATE INDEX `tasks_clip_idx` ON `tasks` (`clip_id`);--> statement-breakpoint
CREATE TABLE `usage` (
	`date` text PRIMARY KEY NOT NULL,
	`deepgram_seconds` real DEFAULT 0 NOT NULL,
	`llm_calls` integer DEFAULT 0 NOT NULL,
	`llm_tokens_in` integer DEFAULT 0 NOT NULL,
	`llm_tokens_out` integer DEFAULT 0 NOT NULL
);
