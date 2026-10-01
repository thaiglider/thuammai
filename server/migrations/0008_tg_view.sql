-- "ดูจุดที่ติดตาม" (Plan O spec §5): the follow a queued question was asked for, so the answer can
-- carry its name. No FK: a follow deleted while the question waits simply reads as "no follow"
-- (answered like a plain location). Nullable: an older image keeps reading and writing the table.
ALTER TABLE tg_pending ADD COLUMN fid bigint NULL;
