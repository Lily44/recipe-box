CREATE TABLE IF NOT EXISTS recipes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  ingredients TEXT NOT NULL,   -- stored as JSON array string, e.g. '["1 cup oats","2 eggs"]'
  steps TEXT NOT NULL,         -- stored as JSON array string
  notes TEXT DEFAULT '',
  tags TEXT NOT NULL,          -- stored as JSON array string
  photo_key TEXT,              -- key referencing the photo in R2, or NULL if no photo
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recipes_created_at ON recipes(created_at DESC);
