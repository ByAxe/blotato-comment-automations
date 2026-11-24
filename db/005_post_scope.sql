-- Existing versions continue to match any post. Opaque platform IDs use exact comparison.
ALTER TABLE automation_versions ADD COLUMN post_id text COLLATE "C"
    CHECK (char_length(post_id) BETWEEN 1 AND 255);

ALTER TABLE inbox ADD COLUMN post_id text COLLATE "C"
    CHECK (post_id IS NULL OR (kind = 'comment' AND char_length(post_id) BETWEEN 1 AND 255));
