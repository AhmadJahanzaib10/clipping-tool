ALTER TABLE `sfx` ADD `hash` text;--> statement-breakpoint
ALTER TABLE `sfx` ADD `mtime_ms` real;--> statement-breakpoint
ALTER TABLE `sfx` ADD `size_bytes` integer;--> statement-breakpoint
ALTER TABLE `sfx` ADD `missing` integer DEFAULT false NOT NULL;