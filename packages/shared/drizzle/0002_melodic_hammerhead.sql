ALTER TABLE `clips` ADD `approved_at` text;--> statement-breakpoint
ALTER TABLE `clips` ADD `delivered_at` text;--> statement-breakpoint
ALTER TABLE `clips` ADD `delivery_path` text;--> statement-breakpoint
ALTER TABLE `clips` ADD `final_uploaded` integer DEFAULT false NOT NULL;