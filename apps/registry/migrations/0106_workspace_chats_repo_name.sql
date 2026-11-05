ALTER TABLE workspace_chats DROP CONSTRAINT workspace_chats_repo_check;
ALTER TABLE workspace_chats ADD CONSTRAINT workspace_chats_repo_check
  CHECK (repo IS NULL OR repo ~ '^[a-z0-9][a-z0-9._-]{0,63}$');
