-- 0004_line_exhausted_notice.sql — the admin's "LINE exhausted" notice, once per Bangkok day (§6):
-- exhausted can flip true→false→true within a month as LINE's own consumption figure lags, so the
-- month-flip check alone (markLineExhausted) is not enough to keep it to once a day.
ALTER TABLE line_usage ADD COLUMN exhausted_notice_day text;
