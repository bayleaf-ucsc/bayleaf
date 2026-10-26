-- Serves /v1/read/metric-buckets: one metric's rows in a window, not every metric's.
-- Physical access path only; no new columns, collection or retention.
CREATE INDEX metric_name_time ON metric_points(name, observed_at);
