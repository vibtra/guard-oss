ALTER TABLE registry_receipts
  DROP CONSTRAINT registry_receipts_pkey,
  ADD PRIMARY KEY (org_id, receipt_id);

CREATE INDEX registry_receipts_receipt_id ON registry_receipts (receipt_id);
