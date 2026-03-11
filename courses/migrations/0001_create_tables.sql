-- BayLeaf Courses schema: courses + memberships

CREATE TABLE courses (
  canvas_course_id  INTEGER PRIMARY KEY,
  name              TEXT NOT NULL,
  base_model        TEXT NOT NULL,
  prompt_text       TEXT DEFAULT '',
  canvas_page_url   TEXT,
  owui_model_id     TEXT,
  published         INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE memberships (
  canvas_course_id  INTEGER NOT NULL,
  email             TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('staff', 'user')),
  owui_user_id      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (canvas_course_id, email),
  FOREIGN KEY (canvas_course_id) REFERENCES courses(canvas_course_id)
);
