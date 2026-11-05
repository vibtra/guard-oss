#!/usr/bin/env python3
"""Convert the australian-insurance-pii-dataset parquet splits to the JSONL that `vibtra-guard engine eval` reads."""
import hashlib, json, sys
from pathlib import Path

import pyarrow.parquet as pq

SPLITS = ["train", "validation", "test"]
FIELDS = ["id", "original_text", "redacted_text", "annotations"]


def main(dataset: Path) -> None:
    out = dataset / "jsonl"
    out.mkdir(exist_ok=True)
    manifest = {"source": "https://huggingface.co/datasets/soates/australian-insurance-pii-dataset", "parquet": {}, "rows": {}}
    for split in SPLITS:
        src = dataset / "data" / f"{split}-00000-of-00001.parquet"
        manifest["parquet"][src.name] = hashlib.sha256(src.read_bytes()).hexdigest()
        rows = pq.read_table(src, columns=FIELDS).to_pylist()
        with open(out / f"{split}.jsonl", "w", encoding="utf-8") as f:
            for row in rows:
                f.write(json.dumps({"split": split, **{k: row[k] for k in FIELDS}}, ensure_ascii=False) + "\n")
        manifest["rows"][split] = len(rows)
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest["rows"]))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: eval-pii-parquet-to-jsonl.py <dataset dir holding data/*.parquet>")
    main(Path(sys.argv[1]))
