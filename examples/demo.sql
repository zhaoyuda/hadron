-- Agent performance queries for Hadron workspace

CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    group_name TEXT DEFAULT 'Workers',
    state TEXT CHECK (state IN ('idle', 'working', 'done', 'blocked')),
    task TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT REFERENCES agents(id),
    event_type TEXT NOT NULL,
    details JSONB,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Find agents that have been blocked the longest
SELECT
    a.name,
    a.state,
    a.task,
    COUNT(e.id) AS block_count,
    MAX(e.timestamp) AS last_blocked
FROM agents a
LEFT JOIN agent_events e ON e.agent_id = a.id AND e.event_type = 'blocked'
GROUP BY a.id
HAVING a.state = 'blocked'
ORDER BY last_blocked ASC;

-- Agent activity summary per day
WITH daily AS (
    SELECT
        agent_id,
        DATE(timestamp) AS day,
        COUNT(*) FILTER (WHERE event_type = 'working') AS work_events,
        COUNT(*) FILTER (WHERE event_type = 'done') AS completions,
        COUNT(*) FILTER (WHERE event_type = 'blocked') AS blocks
    FROM agent_events
    WHERE timestamp >= CURRENT_DATE - INTERVAL '7 days'
    GROUP BY agent_id, DATE(timestamp)
)
SELECT
    a.name,
    d.day,
    d.work_events,
    d.completions,
    d.blocks
FROM daily d
JOIN agents a ON a.id = d.agent_id
ORDER BY d.day DESC, a.name;



ABC test
